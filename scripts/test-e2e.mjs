#!/usr/bin/env node
/**
 * test-e2e.mjs — Full end-to-end treesession plugin test
 *
 * Simulates a realistic OpenClaw plugin lifecycle:
 *  1. Plugin import + register (no crash)
 *  2. Multi-topic conversation over 10+ turns
 *  3. Branch creation, switching, return-to-topic
 *  4. Commands: visualize, token report, new branch, resume
 *  5. State persistence and reload
 *  6. Context output sanity (prependContext, prependSystemContext)
 *  7. Gateway model invocation path resolution
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

let totalPass = 0, totalFail = 0;
function check(condition, label) {
  if (condition) { console.log(`  ${green('✓')} ${label}`); totalPass++; }
  else { console.log(`  ${red('✗')} ${label}`); totalFail++; }
  return condition;
}

// ── Load real openclaw.json ──────────────────────────────────────────
async function loadRealConfig() {
  const raw = await fs.readFile(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8');
  return JSON.parse(raw);
}

// ── Build mock API that mirrors what OpenClaw passes to plugins ──────
function buildMockApi(config, storeDir) {
  const hooks = {};
  const commands = {};
  const logs = [];

  const api = {
    id: 'treesession-openclaw-plugin',
    name: 'treesession OpenClaw Plugin',
    config,
    pluginConfig: {
      enabled: true,
      storageDir: storeDir,
      routingStrategy: 'score',
      branchNamingMode: 'keyword',
      autoReorgEnabled: false,
    },
    logger: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
      debug: (msg) => logs.push({ level: 'debug', msg }),
    },
    on(hookName, handler, opts) {
      if (!hooks[hookName]) hooks[hookName] = [];
      hooks[hookName].push({ handler, priority: opts?.priority || 0 });
    },
    registerCommand(cmd) { commands[cmd.name] = cmd; },
    registerContextEngine() {},
  };

  return { api, hooks, commands, logs };
}

async function fireHook(hooks, hookName, event, ctx) {
  for (const { handler } of hooks[hookName] || []) {
    const r = await handler(event, ctx);
    if (r) return r;
  }
  return null;
}

async function fireCommand(commands, name, cmdCtx) {
  if (!commands[name]) return null;
  return commands[name].handler(cmdCtx);
}

// ── Cleanup helper ───────────────────────────────────────────────────
async function cleanDir(dir) {
  try {
    const files = await fs.readdir(dir);
    for (const f of files) await fs.unlink(path.join(dir, f)).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════
// TEST SECTIONS
// ══════════════════════════════════════════════════════════════════════

async function testImportAndRegister(config, storeDir) {
  console.log(bold('\n── 1. Import & Register ──'));

  let plugin;
  try {
    plugin = (await import(`${PLUGIN_DIR}/index.js?t=${Date.now()}`)).default;
    check(true, 'Plugin imported successfully');
  } catch (err) {
    check(false, `Plugin import failed: ${err.message}`);
    return null;
  }

  check(typeof plugin.register === 'function', 'plugin.register is a function');
  check(plugin.id === 'treesession-openclaw-plugin', `plugin.id = "${plugin.id}"`);
  check(plugin.kind === 'lifecycle', `plugin.kind = "${plugin.kind}"`);

  const { api, hooks, commands, logs } = buildMockApi(config, storeDir);

  try {
    await plugin.register(api);
    check(true, 'plugin.register() completed without error');
  } catch (err) {
    check(false, `plugin.register() threw: ${err.message}`);
    return null;
  }

  check(hooks['before_agent_start']?.length > 0, 'before_agent_start hook registered');
  check(hooks['before_prompt_build']?.length > 0, 'before_prompt_build hook registered');
  check(hooks['agent_end']?.length > 0, 'agent_end hook registered');
  check(commands['startnewtreesession'] != null, 'startnewtreesession command registered');
  check(commands['tokensavewithtreesession'] != null, 'tokensavewithtreesession command registered');

  // Check model invocation path
  const modelLog = logs.find((l) => l.msg.includes('invokeModel'));
  if (modelLog) {
    console.log(`  ${dim(modelLog.msg)}`);
    check(true, 'Model invocation path resolved');
  } else {
    check(false, 'No model invocation path logged');
  }

  return { hooks, commands, logs };
}

async function testMultiTopicConversation(hooks, storeDir) {
  console.log(bold('\n── 2. Multi-topic Conversation (10 turns) ──'));

  const ctx = { agentId: 'test-e2e', sessionKey: 'e2e-test-session', sessionId: 'e2e-001' };

  const turns = [
    // Topic A: Machine learning
    { user: 'explain how gradient descent works in neural networks', assistant: 'Gradient descent updates weights by computing the gradient of the loss function and stepping in the negative direction.' },
    { user: 'what about learning rate scheduling?', assistant: 'Learning rate schedules reduce the step size over training — cosine annealing and step decay are common approaches.' },
    { user: 'how does Adam optimizer differ from SGD?', assistant: 'Adam maintains per-parameter adaptive learning rates using first and second moment estimates, while SGD uses a fixed rate.' },

    // Topic B: Cooking (clearly different)
    { user: 'what is a good recipe for pasta carbonara?', assistant: 'Classic carbonara uses guanciale, pecorino romano, eggs, black pepper, and spaghetti. No cream needed.' },
    { user: 'how do I prevent the eggs from scrambling?', assistant: 'Temper the egg mixture by slowly adding hot pasta water while whisking. Remove the pan from heat before tossing.' },

    // Topic C: Travel
    { user: 'what are the best places to visit in Japan during cherry blossom season?', assistant: 'Kyoto (Philosopher Path), Tokyo (Ueno Park), Osaka Castle, and Yoshino mountain are top spots for hanami.' },

    // Back to Topic A
    { user: 'going back to neural networks, what is batch normalization?', assistant: 'Batch norm normalizes layer inputs across the mini-batch, reducing internal covariate shift and allowing higher learning rates.' },

    // Topic B again
    { user: 'what other Italian pasta dishes should I try?', assistant: 'Try cacio e pepe (pecorino + pepper), amatriciana (tomato + guanciale), and aglio e olio (garlic + olive oil).' },

    // Topic D: Programming
    { user: 'how do JavaScript closures work?', assistant: 'A closure captures variables from its lexical scope. The inner function retains access to outer variables even after the outer function returns.' },
    { user: 'what about the event loop in Node.js?', assistant: 'Node uses a single-threaded event loop with libuv. Async I/O callbacks are queued and processed in phases: timers, poll, check, close.' },
  ];

  const results = [];
  for (let i = 0; i < turns.length; i++) {
    const { user, assistant } = turns[i];
    const t0 = Date.now();

    // before_prompt_build
    const r = await fireHook(hooks, 'before_prompt_build', {
      prompt: user,
      messages: i > 0 ? [{ role: 'user', content: turns[i-1].user }, { role: 'assistant', content: turns[i-1].assistant }] : [],
    }, ctx);
    const ms = Date.now() - t0;

    const ok = r?.prependContext != null;
    results.push({ ok, ms, user: user.slice(0, 50) });

    // agent_end
    await fireHook(hooks, 'agent_end', {
      success: true,
      messages: [
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ],
    }, ctx);
  }

  for (const r of results) {
    check(r.ok, `"${r.user}..." → ${r.ms}ms`);
  }

  // Check all turns were fast (score routing should be <50ms)
  const maxMs = Math.max(...results.map((r) => r.ms));
  check(maxMs < 200, `All turns under 200ms (max was ${maxMs}ms)`);

  return ctx;
}

async function testStateIntegrity(storeDir) {
  console.log(bold('\n── 3. State Integrity ──'));

  const files = await fs.readdir(storeDir);
  const stateFile = files.find((f) => f.includes('e2e-test-session'));
  check(stateFile != null, `State file exists: ${stateFile}`);

  if (!stateFile) return null;

  const state = JSON.parse(await fs.readFile(path.join(storeDir, stateFile), 'utf8'));

  check(state.branches?.length >= 1, `Has ${state.branches?.length} branch(es)`);
  check(state.activeBranchId != null && state.activeBranchId !== '', `Active branch set: ${state.activeBranchId}`);
  check(state.routeDecisions?.length === 10, `10 route decisions recorded (got ${state.routeDecisions?.length})`);
  check(state.routeTurnCounter === 10, `Turn counter = ${state.routeTurnCounter}`);

  // Check no metadata pollution
  const allKw = state.branches.flatMap((b) => b.keywords || []);
  const noiseKw = allKw.filter((k) => /untrusted|sender_id|message_id|channel_id/.test(k));
  check(noiseKw.length === 0, 'Keywords clean — no metadata noise');

  // Check confidence values
  const decisions = state.routeDecisions || [];
  const allHalf = decisions.length > 2 && decisions.every((d) => d.confidence === 0.5);
  check(!allHalf, 'Route decisions have varied confidence (not all 0.5)');

  // Check turn content was stored
  const totalTurns = state.branches.reduce((sum, b) => sum + (b.turns?.length || 0), 0);
  check(totalTurns >= 10, `Total stored turns: ${totalTurns} (expected ≥10)`);

  // Print branch summary
  console.log(`\n  ${dim('Branches:')}`);
  for (const b of state.branches) {
    const active = b.id === state.activeBranchId ? ' ← ACTIVE' : '';
    console.log(`    ${dim(`"${b.title}" — ${b.turns?.length || 0} turns, kw=[${(b.keywords || []).slice(0, 5).join(',')}]${active}`)}`);
  }

  // Print route decision trace
  console.log(`\n  ${dim('Route decisions:')}`);
  for (const d of decisions) {
    console.log(`    ${dim(`turn ${d.turn}: → "${d.title}" (${d.action}, conf=${d.confidence.toFixed(3)})`)}`);
  }

  return state;
}

async function testContextOutput(hooks) {
  console.log(bold('\n── 4. Context Output Quality ──'));

  const ctx = { agentId: 'test-e2e', sessionKey: 'e2e-test-session', sessionId: 'e2e-001' };

  const r = await fireHook(hooks, 'before_prompt_build', {
    prompt: 'tell me more about gradient descent variants',
    messages: [],
  }, ctx);

  check(r?.prependContext != null, 'prependContext returned');
  check(r?.prependSystemContext != null, 'prependSystemContext returned');

  if (r?.prependContext) {
    const len = r.prependContext.length;
    check(len > 50, `prependContext has content (${len} chars)`);
    check(len < 12000, `prependContext within bounds (${len} < 12000 chars)`);

    // Should contain branch context header
    check(
      r.prependContext.includes('treesession') || r.prependContext.includes('branch') || r.prependContext.includes('context'),
      'prependContext contains context markers'
    );

    console.log(`\n  ${dim('prependContext preview (first 300 chars):')}`);
    console.log(`    ${dim(r.prependContext.slice(0, 300).replace(/\n/g, '\n    '))}`);
  }

  if (r?.prependSystemContext) {
    check(r.prependSystemContext.includes('treesession'), 'prependSystemContext mentions treesession');
    check(r.prependSystemContext.includes('branch'), 'prependSystemContext mentions branching');
    console.log(`\n  ${dim('prependSystemContext:')}`);
    console.log(`    ${dim(r.prependSystemContext)}`);
  }
}

async function testCommands(hooks, commands) {
  console.log(bold('\n── 5. Commands ──'));

  const ctx = { agentId: 'test-e2e', sessionKey: 'e2e-test-session', sessionId: 'e2e-001' };

  // Test visualize via before_agent_start
  const vizResult = await fireHook(hooks, 'before_agent_start', {
    prompt: 'visualizesessiontree',
    messages: [],
  }, ctx);
  check(vizResult?.prependContext?.includes('mermaid') || vizResult?.prependContext?.includes('Mermaid'), 'visualizesessiontree returns mermaid diagram');

  // Test token report via before_agent_start
  const tokenResult = await fireHook(hooks, 'before_agent_start', {
    prompt: 'tokensavewithtreesession',
    messages: [],
  }, ctx);
  if (tokenResult?.prependContext) {
    check(tokenResult.prependContext.includes('token'), 'tokensavewithtreesession returns token report');
  } else {
    // Try via command
    const cmdResult = await fireCommand(commands, 'tokensavewithtreesession', {
      sessionKey: 'e2e-test-session',
      channel: 'test',
      senderId: 'user1',
    });
    check(cmdResult?.text?.includes('token'), 'tokensavewithtreesession command returns token report');
  }

  // Test auto routing toggle
  const autoOff = await fireHook(hooks, 'before_agent_start', {
    prompt: 'autosessionbranch: off',
    messages: [],
  }, ctx);
  check(autoOff?.prependContext?.toLowerCase().includes('off'), 'autosessionbranch off works');

  const autoOn = await fireHook(hooks, 'before_agent_start', {
    prompt: 'autosessionbranch: on',
    messages: [],
  }, ctx);
  check(autoOn?.prependContext?.toLowerCase().includes('on'), 'autosessionbranch on works');

  // Test manual branch creation
  const newBranch = await fireHook(hooks, 'before_agent_start', {
    prompt: 'newsessionbranch: my-custom-topic',
    messages: [],
  }, ctx);
  check(newBranch?.prependContext != null, 'newsessionbranch creates a new branch');

  // Test resume
  const resume = await fireHook(hooks, 'before_agent_start', {
    prompt: 'resumesessionbranch: my-custom-topic',
    messages: [],
  }, ctx);
  check(resume?.prependContext != null, 'resumesessionbranch switches to branch');
}

async function testStartNewTreeSession(commands) {
  console.log(bold('\n── 6. startnewtreesession Command ──'));

  const result = await fireCommand(commands, 'startnewtreesession', {
    sessionKey: 'e2e-test-session',
    agentId: 'test-e2e',
    channel: 'test',
    senderId: 'user1',
    args: 'fresh start',
  });

  check(result?.text?.includes('Started new treesession'), `Command result: "${result?.text?.slice(0, 80)}"`);
}

async function testStateReload(hooks, storeDir) {
  console.log(bold('\n── 7. State Reload (Persistence) ──'));

  const ctx = { agentId: 'test-e2e', sessionKey: 'e2e-test-session', sessionId: 'e2e-001' };

  // After startnewtreesession, the state was reset. Send a turn to create fresh state.
  const r1 = await fireHook(hooks, 'before_prompt_build', {
    prompt: 'testing state persistence after reload',
    messages: [],
  }, ctx);
  check(r1?.prependContext != null, 'Turn after reset returns prependContext');

  await fireHook(hooks, 'agent_end', {
    success: true,
    messages: [
      { role: 'user', content: 'testing state persistence after reload' },
      { role: 'assistant', content: 'State persistence confirmed.' },
    ],
  }, ctx);

  // Verify state file was written
  const files = await fs.readdir(storeDir);
  const stateFile = files.find((f) => f.includes('e2e-test-session'));
  check(stateFile != null, 'State file persisted after reset + turn');

  if (stateFile) {
    const state = JSON.parse(await fs.readFile(path.join(storeDir, stateFile), 'utf8'));
    const totalTurns = state.branches.reduce((sum, b) => sum + (b.turns?.length || 0), 0);
    check(totalTurns >= 1, `State has ${totalTurns} turn(s) after reload`);
  }
}

async function testGatewayResolution(config) {
  console.log(bold('\n── 8. Gateway Model Resolution ──'));

  const gwEnabled = config.gateway?.http?.endpoints?.chatCompletions?.enabled;
  check(gwEnabled === true, 'Gateway chatCompletions enabled');

  const agentModel = config.agents?.defaults?.model?.primary;
  check(agentModel != null, `Agent primary model: ${agentModel}`);

  // Verify gateway is alive
  const port = config.gateway?.port || 18789;
  const password = config.gateway?.auth?.password || '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: password ? { Authorization: `Bearer ${password}` } : {},
    });
    check(res.ok, `Gateway alive at :${port}`);
  } catch {
    check(false, `Gateway unreachable at :${port}`);
  }

  // Verify plugin resolves to gateway (not external)
  const storeDir = path.join(process.env.HOME, '.openclaw/treesession-store/e2e-gw-check');
  const { api, logs } = buildMockApi(config, storeDir);
  const plugin = (await import(`${PLUGIN_DIR}/index.js?t=${Date.now() + 1}`)).default;
  await plugin.register(api);

  const gwLog = logs.find((l) => l.msg.includes('gateway loopback'));
  check(gwLog != null, 'Plugin resolved to gateway loopback');

  if (gwLog) {
    check(gwLog.msg.includes(agentModel), `Gateway uses same agent model: ${agentModel}`);
  }

  const noExternal = !logs.some((l) => l.msg.includes('openai.com') || l.msg.includes('external'));
  check(noExternal, 'No external API references in logs');

  await cleanDir(storeDir);
}

async function testEdgeCases(hooks) {
  console.log(bold('\n── 9. Edge Cases ──'));

  const ctx = { agentId: 'test-e2e', sessionKey: 'e2e-edge-cases', sessionId: 'e2e-edge' };

  // Empty prompt
  const r1 = await fireHook(hooks, 'before_prompt_build', { prompt: '', messages: [] }, ctx);
  check(r1 == null, 'Empty prompt returns null (no routing)');

  // Very short prompt
  const r2 = await fireHook(hooks, 'before_prompt_build', { prompt: 'hi', messages: [] }, ctx);
  check(r2?.prependContext != null || r2 == null, 'Short prompt handled gracefully');

  // Prompt with metadata envelope
  const r3 = await fireHook(hooks, 'before_prompt_build', {
    prompt: 'Conversation info (untrusted metadata):\n```json\n{"sender_id":"123"}\n```\nWhat is Python?',
    messages: [],
  }, ctx);
  check(r3?.prependContext != null, 'Prompt with metadata envelope handled');

  // Very long prompt
  const longPrompt = 'explain ' + 'very '.repeat(500) + 'long topic about machine learning';
  const r4 = await fireHook(hooks, 'before_prompt_build', { prompt: longPrompt, messages: [] }, ctx);
  check(r4?.prependContext != null, 'Very long prompt handled');

  // Unicode prompt
  const r5 = await fireHook(hooks, 'before_prompt_build', {
    prompt: '用中文解释什么是机器学习？',
    messages: [],
  }, ctx);
  check(r5?.prependContext != null, 'Unicode prompt handled');
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(bold('\n🌲 TreeSession Plugin — Full End-to-End Test\n'));

  const config = await loadRealConfig();
  const storeDir = path.join(process.env.HOME, '.openclaw/treesession-store/test-e2e');
  await fs.mkdir(storeDir, { recursive: true });
  await cleanDir(storeDir);
  await fs.mkdir(storeDir, { recursive: true });

  // 1. Import & Register
  const reg = await testImportAndRegister(config, storeDir);
  if (!reg) {
    console.log(red('\nPlugin failed to register. Cannot continue.'));
    process.exit(1);
  }

  // 2. Multi-topic conversation
  await testMultiTopicConversation(reg.hooks, storeDir);

  // 3. State integrity
  await testStateIntegrity(storeDir);

  // 4. Context output quality
  await testContextOutput(reg.hooks);

  // 5. Commands
  await testCommands(reg.hooks, reg.commands);

  // 6. startnewtreesession
  await testStartNewTreeSession(reg.commands);

  // 7. State reload
  await testStateReload(reg.hooks, storeDir);

  // 8. Gateway resolution
  await testGatewayResolution(config);

  // 9. Edge cases
  await testEdgeCases(reg.hooks);

  // Cleanup
  await cleanDir(storeDir);

  // Results
  console.log(bold('\n══════════════════════════════════════════════════════════════'));
  console.log(bold('  END-TO-END RESULT'));
  console.log(bold('══════════════════════════════════════════════════════════════'));
  console.log(`  ${green(`${totalPass} passed`)}  ${totalFail > 0 ? red(`${totalFail} failed`) : dim('0 failed')}`);

  if (totalFail === 0) {
    console.log(`\n  ${green(bold('ALL TESTS PASSED — Plugin is ready for production.'))}`);
  } else {
    console.log(`\n  ${red(`${totalFail} test(s) need attention.`)}`);
  }
  console.log('');

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(red(`\nFatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(2);
});
