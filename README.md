# treesession — OpenClaw Plugin

Automatic topic-branching context manager for [OpenClaw](https://github.com/anthropics/openclaw) agents. Keeps users in **one chat session** while internally managing a hierarchical branch tree, reducing token usage by **75–90%** on multi-topic conversations.

## How it works

```
User sends message
       │
       ▼
┌─────────────────┐
│  Score Router    │  Fast keyword-based Jaccard similarity
│  (instant, 2ms) │
└────────┬────────┘
         │ ambiguous?
         ▼
┌─────────────────┐
│  Model Router   │  LLM judge via gateway loopback (JSON fallback)
│  (~6-10s)       │
└────────┬────────┘
         │
         ▼
  Route to existing branch  ──or──  Create new topic branch
         │
         ▼
  Inject branch-scoped context (prependSystemContext + prependContext)
         │
         ▼
  Agent answers with only relevant context
         │
         ▼
  Store turn in branch (agent_end hook)
```

- **`hybrid`** (default): Score router handles clear matches instantly; model router handles ambiguous cases
- **`score`**: Pure keyword Jaccard — fastest, no model calls, may over-split topics
- **`model`**: Always uses LLM judge — most accurate, ~6-10s latency per turn

## Install in OpenClaw

### 1. Clone the plugin

```bash
cd ~/.openclaw/plugins   # or any directory you prefer
git clone https://github.com/shuyhere/treesession-openclaw-plugin.git
```

### 2. Add to `~/.openclaw/openclaw.json`

**Minimal (zero config — recommended):**

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/.openclaw/plugins/treesession-openclaw-plugin"
      ]
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

That's it. The plugin auto-detects your gateway and uses the same model your agent uses — no API keys, no base URLs, no extra config needed.

**Requirements:**
- Gateway `chatCompletions` must be enabled (it is by default):
  ```json
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
  ```

### 3. Restart gateway

```bash
openclaw gateway restart
```

### 4. Verify it's working

Send a few messages on different topics, then run:
```
/tokensavewithtreesession
```

Or visualize the branch tree:
```
visualizesessiontree
```

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
| `storageDir` | `~/.openclaw/treesession-store` | Where branch state is persisted |
| `recentTurns` | `8` | Recent turns included in branch context |
| `retrievalTurns` | `6` | Extra turns retrieved for context |
| `maxBranches` | `80` | Max branches before oldest are pruned |
| `branchCreateThreshold` | `0.22` | Jaccard score below which a new branch is created |
| `maxPrependedChars` | `6000` | Max chars in prepended context |
| `hybridModelFallbackThreshold` | `0.32` | Score below which hybrid calls the model |
| `hybridAmbiguityMargin` | `0.08` | Score gap below which top candidates are "ambiguous" |
| `branchNamingMode` | `"model"` | `model` (LLM names branches) or `keyword` (fast, from content) |
| `autoReorgEnabled` | `true` | Auto-merge idle branches periodically |
| `modelRoutingModel` | `"same"` | `"same"` = use agent's model via gateway |

## Commands

Type these in any chat with your OpenClaw agent:

| Command | Description |
|---------|-------------|
| `/startnewtreesession` | Reset tree and start fresh |
| `/tokensavewithtreesession` | Show token savings report |
| `newsessionbranch: <title>` | Create a new child branch |
| `resumesessionbranch: <title\|id>` | Switch to an existing branch |
| `mergesessionbranch: <source> -> <target>` | Merge two branches |
| `visualizesessiontree` | Output Mermaid tree diagram |
| `autosessionbranch: on\|off` | Toggle automatic routing |
| `summarizebranch:` | Refresh branch summary |
| `reorganizesessiontree` | Force model-based tree reorganization |

## How it preserves your system prompt

The plugin uses `prependSystemContext` (additive — prepended before original system prompt) and `prependContext` (branch-scoped history injected into the conversation). It **never** returns `systemPrompt`, so your agent's identity and instructions are always preserved.

## Token savings (benchmarked)

12-turn conversation across 4 topics (K8s, Photography, Rust, Cooking):

| Turn | No TreeSession | With TreeSession | Savings |
|------|---------------|-----------------|---------|
| 1 | 52 | 62 | -19% (overhead) |
| 6 | 379 | 83 | **78%** |
| 9 | 596 | 96 | **84%** |
| 12 | 800 | 89 | **88.9%** |

20-turn comparison across 3 strategies:

| Strategy | Final savings | Avg latency | Branches |
|----------|--------------|-------------|----------|
| `score` | 93.7% | 2ms | 14 (over-splits) |
| `hybrid` | 76.1% | ~8s | 5 (clean topics) |
| `model` | 76.1% | ~10s | 5 (clean topics) |

## Architecture

```
treesession-openclaw-plugin/
├── index.js              # Main plugin: hooks, commands, invokeModel
├── openclaw.plugin.json  # Plugin manifest & config schema
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
    ├── test-live-e2e.mjs  # Full end-to-end test with real gateway
    ├── test-e2e.mjs       # Unit/integration tests (58 tests)
    └── ...                # Other test/benchmark scripts
```

## Route decision schema

Every routing decision is normalized and stored:

```json
{
  "turn": 5,
  "nodeId": "branch-id",
  "title": "kubernetes-pod-networking",
  "parentId": "root",
  "action": "existing",
  "confidence": 0.85
}
```

Accessible in state as `lastRouteDecision` and `routeDecisions[]` (rolling history).

## License

MIT
