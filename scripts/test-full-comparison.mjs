#!/usr/bin/env node
/**
 * test-full-comparison.mjs — Full real-session test: score vs hybrid vs model vs no-treesession
 *
 * Uses the REAL gateway. Compares token usage across all routing strategies
 * against a baseline of no treesession (full history sent every turn).
 *
 * Token counting matches OpenClaw's estimateTokens(): Math.ceil(chars / 4)
 * per message, summed across the full messages[] array.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ── OpenClaw-compatible token estimation ─────────────────────────────
// Matches: @mariozechner/pi-coding-agent/dist/core/compaction/compaction.js
// estimateTokens(message) -> Math.ceil(chars / 4)
// estimateMessagesTokens(messages) -> sum of estimateTokens per message
function estimateTokens(message) {
  let chars = 0;
  const content = message?.content;
  if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && block.text) chars += block.text.length;
      else if (block?.type === 'thinking' && block.thinking) chars += block.thinking.length;
      else if (block?.type === 'toolCall') chars += (block.name || '').length + JSON.stringify(block.arguments || {}).length;
      else if (block?.type === 'image') chars += 4800;
    }
  }
  return Math.ceil(chars / 4);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

// ── Conversation data (5 topics, 20 turns) ───────────────────────────
const SYSTEM_PROMPT = 'You are a helpful AI assistant. You answer questions accurately and concisely. You can help with programming, cooking, travel planning, finance, and general knowledge.';

const CONVERSATION = [
  // ML (1-4)
  { topic: 'ML', user: 'I want to understand transformer architectures. Can you explain multi-head attention and how it differs from standard self-attention?', assistant: 'Multi-head attention runs multiple attention computations in parallel, each with its own learned projections (Q, K, V). Each "head" attends to different parts of the sequence, capturing different relationship patterns. Standard self-attention uses a single set of Q/K/V projections. With h heads, the model can jointly attend from different representation subspaces. The outputs are concatenated and projected back to the model dimension. This gives transformers much richer representational capacity.' },
  { topic: 'ML', user: 'What about positional encoding? Why do transformers need it and what are the common approaches?', assistant: 'Transformers process all tokens in parallel (unlike RNNs), so they have no inherent notion of sequence order. Positional encodings inject position information. Common approaches: (1) Sinusoidal fixed encodings (original paper) using sin/cos at different frequencies, (2) Learned positional embeddings — trainable vectors per position, (3) Rotary Position Embedding (RoPE) — encodes relative positions via rotation matrices, used in LLaMA/GPT-NeoX, (4) ALiBi — adds linear bias to attention scores based on distance. RoPE and ALiBi handle longer sequences better than fixed/learned.' },
  { topic: 'ML', user: 'How does the training process work for large language models? What is the pretraining objective?', assistant: 'LLM pretraining uses next-token prediction (causal language modeling). Given a sequence of tokens, the model predicts the probability distribution over the next token. The loss function is cross-entropy between predicted and actual next tokens. Training involves: (1) Tokenization — BPE or SentencePiece to convert text to token IDs, (2) Forward pass through transformer layers, (3) Compute loss across all positions, (4) Backpropagation with gradient accumulation across micro-batches, (5) Optimizer step (usually AdamW with warmup + cosine decay). Modern training uses mixed precision (bf16), tensor/pipeline/data parallelism, and gradient checkpointing to fit in GPU memory.' },
  { topic: 'ML', user: 'What is RLHF and why is it important for making models useful?', assistant: 'RLHF (Reinforcement Learning from Human Feedback) aligns model outputs with human preferences. The process: (1) Supervised fine-tuning (SFT) on high-quality demonstrations, (2) Train a reward model from human comparisons of model outputs, (3) Optimize the policy (model) using PPO or DPO to maximize the reward while staying close to the SFT model via a KL penalty. RLHF is crucial because pretraining only optimizes for next-token prediction, which doesn\'t directly optimize for helpfulness, honesty, or safety. Without RLHF, models tend to be verbose, refuse less, and follow instructions poorly.' },

  // Cooking (5-8)
  { topic: 'Cook', user: 'I want to learn proper French cooking techniques. What are the five French mother sauces and how do you make them?', assistant: 'The five French mother sauces: (1) Béchamel — butter + flour roux whisked with hot milk until thick and smooth. Base for mac and cheese, gratins. (2) Velouté — blonde roux + light stock (chicken, fish, or veal). Silky texture, base for cream sauces. (3) Espagnole — brown roux + brown stock + tomato purée + mirepoix, reduced. Rich and complex. (4) Hollandaise — egg yolks + clarified butter + lemon, emulsified over gentle heat. For eggs Benedict, asparagus. (5) Tomato sauce — tomatoes + aromatics + pork or stock, simmered until concentrated. Each can be modified into dozens of "daughter sauces" — like Mornay (béchamel + cheese) or béarnaise (hollandaise + tarragon).' },
  { topic: 'Cook', user: 'How do I properly sear a steak to get a good Maillard crust without overcooking the inside?', assistant: 'For a perfect sear: (1) Pat the steak completely dry with paper towels — moisture is the enemy of browning. (2) Season generously with salt 30-45 min before (dry brine) or just before cooking. (3) Use a cast iron or carbon steel pan, heated until smoking (230°C+). (4) Add high smoke-point oil (avocado, grapeseed). (5) Lay steak away from you, press gently for full contact. Don\'t move it for 2-3 minutes. (6) Flip once when a deep brown crust forms. (7) For thick cuts (>1.5"), use reverse sear: low oven (120°C) to 10°F below target, then sear in screaming hot pan for 60-90 seconds per side. Rest 5-10 minutes before cutting.' },
  { topic: 'Cook', user: 'What about knife skills? What are the essential cuts every home cook should know?', assistant: 'Essential knife cuts: (1) Brunoise — 3mm dice, for garnishes and soffrito. (2) Small dice — 6mm cubes. (3) Medium dice — 12mm cubes, most common for soups/stews. (4) Julienne — matchstick strips, 3mm × 3mm × 5cm. For stir-fries and salads. (5) Chiffonade — roll herbs/leaves and slice into thin ribbons. For basil garnish. (6) Mince — as fine as possible, for garlic and shallots. (7) Batonnet — 6mm × 6mm × 6cm sticks, for fries and crudités. Key technique: use a "claw grip" on the food (fingertips curled under) and keep the knife tip on the board, rocking forward. Sharpen your knife with a whetstone every few weeks and hone with a steel before each use.' },
  { topic: 'Cook', user: 'Can you recommend a good weeknight dinner recipe that uses those techniques?', assistant: 'Poulet à la moutarde (chicken with mustard cream sauce) — 30 minutes, uses several techniques: (1) Season chicken thighs, pat dry. Sear skin-side down in hot cast iron (Maillard!), 5 min until golden. Flip, cook 3 min. Remove. (2) In the same pan, sauté minced shallots (use your mince cut) until soft. Deglaze with white wine. (3) Add 200ml chicken stock + 2 tbsp Dijon mustard + 100ml crème fraîche. This is essentially a velouté variation. (4) Return chicken, simmer 12-15 min until cooked through. (5) Finish with fresh thyme (chiffonade) and a squeeze of lemon. Serve with roasted potatoes (medium dice, tossed in duck fat, 200°C for 35 min) or a simple green salad.' },

  // Travel (9-11)
  { topic: 'Travel', user: 'I\'m planning a 2-week trip to Japan. What\'s the best itinerary covering Tokyo, Kyoto, and Osaka?', assistant: 'A solid 2-week Japan itinerary: Days 1-4: Tokyo — Shibuya, Shinjuku, Akihabara, Tsukiji outer market, Meiji Shrine, Senso-ji in Asakusa, day trip to Kamakura for the Great Buddha. Get a 14-day JR Pass. Days 5-6: Hakone — onsen ryokan stay, Lake Ashi cruise, views of Mt. Fuji, Open Air Museum. Days 7-10: Kyoto — Fushimi Inari (go at sunrise), Arashiyama bamboo grove, Kinkaku-ji, Philosopher\'s Path, Nishiki Market. Day trip to Nara for the deer park and Todai-ji. Days 11-12: Osaka — Dotonbori street food (takoyaki, okonomiyaki), Osaka Castle, Shinsekai district, Kuromon Market. Day 13: Hiroshima + Miyajima Island (floating torii gate). Day 14: Return to Tokyo for departure. Budget about ¥15,000-20,000/day for food and activities.' },
  { topic: 'Travel', user: 'What about the food? What must-try dishes should I seek out in each city?', assistant: 'Japan food guide by city: Tokyo — (1) Sushi at Tsukiji/Toyosu area omakase, (2) Ramen in Shinjuku (try Fuunji for tsukemen), (3) Tempura at a counter restaurant, (4) Yakitori under the train tracks in Yurakucho. Kyoto — (1) Kaiseki multi-course dinner (book ahead), (2) Yudofu (hot tofu) near temples, (3) Matcha everything in Uji district, (4) Nishiki Market snacks — pickles, mochi, grilled seafood. Osaka (the food capital) — (1) Takoyaki (octopus balls) at Wanaka, (2) Okonomiyaki at Mizuno (counter-cooked), (3) Kushikatsu (deep-fried skewers) in Shinsekai, (4) Kobe beef day trip (30 min by train). General tips: convenience store onigiri are surprisingly excellent, 7-Eleven and Lawson have amazing ready meals.' },
  { topic: 'Travel', user: 'How should I handle transportation? Is the JR Pass worth it?', assistant: 'JR Pass breakdown: A 14-day JR Pass costs ~¥50,000 (~$340). Tokyo→Kyoto shinkansen alone is ¥13,000 one-way, so round trip + Hiroshima day trip already justifies the cost. The pass covers: all JR trains (shinkansen except Nozomi/Mizuho, local lines), JR buses, Miyajima ferry. NOT covered: subway/metro in cities, private railways (Kintetsu, Hankyu). For cities: Get a Suica/Pasmo IC card (tap-and-go for subway, buses, vending machines). Tokyo Metro 24hr pass (¥600) is great value. Kyoto: mostly buses (¥230 flat fare, day pass ¥700). Osaka: Metro day pass. Pro tips: Reserve shinkansen seats at JR stations (free with pass), Google Maps works perfectly for all transit, download offline maps. Taxis are expensive but useful late night.' },

  // Rust (12-15)
  { topic: 'Rust', user: 'I\'m learning Rust. Can you explain the ownership system and how borrowing works?', assistant: 'Rust\'s ownership system enforces memory safety without garbage collection. Three rules: (1) Each value has exactly one owner. (2) When the owner goes out of scope, the value is dropped (freed). (3) Ownership can be transferred (moved) but not duplicated (except types implementing Copy). Borrowing lets you reference data without taking ownership: &T is an immutable borrow — multiple allowed simultaneously. &mut T is a mutable borrow — only one allowed, and no immutable borrows can coexist. This prevents data races at compile time.' },
  { topic: 'Rust', user: 'What about lifetimes? I keep getting lifetime errors and don\'t understand the annotations.', assistant: 'Lifetimes are Rust\'s way of ensuring references are always valid. The compiler infers most lifetimes, but sometimes you need explicit annotations: fn longest<\'a>(x: &\'a str, y: &\'a str) -> &\'a str means: the returned reference lives at least as long as both inputs. Common fixes: (1) "borrowed value does not live long enough" — return an owned value (String instead of &str). (2) Struct with references needs lifetime: struct Excerpt<\'a> { text: &\'a str }. Rules of thumb: prefer owned types in structs, use references in function params. \'static means "lives for entire program".' },
  { topic: 'Rust', user: 'How do I handle errors properly in Rust? What\'s the difference between Result and Option?', assistant: 'Error handling: Option<T> = value may be absent (Some(T) or None). Result<T, E> = operation may succeed or fail (Ok(T) or Err(E)). Key patterns: (1) ? operator — propagates errors: let file = File::open("data.txt")?; (2) match for explicit handling. (3) .unwrap()/.expect() — panic on error, only in tests. (4) map, and_then, unwrap_or_default for chaining. For custom errors, use thiserror for libraries, anyhow for apps. Never use unwrap() in production.' },
  { topic: 'Rust', user: 'What about async Rust? How does tokio work and when should I use it?', assistant: 'Async Rust: async fn returns a Future, doesn\'t execute until .await\'ed. Tokio provides: (1) Task scheduler — multiplexes futures onto thread pool, (2) Async I/O — non-blocking network/file operations, (3) Channels — mpsc, oneshot, broadcast, (4) Sync primitives — async Mutex, RwLock. When to use: network servers, HTTP clients, concurrent I/O. When NOT to use: CPU-bound work (use rayon), simple scripts. Pitfalls: don\'t use std::sync::Mutex in async (blocks executor), spawned tasks must be \'static.' },

  // Finance (16-18)
  { topic: 'Finance', user: 'I\'m 28 and want to start investing. What\'s a good strategy for long-term wealth building?', assistant: 'Strategy for 28: (1) Emergency fund first — 3-6 months expenses in high-yield savings. (2) Max tax-advantaged: 401(k) to employer match, then Roth IRA ($7,000/yr). (3) Index funds — VTI/VTSAX + VXUS, 80/20 domestic/international. (4) ~10% bonds at 28. (5) Dollar-cost average monthly. (6) After tax-advantaged, use taxable brokerage. Key: time in market > timing, fees under 0.1%, rebalance annually. $500/month at 7% → ~$760K by 58.' },
  { topic: 'Finance', user: 'What about tax optimization? How can I minimize my tax burden legally?', assistant: 'Tax strategies: (1) Traditional 401(k) — deducts from current income. (2) Roth — after-tax, tax-free growth/withdrawal. (3) Tax-loss harvesting — sell losers to offset gains (wash sale: 30 day rule). (4) Hold 1+ year for long-term cap gains rate (0/15/20%). (5) HSA triple advantage — deductible, tax-free growth, tax-free medical withdrawal. (6) Mega backdoor Roth — up to $69K/yr if 401(k) allows. (7) Municipal bonds — federally tax-free interest.' },
  { topic: 'Finance', user: 'How should I think about buying a house vs renting?', assistant: 'Buy vs rent: Buy when: stay 5+ years, mortgage ≤ 28% gross income, 20% down, price-to-rent < 20. Rent when: need flexibility, market overheated (P/R > 25), can invest the difference. Hidden costs: property tax (1-2%/yr), insurance, maintenance (1-2%/yr), HOA, opportunity cost of down payment. Real answer: run the numbers with NYT buy-vs-rent calculator. In expensive cities renting + investing often wins.' },

  // Back to ML (19-20)
  { topic: 'ML', user: 'Going back to transformers — how does Flash Attention work and why is it faster?', assistant: 'Flash Attention: 2-4x faster, 5-20x less memory than standard attention. Key insight: standard attention materializes the full N×N matrix in HBM (slow GPU memory). Flash Attention: (1) Tiles Q,K,V into blocks fitting in SRAM (fast on-chip), (2) Computes attention block-by-block with online softmax, (3) Never stores full N×N matrix — O(N) memory vs O(N²). IO-aware: minimizes HBM↔SRAM data movement. Flash Attention 2 reduces non-matmul FLOPs. Flash Attention 3 (Hopper) uses async ops + FP8. Now standard in PyTorch 2.0+, HuggingFace, vLLM.' },
  { topic: 'ML', user: 'What are the current frontiers in LLM research? What problems are people working on?', assistant: 'LLM frontiers: (1) Long context — 1M+ tokens (Ring Attention, Infini-Attention). (2) MoE — sparse activation (Mixtral, DBRX). (3) Efficient inference — speculative decoding, quantization (GPTQ, AWQ), KV-cache optimization. (4) Multimodal — unified vision-language (GPT-4V, LLaVA). (5) Reasoning — chain/tree-of-thought, process reward models. (6) Alignment — DPO, constitutional AI, debate. (7) Agents — tool use, planning with memory. (8) Small capable models — distillation to make 7B match GPT-3.5. (9) RAG — better chunking, reranking.' },
];

// ── Mock API builder ─────────────────────────────────────────────────
async function loadRealConfig() {
  return JSON.parse(await fs.readFile(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
}

function buildApi(config, storeDir, routingStrategy) {
  const hooks = {};
  const logs = [];
  return {
    api: {
      id: 'treesession-openclaw-plugin',
      name: 'treesession OpenClaw Plugin',
      config,
      pluginConfig: {
        enabled: true,
        storageDir: storeDir,
        routingStrategy,
        branchNamingMode: 'keyword',
        autoReorgEnabled: false,
      },
      logger: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
        debug: (msg) => logs.push({ level: 'debug', msg }),
      },
      on(hookName, handler) { if (!hooks[hookName]) hooks[hookName] = []; hooks[hookName].push(handler); },
      registerCommand() {},
      registerContextEngine() {},
    },
    hooks,
    logs,
  };
}

async function fire(hooks, name, event, ctx) {
  for (const h of hooks[name] || []) { const r = await h(event, ctx); if (r) return r; }
  return null;
}

async function cleanDir(dir) {
  try { for (const f of await fs.readdir(dir)) await fs.unlink(path.join(dir, f)).catch(() => {}); await fs.rmdir(dir).catch(() => {}); } catch {}
}

// ── Run one strategy through full conversation ───────────────────────
async function runStrategy(config, strategyName, storeDir) {
  await fs.mkdir(storeDir, { recursive: true });
  await cleanDir(storeDir);
  await fs.mkdir(storeDir, { recursive: true });

  const { api, hooks, logs } = buildApi(config, storeDir, strategyName);
  const plugin = (await import(`${PLUGIN_DIR}/index.js?t=${Date.now()}_${strategyName}`)).default;
  await plugin.register(api);

  const ctx = { agentId: 'test-compare', sessionKey: `compare-${strategyName}`, sessionId: `cmp-${strategyName}` };
  const perTurn = [];

  for (let i = 0; i < CONVERSATION.length; i++) {
    const { topic, user, assistant } = CONVERSATION[i];
    const t0 = Date.now();

    const r = await fire(hooks, 'before_prompt_build', {
      prompt: user,
      messages: i > 0 ? [{ role: 'user', content: CONVERSATION[i-1].user }, { role: 'assistant', content: CONVERSATION[i-1].assistant }] : [],
    }, ctx);
    const ms = Date.now() - t0;

    // What OpenClaw would send to the model WITH treesession:
    // system (original + prependSystemContext) + prependContext merged into user prompt + full messages[]
    // But the key saving is: prependContext scopes the context, so irrelevant history can be dropped.
    //
    // Token count for "with treesession" = system + prependSystemContext + prependContext + current user prompt
    // (treesession replaces the need to send full history — branch context IS the relevant history)
    const prependContext = r?.prependContext || '';
    const prependSystem = r?.prependSystemContext || '';

    const withTreesessionTokens =
      estimateTokens({ role: 'system', content: SYSTEM_PROMPT + '\n' + prependSystem }) +
      estimateTokens({ role: 'user', content: prependContext + '\n' + user });

    // Extract route info from logs
    const routeLog = logs.filter((l) => l.msg.includes('before_prompt_build routed')).pop();
    let routedTo = '?', routeAction = '?';
    if (routeLog) {
      const m = routeLog.msg.match(/routed -> (.+?) \((.+?),/);
      if (m) { routedTo = m[1]; routeAction = m[2]; }
    }

    perTurn.push({ turn: i + 1, topic, ms, withTreesessionTokens, routedTo, routeAction });

    await fire(hooks, 'agent_end', {
      success: true,
      messages: [{ role: 'user', content: user }, { role: 'assistant', content: assistant }],
    }, ctx);
  }

  // Read final state
  let branchCount = 0;
  let branchInfo = [];
  try {
    const files = await fs.readdir(storeDir);
    const sf = files.find((f) => f.includes(`compare-${strategyName}`));
    if (sf) {
      const state = JSON.parse(await fs.readFile(path.join(storeDir, sf), 'utf8'));
      branchCount = state.branches.length;
      branchInfo = state.branches.map((b) => ({
        title: b.title,
        turns: b.turns?.length || 0,
        kw: (b.keywords || []).slice(0, 5).join(','),
        active: b.id === state.activeBranchId,
      }));
    }
  } catch {}

  await cleanDir(storeDir);
  return { strategyName, perTurn, branchCount, branchInfo };
}

// ── Compute baseline (no treesession) ────────────────────────────────
function computeBaseline() {
  const perTurn = [];
  const history = [];

  for (let i = 0; i < CONVERSATION.length; i++) {
    const { topic, user, assistant } = CONVERSATION[i];
    history.push({ role: 'user', content: user });

    // What OpenClaw sends WITHOUT treesession: system + all accumulated messages
    const systemTokens = estimateTokens({ role: 'system', content: SYSTEM_PROMPT });
    const historyTokens = estimateMessagesTokens(history);
    const total = systemTokens + historyTokens;

    perTurn.push({ turn: i + 1, topic, tokens: total });

    history.push({ role: 'assistant', content: assistant });
  }
  return perTurn;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════
async function main() {
  console.log(bold('\n🌲 TreeSession — Full Comparison: score vs hybrid vs model vs no-treesession\n'));

  const config = await loadRealConfig();
  const baseDir = path.join(process.env.HOME, '.openclaw/treesession-store');

  // Check gateway
  const gwPort = config.gateway?.port || 18789;
  const gwPw = config.gateway?.auth?.password || '';
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/health`, {
      headers: gwPw ? { Authorization: `Bearer ${gwPw}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`  ${green('✓')} Gateway alive at :${gwPort}`);
  } catch (e) {
    console.log(`  ${red('✗')} Gateway unreachable: ${e.message}`);
    console.log(`  Run ${cyan('openclaw gateway start')} first.\n`);
    process.exit(1);
  }

  // ── Baseline ───────────────────────────────────────────────────────
  console.log(bold('\n── Baseline: No TreeSession (full history every turn) ──\n'));
  const baseline = computeBaseline();

  console.log(`  ${'Turn'.padEnd(5)} ${'Topic'.padEnd(10)} ${'Tokens'.padStart(8)}`);
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
  for (const b of baseline) {
    console.log(`  ${String(b.turn).padEnd(5)} ${b.topic.padEnd(10)} ${String(b.tokens).padStart(8)}`);
  }
  console.log(`\n  ${dim('Final turn total:')} ${bold(String(baseline[baseline.length - 1].tokens))} tokens`);

  // ── Run strategies ─────────────────────────────────────────────────
  const strategies = ['score', 'hybrid', 'model'];
  const results = {};

  for (const strat of strategies) {
    const needsGateway = strat === 'hybrid' || strat === 'model';
    console.log(bold(`\n── Strategy: ${strat}${needsGateway ? ' (uses real gateway)' : ''} ──\n`));

    const t0 = Date.now();
    results[strat] = await runStrategy(config, strat, path.join(baseDir, `test-compare-${strat}`));
    const totalMs = Date.now() - t0;

    const r = results[strat];
    console.log(`  ${'Turn'.padEnd(5)} ${'Topic'.padEnd(10)} ${'Tokens'.padStart(8)} ${'ms'.padStart(8)} ${'Route'.padEnd(14)} ${'Branch'.padEnd(30)}`);
    console.log(`  ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(14)} ${'─'.repeat(30)}`);
    for (const t of r.perTurn) {
      console.log(`  ${String(t.turn).padEnd(5)} ${t.topic.padEnd(10)} ${String(t.withTreesessionTokens).padStart(8)} ${String(t.ms).padStart(7)}ms ${t.routeAction.padEnd(14)} ${dim(t.routedTo.slice(0, 30))}`);
    }

    console.log(`\n  ${dim('Branches created:')} ${r.branchCount}`);
    for (const b of r.branchInfo) {
      const mark = b.active ? ' ← ACTIVE' : '';
      console.log(`    ${dim(`"${b.title}" — ${b.turns} turns, kw=[${b.kw}]${mark}`)}`);
    }
    console.log(`  ${dim('Total time:')} ${(totalMs / 1000).toFixed(1)}s`);
  }

  // ══════════════════════════════════════════════════════════════════
  // COMPARISON TABLE
  // ══════════════════════════════════════════════════════════════════
  console.log(bold('\n══════════════════════════════════════════════════════════════'));
  console.log(bold('  TOKEN COMPARISON: No-TreeSession vs Score vs Hybrid vs Model'));
  console.log(bold('══════════════════════════════════════════════════════════════\n'));

  console.log(`  ${'Turn'.padEnd(5)} ${'Topic'.padEnd(10)} ${'No-TS'.padStart(8)} ${'Score'.padStart(8)} ${'S-Save'.padStart(8)} ${'Hybrid'.padStart(8)} ${'H-Save'.padStart(8)} ${'Model'.padStart(8)} ${'M-Save'.padStart(8)}`);
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);

  for (let i = 0; i < CONVERSATION.length; i++) {
    const bl = baseline[i].tokens;
    const sc = results.score.perTurn[i].withTreesessionTokens;
    const hy = results.hybrid.perTurn[i].withTreesessionTokens;
    const mo = results.model.perTurn[i].withTreesessionTokens;

    const sPct = bl > 0 ? ((bl - sc) / bl * 100) : 0;
    const hPct = bl > 0 ? ((bl - hy) / bl * 100) : 0;
    const mPct = bl > 0 ? ((bl - mo) / bl * 100) : 0;

    const fmtPct = (p) => p > 0 ? green(`${p.toFixed(0)}%`.padStart(7)) : red(`${p.toFixed(0)}%`.padStart(7));

    console.log(`  ${String(i + 1).padEnd(5)} ${baseline[i].topic.padEnd(10)} ${String(bl).padStart(8)} ${String(sc).padStart(8)} ${fmtPct(sPct)} ${String(hy).padStart(8)} ${fmtPct(hPct)} ${String(mo).padStart(8)} ${fmtPct(mPct)}`);
  }

  // Summary row
  const lastBl = baseline[baseline.length - 1].tokens;
  const lastSc = results.score.perTurn[results.score.perTurn.length - 1].withTreesessionTokens;
  const lastHy = results.hybrid.perTurn[results.hybrid.perTurn.length - 1].withTreesessionTokens;
  const lastMo = results.model.perTurn[results.model.perTurn.length - 1].withTreesessionTokens;

  console.log(`\n  ${bold('Final turn (turn 20):')}`);
  console.log(`    No TreeSession:  ${bold(String(lastBl))} tokens`);
  console.log(`    Score routing:   ${bold(String(lastSc))} tokens (${green(`${((lastBl - lastSc) / lastBl * 100).toFixed(1)}% saved`)})`);
  console.log(`    Hybrid routing:  ${bold(String(lastHy))} tokens (${green(`${((lastBl - lastHy) / lastBl * 100).toFixed(1)}% saved`)})`);
  console.log(`    Model routing:   ${bold(String(lastMo))} tokens (${green(`${((lastBl - lastMo) / lastBl * 100).toFixed(1)}% saved`)})`);

  // Averages for late turns
  const late = [14, 15, 16, 17, 18, 19]; // turns 15-20 (0-indexed)
  const avgBl = late.reduce((s, i) => s + baseline[i].tokens, 0) / late.length;
  const avgSc = late.reduce((s, i) => s + results.score.perTurn[i].withTreesessionTokens, 0) / late.length;
  const avgHy = late.reduce((s, i) => s + results.hybrid.perTurn[i].withTreesessionTokens, 0) / late.length;
  const avgMo = late.reduce((s, i) => s + results.model.perTurn[i].withTreesessionTokens, 0) / late.length;

  console.log(`\n  ${bold('Avg savings (turns 15-20):')}`);
  console.log(`    Score:   ${green(`${((avgBl - avgSc) / avgBl * 100).toFixed(1)}%`)}`);
  console.log(`    Hybrid:  ${green(`${((avgBl - avgHy) / avgBl * 100).toFixed(1)}%`)}`);
  console.log(`    Model:   ${green(`${((avgBl - avgMo) / avgBl * 100).toFixed(1)}%`)}`);

  // Timing
  console.log(`\n  ${bold('Avg latency per turn:')}`);
  for (const strat of strategies) {
    const avg = results[strat].perTurn.reduce((s, t) => s + t.ms, 0) / results[strat].perTurn.length;
    console.log(`    ${strat.padEnd(8)} ${avg < 100 ? green(`${avg.toFixed(0)}ms`) : yellow(`${avg.toFixed(0)}ms`)}`);
  }

  console.log('');
}

main().catch((err) => { console.error(red(`Fatal: ${err.message}`)); console.error(err.stack); process.exit(2); });
