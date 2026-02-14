import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveStorePath,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import {
  advanceForNextHeartbeat,
  createModelFallbackState,
  getCurrentModel,
  getFallbackStateSummary,
  parseHeartbeatModelConfig,
  recordFailure,
  recordSuccess,
  type HeartbeatModelState,
} from "./heartbeat-model-fallback.js";
import {
  buildCronEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { peekSystemEvents } from "./system-events.js";

type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    nowMs?: () => number;
  };

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  ackMaxChars: number;
};

const DEFAULT_HEARTBEAT_TARGET = "last";

// Prompt used when an async exec has completed and the result should be relayed to the user.
// This overrides the standard heartbeat prompt to ensure the model responds with the exec result
// instead of just "HEARTBEAT_OK".
const EXEC_EVENT_PROMPT =
  "An async command you ran earlier has completed. The result is shown in the system messages above. " +
  "Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
  "If it failed, explain what went wrong.";
export { isCronSystemEvent };

type HeartbeatAgentState = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  intervalMs: number;
  lastRunMs?: number;
  nextDueMs: number;
  /** Model fallback state for tracking primary + fallback chain */
  modelFallbackState?: HeartbeatModelState;
};

export type HeartbeatRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => Boolean(entry?.heartbeat));
}

export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const list = cfg.agents?.list ?? [];
  const hasExplicit = hasExplicitHeartbeatAgents(cfg);
  if (hasExplicit) {
    return list.some(
      (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === resolvedAgentId,
    );
  }
  return resolvedAgentId === resolveDefaultAgentId(cfg);
}

function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : undefined;
  const enabled = isHeartbeatEnabledForAgent(cfg, agentId);

  if (!enabled) {
    return {
      enabled: false,
      every: "disabled",
      everyMs: null,
      prompt: resolveHeartbeatPromptText(defaults?.prompt),
      target: defaults?.target ?? DEFAULT_HEARTBEAT_TARGET,
      model: defaults?.model,
      ackMaxChars: Math.max(0, defaults?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS),
    };
  }

  const merged = defaults || overrides ? { ...defaults, ...overrides } : undefined;
  const every = merged?.every ?? defaults?.every ?? overrides?.every ?? DEFAULT_HEARTBEAT_EVERY;
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const prompt = resolveHeartbeatPromptText(
    merged?.prompt ?? defaults?.prompt ?? overrides?.prompt,
  );
  const target =
    merged?.target ?? defaults?.target ?? overrides?.target ?? DEFAULT_HEARTBEAT_TARGET;
  const model =
    merged?.primary ??
    merged?.model ??
    defaults?.primary ??
    defaults?.model ??
    overrides?.primary ??
    overrides?.model;
  const ackMaxChars = Math.max(
    0,
    merged?.ackMaxChars ??
      defaults?.ackMaxChars ??
      overrides?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  return {
    enabled: true,
    every,
    everyMs,
    prompt,
    target,
    model,
    ackMaxChars,
  };
}

function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const list = cfg.agents?.list ?? [];
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  const fallbackId = resolveDefaultAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const raw =
    overrideEvery ??
    heartbeat?.every ??
    cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  if (!raw) {
    return null;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return null;
  }
  let ms: number;
  try {
    ms = parseDurationMs(trimmed, { defaultUnit: "m" });
  } catch {
    return null;
  }
  if (ms <= 0) {
    return null;
  }
  return ms;
}

export function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return Math.max(
    0,
    heartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const store = loadSessionStore(storePath);
  const mainEntry = store[mainSessionKey];

  if (scope === "global") {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed) {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "main" || normalized === "global") {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global") {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        store,
        entry: store[canonical],
      };
    }
  }

  return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
}

function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      return payload;
    }
  }
  return undefined;
}

