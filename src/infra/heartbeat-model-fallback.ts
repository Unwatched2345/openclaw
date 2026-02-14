/**
 * Heartbeat Model Fallback Logic
 *
 * Manages primary model + fallback chain for heartbeat runs.
 * Tracks which model succeeded to avoid retrying dead models.
 */

import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/heartbeat-model-fallback");

export type HeartbeatModelConfig =
  | string // Simple model string (backward compatible)
  | {
      primary?: string;
      fallbacks?: string[];
      fallbackMode?: "immediate" | "next_heartbeat";
    };

export type ModelAttempt = {
  model: string;
  attemptedAt: number;
  success: boolean;
  error?: string;
};

export type HeartbeatModelState = {
  /** Currently active model index in the chain */
  currentIndex: number;
  /** Ordered list of models to try (primary + fallbacks) */
  modelChain: string[];
  /** Mode for handling failures */
  fallbackMode: "immediate" | "next_heartbeat";
  /** History of attempts for debugging */
  attempts: ModelAttempt[];
  /** Last successful model index */
  lastSuccessfulIndex: number | null;
  /** Timestamp of last successful attempt */
  lastSuccessAt: number | null;
};

const DEFAULT_FALLBACK_MODE: "immediate" | "next_heartbeat" = "immediate";

/**
 * Parse heartbeat model configuration into a normalized format.
 * Supports backward-compatible string format and new object format.
 */
export function parseHeartbeatModelConfig(
  heartbeat: AgentDefaultsConfig["heartbeat"],
): HeartbeatModelConfig | undefined {
  if (!heartbeat) {
    return undefined;
  }

  // New format: primary + fallbacks
  if (heartbeat.primary || (heartbeat.fallbacks && heartbeat.fallbacks.length > 0)) {
    return {
      primary: heartbeat.primary,
      fallbacks: heartbeat.fallbacks ?? [],
      fallbackMode: heartbeat.fallbackMode ?? DEFAULT_FALLBACK_MODE,
    };
  }

  // Legacy format: single model string
  if (heartbeat.model) {
    return heartbeat.model;
  }

  return undefined;
}

/**
 * Build the model chain from config.
 * Returns array of models in order: [primary, fallback1, fallback2, ...]
 */
export function buildModelChain(config: HeartbeatModelConfig): string[] {
  if (typeof config === "string") {
    return config.trim() ? [config.trim()] : [];
  }

  const chain: string[] = [];
  if (config.primary?.trim()) {
    chain.push(config.primary.trim());
  }
  if (config.fallbacks) {
    for (const fb of config.fallbacks) {
      if (fb?.trim() && !chain.includes(fb.trim())) {
        chain.push(fb.trim());
      }
    }
  }
  return chain;
}

/**
 * Get fallback mode from config.
 */
export function resolveFallbackMode(
  config: HeartbeatModelConfig | undefined,
): "immediate" | "next_heartbeat" {
  if (typeof config === "object" && config?.fallbackMode) {
    return config.fallbackMode;
  }
  return DEFAULT_FALLBACK_MODE;
}

/**
 * Create initial state for heartbeat model fallback tracking.
 */
export function createModelFallbackState(
  config: HeartbeatModelConfig | undefined,
): HeartbeatModelState | null {
  const chain = buildModelChain(config);
  if (chain.length === 0) {
    return null;
  }

  return {
    currentIndex: 0,
    modelChain: chain,
    fallbackMode: resolveFallbackMode(config),
    attempts: [],
    lastSuccessfulIndex: null,
    lastSuccessAt: null,
  };
}

/**
 * Get the current model to try.
 */
export function getCurrentModel(state: HeartbeatModelState | null): string | null {
  if (!state || state.currentIndex >= state.modelChain.length) {
    return null;
  }
  return state.modelChain[state.currentIndex];
}

/**
 * Record a successful attempt.
 */
export function recordSuccess(state: HeartbeatModelState, model: string): void {
  state.attempts.push({
    model,
    attemptedAt: Date.now(),
    success: true,
  });
  state.lastSuccessfulIndex = state.currentIndex;
  state.lastSuccessAt = Date.now();
  log.info(`Heartbeat model ${model} succeeded (index ${state.currentIndex})`);
}

/**
 * Record a failed attempt and advance to next model if in immediate mode.
 * Returns true if we should retry with next model immediately.
 */
export function recordFailure(
  state: HeartbeatModelState,
  model: string,
  error: string,
): { shouldRetry: boolean; nextModel: string | null } {
  state.attempts.push({
    model,
    attemptedAt: Date.now(),
    success: false,
    error,
  });

  const isLastModel = state.currentIndex >= state.modelChain.length - 1;

  log.warn(
    `Heartbeat model ${model} failed (index ${state.currentIndex}): ${error}. ` +
      `Mode: ${state.fallbackMode}, isLast: ${isLastModel}`,
  );

  if (isLastModel) {
    // Exhausted all models
    return { shouldRetry: false, nextModel: null };
  }

  if (state.fallbackMode === "immediate") {
    // Advance to next model and retry immediately
    state.currentIndex++;
    const nextModel = state.modelChain[state.currentIndex];
    log.info(`Retrying with next model: ${nextModel} (index ${state.currentIndex})`);
    return { shouldRetry: true, nextModel };
  }

  // next_heartbeat mode: don't advance yet, wait for next poll
  return { shouldRetry: false, nextModel: null };
}

/**
 * Advance to next model for next_heartbeat mode.
 * Call this at the start of a new heartbeat poll.
 */
export function advanceForNextHeartbeat(state: HeartbeatModelState): string | null {
  // If we had a previous failure and haven't advanced yet
  const lastAttempt = state.attempts[state.attempts.length - 1];
  if (lastAttempt && !lastAttempt.success) {
    // Check if we've already advanced past this failure
    const lastAttemptModel = lastAttempt.model;
    const currentModel = state.modelChain[state.currentIndex];

    if (lastAttemptModel === currentModel && state.currentIndex < state.modelChain.length - 1) {
      state.currentIndex++;
      const nextModel = state.modelChain[state.currentIndex];
      log.info(`Next heartbeat will use model: ${nextModel} (index ${state.currentIndex})`);
      return nextModel;
    }
  }

  return getCurrentModel(state);
}

/**
 * Reset state to use the primary model again.
 * Call this when you want to retry from the beginning (e.g., after a long delay).
 */
export function resetToPrimary(state: HeartbeatModelState): void {
  state.currentIndex = 0;
  log.info(`Reset to primary model: ${state.modelChain[0]}`);
}

/**
 * Get a summary of the model fallback state for debugging.
 */
export function getFallbackStateSummary(state: HeartbeatModelState | null): {
  currentModel: string | null;
  chain: string[];
  currentIndex: number;
  lastSuccessfulModel: string | null;
  totalAttempts: number;
} {
  if (!state) {
    return {
      currentModel: null,
      chain: [],
      currentIndex: 0,
      lastSuccessfulModel: null,
      totalAttempts: 0,
    };
  }

  return {
    currentModel: getCurrentModel(state),
    chain: state.modelChain,
    currentIndex: state.currentIndex,
    lastSuccessfulModel:
      state.lastSuccessfulIndex !== null
        ? state.modelChain[state.lastSuccessfulIndex]
        : null,
    totalAttempts: state.attempts.length,
  };
}
