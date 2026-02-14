import { describe, expect, it } from "vitest";
import {
  advanceForNextHeartbeat,
  buildModelChain,
  createModelFallbackState,
  getCurrentModel,
  getFallbackStateSummary,
  parseHeartbeatModelConfig,
  recordFailure,
  recordSuccess,
  resetToPrimary,
  resolveFallbackMode,
  type HeartbeatModelConfig,
} from "./heartbeat-model-fallback.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";

describe("parseHeartbeatModelConfig", () => {
  it("returns undefined for undefined heartbeat", () => {
    expect(parseHeartbeatModelConfig(undefined)).toBeUndefined();
  });

  it("returns string for legacy model format", () => {
    const heartbeat: AgentDefaultsConfig["heartbeat"] = {
      model: "openai/gpt-4",
    };
    expect(parseHeartbeatModelConfig(heartbeat)).toBe("openai/gpt-4");
  });

  it("returns object for new primary format", () => {
    const heartbeat: AgentDefaultsConfig["heartbeat"] = {
      primary: "openai/gpt-4",
      fallbacks: ["openai/gpt-3.5"],
      fallbackMode: "immediate",
    };
    const result = parseHeartbeatModelConfig(heartbeat);
    expect(typeof result).toBe("object");
    expect(result).toEqual({
      primary: "openai/gpt-4",
      fallbacks: ["openai/gpt-3.5"],
      fallbackMode: "immediate",
    });
  });

  it("prefers new format over legacy", () => {
    const heartbeat: AgentDefaultsConfig["heartbeat"] = {
      model: "legacy/model",
      primary: "new/model",
      fallbacks: ["fallback/model"],
    };
    const result = parseHeartbeatModelConfig(heartbeat);
    expect(typeof result).toBe("object");
    expect((result as HeartbeatModelConfig & object).primary).toBe("new/model");
  });

  it("handles empty fallbacks array", () => {
    const heartbeat: AgentDefaultsConfig["heartbeat"] = {
      primary: "openai/gpt-4",
      fallbacks: [],
    };
    const result = parseHeartbeatModelConfig(heartbeat);
    expect(typeof result).toBe("object");
    expect(result).toEqual({
      primary: "openai/gpt-4",
      fallbacks: [],
      fallbackMode: "immediate",
    });
  });
});

describe("buildModelChain", () => {
  it("builds chain from string config", () => {
    expect(buildModelChain("openai/gpt-4")).toEqual(["openai/gpt-4"]);
  });

  it("builds chain from object config", () => {
    expect(
      buildModelChain({
        primary: "openai/gpt-4",
        fallbacks: ["openai/gpt-3.5", "anthropic/claude"],
      }),
    ).toEqual(["openai/gpt-4", "openai/gpt-3.5", "anthropic/claude"]);
  });

  it("deduplicates models in chain", () => {
    expect(
      buildModelChain({
        primary: "openai/gpt-4",
        fallbacks: ["openai/gpt-4", "openai/gpt-3.5"],
      }),
    ).toEqual(["openai/gpt-4", "openai/gpt-3.5"]);
  });

  it("handles empty fallbacks", () => {
    expect(
      buildModelChain({
        primary: "openai/gpt-4",
        fallbacks: [],
      }),
    ).toEqual(["openai/gpt-4"]);
  });

  it("handles missing primary with fallbacks", () => {
    expect(
      buildModelChain({
        fallbacks: ["fallback1", "fallback2"],
      }),
    ).toEqual(["fallback1", "fallback2"]);
  });

  it("handles whitespace trimming", () => {
    expect(
      buildModelChain({
        primary: "  openai/gpt-4  ",
        fallbacks: ["  fallback  "],
      }),
    ).toEqual(["openai/gpt-4", "fallback"]);
  });

  it("returns empty array for undefined config", () => {
    expect(buildModelChain(undefined)).toEqual([]);
  });
});

describe("resolveFallbackMode", () => {
  it("returns default immediate mode", () => {
    expect(resolveFallbackMode(undefined)).toBe("immediate");
    expect(resolveFallbackMode("openai/gpt-4")).toBe("immediate");
  });

  it("returns configured mode", () => {
    expect(
      resolveFallbackMode({ primary: "model", fallbacks: [], fallbackMode: "next_heartbeat" }),
    ).toBe("next_heartbeat");
  });
});