function resolveHeartbeatReasoningPayloads(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload[] {
  const payloads = Array.isArray(replyResult) ? replyResult : replyResult ? [replyResult] : [];
  return payloads.filter((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text.trimStart().startsWith("Reasoning:");
  });
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) {
      return;
    }
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) {
      return;
    }
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
) {
  const stripped = stripHeartbeatToken(payload.text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  if (stripped.shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

export async function runHeartbeatOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  heartbeat?: HeartbeatConfig;
  reason?: string;
  deps?: HeartbeatDeps;
  modelFallbackState?: HeartbeatModelState;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
  if (!heartbeatsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!isHeartbeatEnabledForAgent(cfg, agentId)) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)) {
    return { status: "skipped", reason: "disabled" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  if (!isWithinActiveHours(cfg, heartbeat, startedAt)) {
    return { status: "skipped", reason: "quiet-hours" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  // Skip heartbeat if HEARTBEAT.md exists but has no actionable content.
  // This saves API calls/costs when the file is effectively empty (only comments/headers).
  // EXCEPTION: Don't skip for exec events, cron events, or explicit wake requests -
  // they have pending system events to process regardless of HEARTBEAT.md content.
  const isExecEventReason = opts.reason === "exec-event";
  const isCronEventReason = Boolean(opts.reason?.startsWith("cron:"));
  const isWakeReason = opts.reason === "wake" || Boolean(opts.reason?.startsWith("hook:"));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  try {
    const heartbeatFileContent = await fs.readFile(heartbeatFilePath, "utf-8");
    if (
      isHeartbeatContentEffectivelyEmpty(heartbeatFileContent) &&
      !isExecEventReason &&
      !isCronEventReason &&
      !isWakeReason
    ) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: "empty-heartbeat-file",
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: "empty-heartbeat-file" };
    }
  } catch {
    // File doesn't exist or can't be read - proceed with heartbeat.
    // The LLM prompt says "if it exists" so this is expected behavior.
  }

  const { entry, sessionKey, storePath } = resolveHeartbeatSession(cfg, agentId, heartbeat);
  const previousUpdatedAt = entry?.updatedAt;
  const delivery = resolveHeartbeatDeliveryTarget({ cfg, entry, heartbeat });
  const heartbeatAccountId = heartbeat?.accountId?.trim();
  if (delivery.reason === "unknown-account") {
    log.warn("heartbeat: unknown accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId ?? null,
      target: heartbeat?.target ?? "last",
    });
  } else if (heartbeatAccountId) {
    log.info("heartbeat: using explicit accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId,
      target: heartbeat?.target ?? "last",
      channel: delivery.channel,
    });
  }
  const visibility =
    delivery.channel !== "none"
      ? resolveHeartbeatVisibility({
          cfg,
          channel: delivery.channel,
          accountId: delivery.accountId,
        })
      : { showOk: false, showAlerts: true, useIndicator: true };
  const { sender } = resolveHeartbeatSenderContext({ cfg, entry, delivery });
  const responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {
    channel: delivery.channel !== "none" ? delivery.channel : undefined,
    accountId: delivery.accountId,
  }).responsePrefix;

  // Check if this is an exec event or cron event with pending system events.
  // If so, use a specialized prompt that instructs the model to relay the result
  // instead of the standard heartbeat prompt with "reply HEARTBEAT_OK".
  const isExecEvent = opts.reason === "exec-event";
  const isCronEvent = Boolean(opts.reason?.startsWith("cron:"));
  const pendingEvents = isExecEvent || isCronEvent ? peekSystemEvents(sessionKey) : [];
  const cronEvents = pendingEvents.filter((evt) => isCronSystemEvent(evt));
  const hasExecCompletion = pendingEvents.some(isExecCompletionEvent);
  const hasCronEvents = isCronEvent && cronEvents.length > 0;
  const prompt = hasExecCompletion
    ? EXEC_EVENT_PROMPT
    : hasCronEvents
      ? buildCronEventPrompt(cronEvents)
      : resolveHeartbeatPrompt(cfg, heartbeat);
  const ctx = {
    Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
    From: sender,
    To: sender,
    Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
    SessionKey: sessionKey,
  };
  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }

  const heartbeatOkText = responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
  const canAttemptHeartbeatOk = Boolean(
    visibility.showOk && delivery.channel !== "none" && delivery.to,
  );
  const maybeSendHeartbeatOk = async () => {
    if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) {
      return false;
    }
    const heartbeatPlugin = getChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        cfg,
        accountId: delivery.accountId,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        return false;
      }
    }
    await deliverOutboundPayloads({
      cfg,
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      payloads: [{ text: heartbeatOkText }],
      deps: opts.deps,
    });
    return true;
  };

  // Initialize or use provided model fallback state
  const modelConfig = parseHeartbeatModelConfig(heartbeat);
  let fallbackState = opts.modelFallbackState ?? createModelFallbackState(modelConfig);
  
  // If no model config, fall back to legacy behavior
  const hasModelConfig = modelConfig !== undefined;
  
  // Helper function to run heartbeat with a specific model
  async function runWithModel(modelOverride: string | undefined): Promise<{
    result: Awaited<ReturnType<typeof getReplyFromConfig>>;
    error?: string;
  }> {
    try {
      const replyOpts = modelOverride
        ? { isHeartbeat: true, heartbeatModelOverride: modelOverride }
        : { isHeartbeat: true };
      const result = await getReplyFromConfig(ctx, replyOpts, cfg);
      return { result };
    } catch (err) {
      const errorMsg = formatErrorMessage(err);
      log.warn(`Heartbeat model call failed: ${errorMsg}`, { model: modelOverride });
      return { result: undefined, error: errorMsg };
    }
  }

  // Helper to process reply result
  async function processReplyResult(
    replyResult: Awaited<ReturnType<typeof getReplyFromConfig>>,
  ): Promise<HeartbeatRunResult | null> {
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);
    const includeReasoning = heartbeat?.includeReasoning === true;
    const reasoningPayloads = includeReasoning
      ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload)
      : [];

    if (
      !replyPayload ||
      (!replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length)
    ) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-empty",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
      });
      return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
    }

    const ackMaxChars = resolveHeartbeatAckMaxChars(cfg, heartbeat);
    const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, ackMaxChars);
    const execFallbackText =
      hasExecCompletion && !normalized.text.trim() && replyPayload.text?.trim()
        ? replyPayload.text.trim()
        : null;
    if (execFallbackText) {
      normalized.text = execFallbackText;
      normalized.shouldSkip = false;
    }
    const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia && !hasExecCompletion;
    if (shouldSkipMain && reasoningPayloads.length === 0) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-token",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : undefined,
      });
      return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
    }

    const mediaUrls =
      replyPayload.mediaUrls ?? (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);

    // Suppress duplicate heartbeats
    const prevHeartbeatText =
      typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
    const prevHeartbeatAt =
      typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
    const isDuplicateMain =
      !shouldSkipMain &&
      !mediaUrls.length &&
      Boolean(prevHeartbeatText.trim()) &&
      normalized.text.trim() === prevHeartbeatText.trim() &&
      typeof prevHeartbeatAt === "number" &&
      startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000;

    if (isDuplicateMain) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "skipped",
        reason: "duplicate",
        preview: normalized.text.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: false,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
      });
      return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
    }

    // Reasoning payloads are text-only
    const previewText = shouldSkipMain
      ? reasoningPayloads
          .map((payload) => payload.text)
          .filter((text): text is string => Boolean(text?.trim()))
          .join("\n")
      : normalized.text;

    if (delivery.channel === "none" || !delivery.to) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: delivery.reason ?? "no-target",
        preview: previewText?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        accountId: delivery.accountId,
      });
      return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
    }

    if (!visibility.showAlerts) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "skipped",
        reason: "alerts-disabled",
        preview: previewText?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        accountId: delivery.accountId,
      });
      return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
    }

    // Deliver the heartbeat
    const payloads: ReplyPayload[] = [];
    if (!shouldSkipMain) {
      payloads.push({
        text: normalized.text,
        mediaUrl: replyPayload.mediaUrl,
        mediaUrls: replyPayload.mediaUrls,
      });
    }
    if (includeReasoning) {
      for (const reasoning of reasoningPayloads) {
        if (reasoning.text?.trim()) {
          payloads.push(reasoning);
        }
      }
    }

    if (payloads.length > 0) {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        payloads,
        deps: opts.deps,
      });

      // Update session with last heartbeat info
      const mainPayload = payloads[0];
      if (mainPayload?.text && entry) {
        entry.lastHeartbeatText = mainPayload.text;
        entry.lastHeartbeatSentAt = Date.now();
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = entry;
        });
      }
    }

    emitHeartbeatEvent({
      status: "ok-alert",
      reason: opts.reason,
      preview: previewText?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-alert") : undefined,
    });

    return { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
  }

  // Main execution logic with fallback support
  try {
    // If using fallback state, try models in order
    if (fallbackState) {
      while (true) {
        const currentModel = getCurrentModel(fallbackState);
        if (!currentModel) {
          // Exhausted all models
          log.error("Heartbeat failed: all models exhausted", {
            agentId,
            attempts: fallbackState.attempts.length,
          });
          return {
            status: "failed",
            reason: "all-models-failed",
            modelFallbackState: fallbackState,
          };
        }

        log.info(`Attempting heartbeat with model: ${currentModel}`, {
          agentId,
          modelIndex: fallbackState.currentIndex,
        });

        const { result, error } = await runWithModel(currentModel);

        if (error) {
          // Model call failed
          const failureResult = recordFailure(fallbackState, currentModel, error);
          
          if (!failureResult.shouldRetry) {
            // No immediate retry - either exhausted or next_heartbeat mode
            if (fallbackState.fallbackMode === "next_heartbeat") {
              // Return failure but keep state for next heartbeat
              return {
                status: "failed",
                reason: `model-failed: ${error}`,
                modelFallbackState: fallbackState,
              };
            }
            // Exhausted all models in immediate mode
            return {
              status: "failed",
              reason: "all-models-failed",
              modelFallbackState: fallbackState,
            };
          }
          // Continue to next model in immediate mode
          continue;
        }

        // Success - record it and process result
        recordSuccess(fallbackState, currentModel);
        const processResult = await processReplyResult(result);
        return processResult ?? { status: "ran", durationMs: Date.now() - startedAt, modelFallbackState: fallbackState };
      }
    } else {
      // Legacy behavior - single model or no model override
      const legacyModel = heartbeat?.model?.trim();
      const { result, error } = await runWithModel(legacyModel || undefined);
      
      if (error) {
        return {
          status: "failed",
          reason: `model-failed: ${error}`,
        };
      }
      
      const processResult = await processReplyResult(result);
      return processResult ?? { status: "ran", durationMs: Date.now() - startedAt };
    }
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.error(`Heartbeat execution failed: ${errMsg}`, { agentId });
    return {
      status: "failed",
      reason: `execution-failed: ${errMsg}`,
      modelFallbackState: fallbackState,
    };
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  runOnce?: typeof runHeartbeatOnce;
}): HeartbeatRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runHeartbeatOnce;
  const state = {
    cfg: opts.cfg ?? loadConfig(),
    runtime,
    agents: new Map<string, HeartbeatAgentState>(),
    timer: null as NodeJS.Timeout | null,
    stopped: false,
  };
  let initialized = false;

  const resolveNextDue = (now: number, intervalMs: number, prevState?: HeartbeatAgentState) => {
    if (typeof prevState?.lastRunMs === "number") {
      return prevState.lastRunMs + intervalMs;
    }
    if (prevState && prevState.intervalMs === intervalMs && prevState.nextDueMs > now) {
      return prevState.nextDueMs;
    }
    return now + intervalMs;
  };

  const advanceAgentSchedule = (agent: HeartbeatAgentState, now: number) => {
    agent.lastRunMs = now;
    agent.nextDueMs = now + agent.intervalMs;
  };

  const scheduleNext = () => {
    if (state.stopped) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.agents.size === 0) {
      return;
    }
    const now = Date.now();
    let nextDue = Number.POSITIVE_INFINITY;
    for (const agent of state.agents.values()) {
      if (agent.nextDueMs < nextDue) {
        nextDue = agent.nextDueMs;
      }
    }
    if (!Number.isFinite(nextDue)) {
      return;
    }
    const delay = Math.max(0, nextDue - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, delay);
    state.timer.unref?.();
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    const prevAgents = state.agents;
    const prevEnabled = prevAgents.size > 0;
    const nextAgents = new Map<string, HeartbeatAgentState>();
    const intervals: number[] = [];
    for (const agent of resolveHeartbeatAgents(cfg)) {
      const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
      if (!intervalMs) {
        continue;
      }
      intervals.push(intervalMs);
      const prevState = prevAgents.get(agent.agentId);
      const nextDueMs = resolveNextDue(now, intervalMs, prevState);
      
      // Initialize or preserve model fallback state
      const modelConfig = parseHeartbeatModelConfig(agent.heartbeat);
      const modelFallbackState = prevState?.modelFallbackState ?? createModelFallbackState(modelConfig);
      
      nextAgents.set(agent.agentId, {
        agentId: agent.agentId,
        heartbeat: agent.heartbeat,
        intervalMs,
        lastRunMs: prevState?.lastRunMs,
        nextDueMs,
        modelFallbackState,
      });
    }

    state.cfg = cfg;
    state.agents = nextAgents;
    const nextEnabled = nextAgents.size > 0;
    if (!initialized) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
      initialized = true;
    } else if (prevEnabled !== nextEnabled) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
    }

    scheduleNext();
  };

  const run: HeartbeatWakeHandler = async (params) => {
    if (state.stopped) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }
    if (!heartbeatsEnabled) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }
    if (state.agents.size === 0) {
      return {
        status: "skipped",
        reason: "disabled",
      } satisfies HeartbeatRunResult;
    }

    const reason = params?.reason;
    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;
    let ran = false;

    for (const agent of state.agents.values()) {
      if (isInterval && now < agent.nextDueMs) {
        continue;
      }

      let res: HeartbeatRunResult;
      try {
        // For next_heartbeat mode, advance to next model if previous failed
        if (agent.modelFallbackState && agent.heartbeat?.fallbackMode === "next_heartbeat") {
          advanceForNextHeartbeat(agent.modelFallbackState);
        }
        
        res = await runOnce({
          cfg: state.cfg,
          agentId: agent.agentId,
          heartbeat: agent.heartbeat,
          reason,
          deps: { runtime: state.runtime },
          modelFallbackState: agent.modelFallbackState,
        });
        
        // Update the model fallback state after the run
        if (res.modelFallbackState) {
          agent.modelFallbackState = res.modelFallbackState;
        }
      } catch (err) {
        // If runOnce throws (e.g. during session compaction), we must still
        // advance the timer and call scheduleNext so heartbeats keep firing.
        const errMsg = formatErrorMessage(err);
        log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
        advanceAgentSchedule(agent, now);
        continue;
      }
      if (res.status === "skipped" && res.reason === "requests-in-flight") {
        advanceAgentSchedule(agent, now);
        scheduleNext();
        return res;
      }
      if (res.status !== "skipped" || res.reason !== "disabled") {
        advanceAgentSchedule(agent, now);
      }
      if (res.status === "ran") {
        ran = true;
      }
    }

    scheduleNext();
    if (ran) {
      return { status: "ran", durationMs: Date.now() - startedAt };
    }
    return { status: "skipped", reason: isInterval ? "not-due" : "disabled" };
  };

  const wakeHandler: HeartbeatWakeHandler = async (params) => run({ reason: params.reason });
  const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
  updateConfig(state.cfg);

  const cleanup = () => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    disposeWakeHandler();
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup, updateConfig };
}
