# Heartbeat Model Fallback

This document describes the heartbeat model fallback feature, which allows configuring a primary model with fallback chain for heartbeat runs.

## Overview

When the primary model for heartbeat fails (e.g., rate limit, service unavailable), OpenClaw can automatically try fallback models. This ensures heartbeats continue to work even if your preferred model is temporarily unavailable.

## Configuration Format

### Legacy Format (Backward Compatible)

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "model": "openrouter/tngtech/tng-r1t-chimera:free"
      }
    }
  }
}
```

### New Format with Fallbacks

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "primary": "openrouter/tngtech/tng-r1t-chimera:free",
        "fallbacks": [
          "openrouter/google/gemma-2-2b-it:free",
          "kimi-coding/k2p5",
          "anthropic/claude-sonnet-4-5",
          "openrouter/openrouter/auto"
        ],
        "fallbackMode": "immediate"
      }
    }
  }
}
```

## Configuration Options

### `primary`
- **Type**: `string`
- **Description**: The primary model to use for heartbeat runs (provider/model format)
- **Example**: `"openrouter/tngtech/tng-r1t-chimera:free"`

### `fallbacks`
- **Type**: `string[]`
- **Description**: Ordered list of fallback models to try if the primary fails
- **Example**: `["openrouter/google/gemma-2-2b-it:free", "anthropic/claude-sonnet-4-5"]`

### `fallbackMode`
- **Type**: `"immediate" | "next_heartbeat"`
- **Default**: `"immediate"`
- **Description**: Controls when to try the next fallback model:
  - `"immediate"`: Retry with the next model immediately when the current one fails
  - `"next_heartbeat"`: Wait until the next scheduled heartbeat to try the next model

## Fallback Behavior

### Immediate Mode

```
Heartbeat runs → Primary fails → Immediately try Fallback 1 → Fallback 1 fails → Immediately try Fallback 2 → ...
```

In immediate mode, if a model call fails, the system immediately retries with the next model in the chain. This continues until:
- A model succeeds
- All models are exhausted
- A non-retryable error occurs

### Next Heartbeat Mode

```
Heartbeat 1: Primary fails → Skip to next heartbeat
Heartbeat 2: Try Fallback 1 → Fails → Skip to next heartbeat  
Heartbeat 3: Try Fallback 2 → Succeeds → Continue with Fallback 2
```

In next_heartbeat mode, when a model fails, the system waits until the next scheduled heartbeat to try the next model. This is useful for:
- Avoiding rapid-fire retries that might hit rate limits
- Giving services time to recover between attempts
- Reducing API costs during outages

## State Persistence

The heartbeat model fallback state is maintained in memory during the gateway process lifetime. The state includes:
- Current model index in the chain
- History of attempts (for debugging)
- Last successful model

The state is reset when:
- The gateway restarts
- Configuration is reloaded
- A successful heartbeat completes

## Examples

### Basic Fallback Chain

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "primary": "openai/gpt-4",
        "fallbacks": ["openai/gpt-3.5-turbo", "anthropic/claude-sonnet-4-5"]
      }
    }
  }
}
```

### Per-Agent Fallback Configuration

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "heartbeat": {
          "primary": "openai/gpt-4",
          "fallbacks": ["anthropic/claude-sonnet-4-5"],
          "fallbackMode": "immediate"
        }
      },
      {
        "id": "backup",
        "heartbeat": {
          "primary": "openrouter/google/gemma-2-2b-it:free",
          "fallbacks": ["openrouter/openrouter/auto"],
          "fallbackMode": "next_heartbeat"
        }
      }
    ]
  }
}
```

### Conservative Fallback (Next Heartbeat Mode)

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "primary": "expensive-model",
        "fallbacks": ["cheaper-model-1", "cheaper-model-2", "free-model"],
        "fallbackMode": "next_heartbeat",
        "every": "30m"
      }
    }
  }
}
```

## Monitoring

The heartbeat model fallback state is included in heartbeat events. You can monitor:

- Which model succeeded
- How many fallback attempts were made
- Current model index in the chain

Example log output:
```
[INFO] Attempting heartbeat with model: openai/gpt-4 (index 0)
[WARN] Heartbeat model openai/gpt-4 failed (index 0): Rate limit exceeded. Mode: immediate, isLast: false
[INFO] Retrying with next model: anthropic/claude-sonnet-4-5 (index 1)
[INFO] Heartbeat model anthropic/claude-sonnet-4-5 succeeded (index 1)
```

## Error Handling

### Retryable Errors
The following errors trigger fallback retry:
- Rate limit errors (429)
- Service unavailable (503)
- Gateway timeout (504)
- Network errors
- Timeout errors

### Non-Retryable Errors
The following errors do NOT trigger fallback (heartbeat fails immediately):
- Authentication errors (401)
- Invalid model errors (400)
- Content policy violations

## Migration Guide

### From Legacy Format

Old config:
```json
{
  "heartbeat": {
    "model": "openai/gpt-4"
  }
}
```

New equivalent:
```json
{
  "heartbeat": {
    "model": "openai/gpt-4"
  }
}
```

The legacy `model` field is still supported for backward compatibility.

### Adding Fallbacks to Existing Config

Old config:
```json
{
  "heartbeat": {
    "model": "openai/gpt-4",
    "every": "30m"
  }
}
```

New config with fallbacks:
```json
{
  "heartbeat": {
    "primary": "openai/gpt-4",
    "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-3.5-turbo"],
    "fallbackMode": "immediate",
    "every": "30m"
  }
}
```

## Implementation Details

The heartbeat model fallback logic is implemented in:
- `src/infra/heartbeat-model-fallback.ts` - Core fallback logic
- `src/infra/heartbeat-runner.ts` - Integration with heartbeat runner
- `src/config/types.agent-defaults.ts` - TypeScript types
- `src/config/zod-schema.agent-runtime.ts` - Configuration validation

## Testing

Run the fallback logic tests:

```bash
npm test -- src/infra/heartbeat-model-fallback.test.ts
```