describe("createModelFallbackState", () => {
  it("returns null for empty chain", () => {
    expect(createModelFallbackState(undefined)).toBeNull();
    expect(createModelFallbackState("")).toBeNull();
  });

  it("creates state with correct initial values", () => {
    const state = createModelFallbackState({
      primary: "primary/model",
      fallbacks: ["fallback1", "fallback2"],
      fallbackMode: "immediate",
    });

    expect(state).not.toBeNull();
    expect(state!.currentIndex).toBe(0);
    expect(state!.modelChain).toEqual(["primary/model", "fallback1", "fallback2"]);
    expect(state!.fallbackMode).toBe("immediate");
    expect(state!.attempts).toEqual([]);
    expect(state!.lastSuccessfulIndex).toBeNull();
  });
});

describe("getCurrentModel", () => {
  it("returns current model from state", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
    })!;
    expect(getCurrentModel(state)).toBe("primary");
  });

  it("returns null for exhausted state", () => {
    const state = createModelFallbackState({ primary: "primary" })!;
    state.currentIndex = 1; // Past end
    expect(getCurrentModel(state)).toBeNull();
  });

  it("returns null for null state", () => {
    expect(getCurrentModel(null)).toBeNull();
  });
});

describe("recordSuccess", () => {
  it("records successful attempt", () => {
    const state = createModelFallbackState({ primary: "primary" })!;
    recordSuccess(state, "primary");

    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].model).toBe("primary");
    expect(state.attempts[0].success).toBe(true);
    expect(state.lastSuccessfulIndex).toBe(0);
    expect(state.lastSuccessAt).not.toBeNull();
  });
});

describe("recordFailure", () => {
  it("records failure without retry for last model", () => {
    const state = createModelFallbackState({ primary: "primary" })!;
    const result = recordFailure(state, "primary", "API error");

    expect(result.shouldRetry).toBe(false);
    expect(result.nextModel).toBeNull();
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].success).toBe(false);
    expect(state.attempts[0].error).toBe("API error");
  });

  it("advances and retries immediately in immediate mode", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
      fallbackMode: "immediate",
    })!;
    const result = recordFailure(state, "primary", "API error");

    expect(result.shouldRetry).toBe(true);
    expect(result.nextModel).toBe("fallback");
    expect(state.currentIndex).toBe(1);
  });

  it("does not advance in next_heartbeat mode", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
      fallbackMode: "next_heartbeat",
    })!;
    const result = recordFailure(state, "primary", "API error");

    expect(result.shouldRetry).toBe(false);
    expect(state.currentIndex).toBe(0); // Not advanced
  });
});

describe("advanceForNextHeartbeat", () => {
  it("advances after failure in next_heartbeat mode", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
      fallbackMode: "next_heartbeat",
    })!;

    // Simulate failure
    recordFailure(state, "primary", "API error");

    // Next heartbeat should advance
    const nextModel = advanceForNextHeartbeat(state);
    expect(nextModel).toBe("fallback");
    expect(state.currentIndex).toBe(1);
  });

  it("does not advance if already at different model", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback1", "fallback2"],
      fallbackMode: "next_heartbeat",
    })!;

    // Simulate failure and manual advance
    recordFailure(state, "primary", "API error");
    state.currentIndex = 1;

    // Should stay at current
    const nextModel = advanceForNextHeartbeat(state);
    expect(nextModel).toBe("fallback1");
    expect(state.currentIndex).toBe(1);
  });

  it("returns null when exhausted", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
      fallbackMode: "next_heartbeat",
    })!;

    state.currentIndex = 1;
    recordFailure(state, "fallback", "API error");

    const nextModel = advanceForNextHeartbeat(state);
    expect(nextModel).toBeNull();
  });
});

describe("resetToPrimary", () => {
  it("resets index to 0", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
    })!;

    state.currentIndex = 1;
    resetToPrimary(state);

    expect(state.currentIndex).toBe(0);
  });
});

describe("getFallbackStateSummary", () => {
  it("returns empty summary for null state", () => {
    expect(getFallbackStateSummary(null)).toEqual({
      currentModel: null,
      chain: [],
      currentIndex: 0,
      lastSuccessfulModel: null,
      totalAttempts: 0,
    });
  });

  it("returns full summary for active state", () => {
    const state = createModelFallbackState({
      primary: "primary",
      fallbacks: ["fallback"],
    })!;

    recordSuccess(state, "primary");

    const summary = getFallbackStateSummary(state);
    expect(summary.currentModel).toBe("primary");
    expect(summary.chain).toEqual(["primary", "fallback"]);
    expect(summary.currentIndex).toBe(0);
    expect(summary.lastSuccessfulModel).toBe("primary");
    expect(summary.totalAttempts).toBe(1);
  });
});
