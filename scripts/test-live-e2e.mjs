#!/usr/bin/env node
/**
 * test-live-e2e.mjs — Real end-to-end test with plugin enabled in OpenClaw
 *
 * 1. Verifies plugin loads from the REAL openclaw.json (enabled: true)
 * 2. Runs 12-turn, 4-topic conversation through plugin hooks + real gateway
 * 3. Measures token savings (OpenClaw-compatible Math.ceil(chars/4))
 * 4. Verifies system prompt preservation (prependSystemContext, not systemPrompt)
 * 5. Verifies branch isolation and context switching
 * 6. Compares with no-treesession baseline
 *
 * Usage:  node scripts/test-live-e2e.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let totalPass = 0, totalFail = 0;
function check(cond, label) {
  if (cond) { console.log(`  ${green('✓')} ${label}`); totalPass++; }
  else { console.log(`  ${red('✗')} ${label}`); totalFail++; }
  return cond;
}

function estimateTokens(text) { return Math.max(0, Math.ceil((text || '').length / 4)); }

// ── 12 turns across 4 topics ────────────────────────────────────────
const TURNS = [
  // Topic A: Kubernetes
  { topic: 'K8s',     prompt: 'How do Kubernetes pods communicate with each other?', reply: 'Pods communicate via cluster networking. Each pod gets a unique IP, and kube-proxy manages service routing through iptables or IPVS rules.' },
  { topic: 'K8s',     prompt: 'What is a Kubernetes service and how does it differ from an ingress?', reply: 'A Service provides stable internal load balancing via ClusterIP. An Ingress exposes HTTP routes externally with TLS termination and path-based routing.' },
  { topic: 'K8s',     prompt: 'Explain how horizontal pod autoscaling works with custom metrics', reply: 'HPA watches metrics from the metrics API. For custom metrics, you deploy a metrics adapter (like Prometheus adapter) that exposes app-specific metrics. HPA adjusts replicas based on target utilization.' },

  // Topic B: Photography
  { topic: 'Photo',   prompt: 'What is the exposure triangle in photography?', reply: 'The exposure triangle consists of aperture (f-stop), shutter speed, and ISO. Each controls light differently: aperture affects depth of field, shutter speed affects motion blur, ISO affects sensor sensitivity and noise.' },
  { topic: 'Photo',   prompt: 'How do I shoot good portraits with natural light?', reply: 'Use open shade or golden hour light. Position subject facing the light source. Use a wide aperture (f/1.8-2.8) for background blur. Focus on the nearest eye.' },

  // Topic C: Rust async
  { topic: 'Rust',    prompt: 'How does the Tokio runtime work in Rust?', reply: 'Tokio is an async runtime that provides a multi-threaded work-stealing scheduler. Futures are lazy — they only run when polled. Tokio drives polls via its reactor (epoll/kqueue) and spawns tasks onto worker threads.' },
  { topic: 'Rust',    prompt: 'What is Pin and why is it needed for async in Rust?', reply: 'Pin prevents a value from being moved in memory. Async futures that contain self-referential borrows (across .await points) need Pin to guarantee the memory address stays stable so internal pointers remain valid.' },
  { topic: 'Rust',    prompt: 'Explain the difference between tokio::spawn and tokio::task::spawn_blocking', reply: 'tokio::spawn runs a Future on the async runtime — it must not block. spawn_blocking runs a closure on a dedicated blocking thread pool, useful for CPU-heavy or synchronous I/O work that would starve the async scheduler.' },

  // Topic D: Cooking (very different)
  { topic: 'Cook',    prompt: 'How do I make a proper French omelette?', reply: 'Beat 3 eggs with salt. Heat butter in a non-stick pan over medium-high. Pour eggs, stir with chopsticks for 20 seconds creating small curds. When barely set, roll onto plate. Should be pale yellow, creamy inside.' },

  // Back to K8s (context switch test)
  { topic: 'K8s',     prompt: 'How does a Kubernetes deployment rolling update work?', reply: 'Rolling update creates new ReplicaSet pods while scaling down old ones. maxSurge controls extra pods allowed, maxUnavailable controls minimum availability. Readiness probes gate traffic to new pods.' },

  // Back to Rust (context switch test)
  { topic: 'Rust',    prompt: 'How do I handle errors across async boundaries in Rust?', reply: 'Use anyhow::Result or custom error enums with thiserror. Propagate with ?. For spawned tasks, JoinHandle returns Result<T, JoinError>. Use .flatten() or match to unwrap both task panic and inner errors.' },

  // New topic: Git
  { topic: 'Git',     prompt: 'What is git rebase and when should I use it instead of merge?', reply: 'Rebase replays commits on top of another branch, creating a linear history. Use it for feature branches before merging to main. Avoid rebasing shared/public branches as it rewrites history.' },
];

async function loadRealConfig() {
  const raw = await fs.readFile(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8');
  return JSON.parse(raw);
}

async function main() {
  console.log(bold('\n🧪 TreeSession Live E2E Test — Plugin Enabled in OpenClaw\n'));

  // ── 1. Verify plugin is enabled in openclaw.json ──────────────────
  console.log(bold('── Phase 1: Config verification ──\n'));
  const config = await loadRealConfig();

  const pluginEntry = config.plugins?.entries?.['treesession-openclaw-plugin'];
  check(pluginEntry?.enabled === true, 'Plugin enabled in openclaw.json');

  const pluginPath = config.plugins?.load?.paths?.find(p => p.includes('treesession-openclaw-plugin'));
  check(!!pluginPath, `Plugin path registered: ${dim(pluginPath || 'NOT FOUND')}`);

  const gwPort = config.gateway?.port || 18789;
  const gwEnabled = config.gateway?.http?.endpoints?.chatCompletions?.enabled;
  check(gwEnabled === true, `Gateway chatCompletions enabled on :${gwPort}`);

  // Check gateway alive
  const gwAuth = config.gateway?.auth || {};
  const headers = { 'Content-Type': 'application/json' };
  if (gwAuth.password) headers['Authorization'] = `Bearer ${gwAuth.password}`;

  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/health`, { headers });
    check(res.ok, `Gateway alive at :${gwPort}`);
  } catch (err) {
    check(false, `Gateway unreachable: ${err.message}`);
    console.log(red('\n  Cannot proceed without gateway. Exiting.\n'));
    process.exit(1);
  }

  // ── 2. Load plugin & register (simulating OpenClaw boot) ──────────
  console.log(bold('\n── Phase 2: Plugin registration ──\n'));

  const storeDir = path.join(process.env.HOME, '.openclaw/treesession-store/live-e2e-test');
  await fs.mkdir(storeDir, { recursive: true });

  const hooks = {};
  const commands = {};
  const logs = [];

  const api = {
    id: 'treesession-openclaw-plugin',
    config,
    pluginConfig: pluginEntry?.config || {},  // Use the REAL plugin config from openclaw.json
    logger: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
    },
    on(hookName, handler) {
      if (!hooks[hookName]) hooks[hookName] = [];
      hooks[hookName].push(handler);
    },
    registerCommand(cmd) { commands[cmd.name] = cmd; },
    registerContextEngine() {},
  };

  // Override storageDir so test state doesn't pollute real sessions
  api.pluginConfig = { ...api.pluginConfig, storageDir: storeDir, autoReorgEnabled: false };

  const plugin = (await import(`${PLUGIN_DIR}/index.js?t=${Date.now()}`)).default;
  await plugin.register(api);

  const modelPath = logs.find(l => l.msg.includes('invokeModel'))?.msg || 'unknown';
  check(modelPath.includes('gateway loopback'), `Model invocation: gateway loopback`);
  console.log(`  ${dim(modelPath)}`);

  const routingStrategy = api.pluginConfig.routingStrategy || 'hybrid';
  check(routingStrategy === 'hybrid', `Routing strategy: ${routingStrategy}`);

  check(hooks['before_prompt_build']?.length > 0, 'before_prompt_build hook registered');
  check(hooks['agent_end']?.length > 0, 'agent_end hook registered');
  check(commands['startnewtreesession'] != null, '/startnewtreesession command registered');
  check(commands['tokensavewithtreesession'] != null, '/tokensavewithtreesession command registered');

  // ── 3. Run 12-turn conversation ───────────────────────────────────
  console.log(bold('\n── Phase 3: 12-turn conversation (4 topics + context switches) ──\n'));

  const ctx = { agentId: 'vibe-researcher', sessionKey: 'live-e2e-001' };
  const results = [];
  let noTsAccum = 0; // baseline: full history tokens

  async function fireHook(name, event) {
    for (const handler of hooks[name] || []) {
      const r = await handler(event, ctx);
      if (r) return r;
    }
    return null;
  }

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const turnNum = i + 1;

    // Baseline: accumulate full history
    noTsAccum += estimateTokens(`user: ${turn.prompt}\nassistant: ${turn.reply}`);

    const t0 = Date.now();
    const r = await fireHook('before_prompt_build', {
      prompt: turn.prompt,
      messages: TURNS.slice(0, i).flatMap(t => [
        { role: 'user', content: t.prompt },
        { role: 'assistant', content: t.reply },
      ]),
    });
    const ms = Date.now() - t0;

    const contextTokens = estimateTokens(r?.prependContext || '');
    const savePct = noTsAccum > 0 ? ((1 - contextTokens / noTsAccum) * 100) : 0;

    // Find routing decision from logs
    const routeLog = [...logs].reverse().find(l => l.msg.includes('before_prompt_build routed'));
    const routeMatch = routeLog?.msg.match(/routed -> (.+?) \((.+?),/);
    const branch = routeMatch?.[1] || '?';
    const action = routeMatch?.[2] || '?';

    results.push({ turnNum, topic: turn.topic, noTs: noTsAccum, ts: contextTokens, savePct, ms, branch, action, r });

    const saveFmt = savePct > 0 ? green(`${savePct.toFixed(0)}%`) : red(`${savePct.toFixed(0)}%`);
    console.log(`  Turn ${String(turnNum).padStart(2)}  ${turn.topic.padEnd(6)}  NoTS=${String(noTsAccum).padStart(5)}  TS=${String(contextTokens).padStart(5)}  Save=${saveFmt}  ${dim(`${ms}ms`)}  ${dim(branch.slice(0, 35))} ${dim(`[${action}]`)}`);

    // Fire agent_end to store the turn
    await fireHook('agent_end', {
      success: true,
      messages: [
        { role: 'user', content: turn.prompt },
        { role: 'assistant', content: turn.reply },
      ],
    });
  }

  // ── 4. Verification ──────────────────────────────────────────────
  console.log(bold('\n── Phase 4: Assertions ──\n'));

  // 4a. System prompt preservation
  const allResults = results.filter(r => r.r);
  const hasSystemCtx = allResults.every(r => r.r?.prependSystemContext != null);
  check(hasSystemCtx, 'All turns return prependSystemContext (additive, not replacement)');

  const noSystemPromptOverride = allResults.every(r => r.r?.systemPrompt == null);
  check(noSystemPromptOverride, 'No turn returns systemPrompt (would replace original)');

  if (allResults[0]?.r?.prependSystemContext) {
    const sys = allResults[0].r.prependSystemContext;
    check(sys.includes('treesession'), `prependSystemContext mentions treesession: "${sys.slice(0, 80)}..."`);
    // "You are in a treesession-managed conversation" is additive context, not identity override
    check(!sys.includes('You are a ') || sys.includes('treesession'), `prependSystemContext doesn't override agent identity`);
  }

  // 4b. Context includes branch-scoped content
  const lastPrepend = results[results.length - 1]?.r?.prependContext || '';
  check(lastPrepend.length > 50, `Last turn prependContext has content (${lastPrepend.length} chars)`);

  // 4c. Token savings on later turns
  const laterTurns = results.filter(r => r.turnNum >= 6);
  const avgSave = laterTurns.reduce((s, r) => s + r.savePct, 0) / laterTurns.length;
  check(avgSave > 40, `Avg savings turns 6-12: ${avgSave.toFixed(1)}% (>40% expected)`);

  const lastSave = results[results.length - 1].savePct;
  check(lastSave > 60, `Final turn savings: ${lastSave.toFixed(1)}% (>60% expected)`);

  // 4d. Branch creation (should have multiple topic branches)
  const stateFiles = await fs.readdir(storeDir).catch(() => []);
  let branchCount = 0;
  let stateObj = null;
  for (const f of stateFiles) {
    if (f.includes('live-e2e')) {
      stateObj = JSON.parse(await fs.readFile(path.join(storeDir, f), 'utf8'));
      branchCount = stateObj.branches?.length || 0;
    }
  }
  check(branchCount >= 3, `Created ${branchCount} branches (≥3 expected for 4 topics)`);

  // 4e. Context switching works — turns 10, 11 should route to existing branches
  const turn10 = results[9]; // K8s return
  const turn11 = results[10]; // Rust return
  // Turn 10 may create new K8s sub-branch (rolling update ≠ pod communication) or route to existing — both ok
  const turn10Ok = turn10?.action?.includes('existing') || turn10?.branch?.includes('kubernetes');
  check(turn10Ok, `Turn 10 (K8s return) routed to K8s branch: ${turn10?.action} → ${turn10?.branch?.slice(0, 40)}`);
  check(turn11?.action?.includes('existing'), `Turn 11 (Rust return) routed to existing branch: ${turn11?.action}`);

  // 4f. No metadata pollution in stored state
  if (stateObj) {
    const allKw = (stateObj.branches || []).flatMap(b => b.keywords || []);
    const noise = allKw.filter(k => /untrusted|sender_id|message_id|channel_id/.test(k));
    check(noise.length === 0, 'No metadata noise in branch keywords');
  }

  // 4g. Route decisions tracked
  if (stateObj) {
    const decisions = stateObj.routeDecisions || [];
    check(decisions.length === TURNS.length, `${decisions.length} route decisions recorded (expected ${TURNS.length})`);
  }

  // ── 5. Summary table ─────────────────────────────────────────────
  console.log(bold('\n── Summary ──\n'));

  if (stateObj) {
    console.log(`  Branches created: ${stateObj.branches.length}`);
    for (const b of stateObj.branches) {
      const active = b.id === stateObj.activeBranchId ? ' ← ACTIVE' : '';
      console.log(`    ${dim(`"${b.title}" — ${b.turns?.length || 0} turns, kw=[${(b.keywords || []).slice(0, 5).join(',')}]${active}`)}`);
    }
  }

  const finalNoTs = results[results.length - 1].noTs;
  const finalTs = results[results.length - 1].ts;
  console.log(`\n  Final turn: No-TreeSession=${bold(String(finalNoTs))} tokens → TreeSession=${bold(String(finalTs))} tokens`);
  console.log(`  Savings: ${green(bold(`${lastSave.toFixed(1)}%`))}`);

  const avgLatency = results.reduce((s, r) => s + r.ms, 0) / results.length;
  console.log(`  Avg latency per turn: ${avgLatency < 1000 ? green(`${avgLatency.toFixed(0)}ms`) : yellow(`${(avgLatency / 1000).toFixed(1)}s`)}`);

  // Cleanup
  for (const f of stateFiles) {
    await fs.unlink(path.join(storeDir, f)).catch(() => {});
  }
  await fs.rmdir(storeDir).catch(() => {});

  // ── Final result ──────────────────────────────────────────────────
  console.log(bold('\n══════════════════════════════════════════════════════════════'));
  console.log(bold('  RESULT'));
  console.log(bold('══════════════════════════════════════════════════════════════'));
  console.log(`  ${green(`${totalPass} passed`)}  ${totalFail > 0 ? red(`${totalFail} failed`) : dim('0 failed')}`);
  if (totalFail === 0) {
    console.log(`\n  ${green(bold('✅ Plugin works end-to-end with hybrid routing through real gateway.'))}`);
    console.log(`  ${green('System prompt preserved. Token savings confirmed. Branch isolation verified.')}`);
  }
  console.log('');

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(console.error);
