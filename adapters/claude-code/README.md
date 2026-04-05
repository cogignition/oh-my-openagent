# Claude Code Adapter

Bridges [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (omo) to Claude Code's stdin/stdout hook system. Omo was built for OpenCode; this adapter lets the same plugin core run inside Claude Code sessions without touching `src/`.

## How it works

Claude Code fires JSON hook events on stdin. The adapter maps them to omo's handler API, dispatches through the plugin, and writes `{"continue": true}` (plus optional context injection) to stdout.

```
Claude Code → stdin JSON → hook-bridge.ts → event-mapper → omo plugin handler → stdout JSON
```

Local tasks (category `quick`) are routed to LM Studio via the Anthropic-compatible endpoint. Deep tasks go through Claude via the Agent SDK.

```
hook-bridge.ts
  └── headless-delegate.ts
        ├── quick/unspecified-low  → POST http://localhost:1234/v1/messages  (gemma4 / any LM Studio model)
        ├── deep/ultrabrain        → @anthropic-ai/claude-agent-sdk (claude-opus-4-6)
        └── offline fallback       → @anthropic-ai/claude-agent-sdk (claude-haiku-4-5-20251001)
```

## Files

| File | Purpose |
|---|---|
| `hook-bridge.ts` | CLI entry — reads stdin, dispatches, writes stdout |
| `event-mapper.ts` | Claude Code hook events → omo handler + input shape |
| `entry.ts` | Lazy-init omo plugin singleton; writes config on first call |
| `context-shim.ts` | Fake `PluginContext` (recursive Proxy over stubbed client) |
| `config-bridge.ts` | Env vars → `OhMyOpenCodeConfig` shape; writes `~/.config/opencode/oh-my-openagent.json` |
| `headless-delegate.ts` | Routes tasks to LM Studio or Claude Agent SDK |
| `metrics.ts` | OTLP metrics client (hook events, delegate latency, fallbacks) |
| `stdin-reader.ts` | Timeout-safe stdin reader |
| `build.ts` | Generates `hooks/hooks.json`, `.claude-plugin/plugin.json`, writes omo config |

## Hook event mapping

| Claude Code event | omo handler | Notes |
|---|---|---|
| `SessionStart` | `event` | `type: session.created` |
| `UserPromptSubmit` | `chat.message` | |
| `PreToolUse` | `tool.execute.before` | |
| `PostToolUse` | `tool.execute.after` | |
| `PostToolUseFailure` | `tool.execute.after` | `failed: true` |
| `PreCompact` | `experimental.session.compacting` | injects compaction context |
| `Stop` | `event` | `type: session.stopping` |
| `SessionEnd` | `event` | `type: session.ended` |

## Setup

```bash
bun run adapters/claude-code/build.ts
```

Produces `hooks/hooks.json` and `.claude-plugin/plugin.json`, and writes the omo config to `~/.config/opencode/oh-my-openagent.json`.

Add the hook bridge to `~/.claude/settings.json` for each event, and set env vars:

```json
{
  "env": {
    "OMC_PROVIDER_LOW_URL": "http://localhost:1234/v1/messages",
    "OMC_PROVIDER_LOW_KEY": "lmstudio",
    "OMC_PROVIDER_LOW_PROTOCOL": "anthropic",
    "OMC_CATEGORY_QUICK_MODEL": "lmstudio/google/gemma-4-26b-a4b",
    "OMC_METRICS_ENABLED": "true",
    "OMC_METRICS_ENDPOINT": "http://localhost:4318"
  }
}
```

Hook command (via wrapper script):

```json
{ "type": "command", "command": "\"$HOME/.claude/hooks/omo-hook-bridge.sh\"", "timeout": 10000 }
```

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `OMC_PROVIDER_LOW_URL` | — | LM Studio base URL (Anthropic-compat) |
| `OMC_PROVIDER_LOW_KEY` | `lmstudio` | API key for LM Studio |
| `OMC_PROVIDER_LOW_PROTOCOL` | `openai` | Protocol hint (`anthropic` or `openai`) |
| `OMC_CATEGORY_QUICK_MODEL` | `lmstudio/google/gemma-4-26b-a4b` | Model for quick/unspecified-low tasks |
| `OMC_CATEGORY_DEEP_MODEL` | `anthropic/claude-opus-4-6` | Model for deep/ultrabrain tasks |
| `OMC_CATEGORY_FALLBACK_MODEL` | `anthropic/claude-sonnet-4-6` | Fallback when LM Studio is offline |
| `OMC_METRICS_ENABLED` | `false` | Enable OTLP metrics emission |
| `OMC_METRICS_ENDPOINT` | `http://localhost:4318` | OTLP HTTP collector endpoint |

## Metrics

Four instruments emitted to the OTLP endpoint:

| Metric | Type | Labels |
|---|---|---|
| `omo_hook_events_total` | counter | `event_name` |
| `omo_delegate_calls_total` | counter | `category`, `model`, `status` |
| `omo_delegate_latency_ms` | histogram | `category`, `model` |
| `omo_lm_studio_fallbacks_total` | counter | `category`, `reason` |

Grafana dashboard: `deploy/grafana-dashboard-omo.yaml` (CRD, namespace `grafana`, uid `omo-claude-code`).

## Constraints

- `src/` is never modified — all adapter code lives in `adapters/claude-code/`
- Bun runtime only — hooks run via `bun hook-bridge.ts` directly, no CJS bundle
- Imports from `src/` are type-only where possible
