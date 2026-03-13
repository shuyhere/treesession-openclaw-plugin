# treesession — OpenClaw Plugin 🌳

**Automatic topic-branching context manager for [OpenClaw](https://github.com/openclaw/openclaw) agents.**

Keep users in one chat session while internally managing a hierarchical branch tree. Reduces token usage by **75–90%** on multi-topic conversations.

> One chat. Many topics. Zero context pollution.

## How it works

```
User sends message
       │
       ▼
┌─────────────────┐
│  Score Router    │  Fast keyword-based Jaccard similarity (~2ms)
└────────┬────────┘
         │ ambiguous?
         ▼
┌─────────────────┐
│  Model Router   │  LLM judge via gateway loopback (~6-10s)
└────────┬────────┘
         │
         ▼
  Route to existing branch ── or ── Create new topic branch
         │
         ▼
  Inject branch-scoped context (only relevant turns)
         │
         ▼
  Agent answers with clean, focused context
```

**Routing strategies:**
- **`hybrid`** (default) — keyword scoring first, LLM fallback for ambiguous cases
- **`score`** — pure Jaccard, instant, may over-split
- **`model`** — always LLM judge, most accurate, slower

## Install

### 1. Clone the plugin

```bash
cd ~/.openclaw/plugins
git clone https://github.com/shuyhere/treesession-openclaw-plugin.git
```

### 2. Add to `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins/treesession-openclaw-plugin"]
    },
    "entries": {
      "treesession-openclaw-plugin": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Zero config needed — the plugin auto-detects your gateway and uses the same model your agent uses.

### 3. Restart gateway

```bash
openclaw gateway restart
```

## Usage

### Slash commands

| Command | Description |
|---------|-------------|
| `/startnewtreesession` | Reset tree and start a fresh session |
| `/treestatus` | Show branches, active branch, turn counts, and token savings |

### In-chat commands

Type these directly in chat with your agent:

| Command | Description |
|---------|-------------|
| `newsessionbranch: <title>` | Create a new child branch |
| `resumesessionbranch: <title\|id>` | Switch to an existing branch |
| `mergesessionbranch: <source> -> <target>` | Merge two branches |
| `visualizesessiontree` | Output Mermaid tree diagram |
| `autosessionbranch: on\|off` | Toggle automatic routing |
| `summarizebranch:` | Refresh branch summary |
| `reorganizesessiontree` | Force model-based tree reorganization |

### Example — real interaction

**User:** "How do I fine-tune Llama with LoRA?"
→ TreeSession creates branch: `llama-lora-finetuning`

**User:** "What's the weather in Tokyo?"
→ TreeSession creates new branch: `tokyo-weather`
→ Agent only sees weather context, not the LoRA discussion

**User:** "What learning rate should I use?"
→ TreeSession routes back to `llama-lora-finetuning`
→ Agent sees full LoRA context, not weather

**Result:** Each topic gets focused context. No pollution. Token savings grow with every turn.

## Token savings (benchmarked)

12-turn conversation across 4 topics:

| Turn | Without TreeSession | With TreeSession | Savings |
|------|-------------------|-----------------|---------|
| 1 | 52 tokens | 62 tokens | -19% (initial overhead) |
| 6 | 379 tokens | 83 tokens | **78%** |
| 9 | 596 tokens | 96 tokens | **84%** |
| 12 | 800 tokens | 89 tokens | **88.9%** |

Strategy comparison (20-turn):

| Strategy | Final savings | Avg latency | Branches created |
|----------|--------------|-------------|-----------------|
| `score` | 93.7% | ~2ms | 14 (over-splits) |
| `hybrid` | 76.1% | ~8s | 5 (clean topics) |
| `model` | 76.1% | ~10s | 5 (clean topics) |

## Configuration (all optional)

```json
{
  "treesession-openclaw-plugin": {
    "enabled": true,
    "config": {
      "routingStrategy": "hybrid",
      "storageDir": "~/.openclaw/treesession-store",
      "recentTurns": 8,
      "retrievalTurns": 6,
      "maxBranches": 80,
      "branchCreateThreshold": 0.22,
      "maxPrependedChars": 6000,
      "hybridModelFallbackThreshold": 0.32,
      "hybridAmbiguityMargin": 0.08,
      "autoReorgEnabled": true
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `routingStrategy` | `"hybrid"` | `hybrid`, `score`, or `model` |
| `recentTurns` | `8` | Recent turns included in branch context |
| `retrievalTurns` | `6` | Extra turns retrieved for context |
| `maxBranches` | `80` | Max branches before oldest are pruned |
| `branchCreateThreshold` | `0.22` | Jaccard score below which new branch is created |
| `maxPrependedChars` | `6000` | Max chars in prepended context |
| `hybridModelFallbackThreshold` | `0.32` | Score below which hybrid calls the model |
| `hybridAmbiguityMargin` | `0.08` | Score gap below which top candidates are "ambiguous" |
| `branchNamingMode` | `"model"` | `model` (LLM names branches) or `keyword` (fast) |
| `autoReorgEnabled` | `true` | Auto-merge idle branches periodically |
| `modelRoutingModel` | `"same"` | `"same"` = use agent's model via gateway |

## Architecture

```
treesession-openclaw-plugin/
├── index.js              # Main plugin: hooks, commands, invokeModel
├── openclaw.plugin.json  # Plugin manifest & config schema (v0.4.0)
├── package.json
├── lib/
│   ├── router.js         # Score-based Jaccard routing
│   ├── model-router.js   # LLM judge routing (tool_use + JSON fallback)
│   ├── composer.js        # Branch context composition
│   ├── naming.js          # Branch title generation
│   ├── store.js           # File-based state persistence
│   ├── tree.js            # Tree operations (merge, recompute paths)
│   ├── maintainer.js      # Auto-reorganization
│   ├── commands.js        # Command parsing
│   ├── reorg.js           # Reorganization logic
│   └── util.js            # Tokenize, Jaccard, helpers
└── scripts/
    └── test-*.mjs         # E2E and integration tests
```

## How it preserves your system prompt

The plugin uses `prependSystemContext` (additive — prepended before the original system prompt) and `prependContext` (branch-scoped history). It **never** overwrites `systemPrompt`, so your agent's identity, skills, and instructions are always preserved.

## Requirements

- OpenClaw with gateway `chatCompletions` enabled (default)
- No extra API keys needed — uses gateway loopback

## License

MIT
