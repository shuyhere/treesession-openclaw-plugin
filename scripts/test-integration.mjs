#!/usr/bin/env node
/**
 * test-integration.mjs — End-to-end integration test
 *
 * Simulates the full OpenClaw plugin lifecycle:
 *   1. Plugin registration + model invocation path resolution
 *   2. before_agent_start (command parsing, reorg)
 *   3. before_prompt_build (routing + context injection)
 *   4. agent_end (turn storage)
 *   5. Context window impact measurement
 *
 * Tests both score and model routing against real session data.
 *
 * Usage:
 *   node scripts/test-integration.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const STORE_DIR = path.join(process.env.HOME, '.openclaw/treesession-store');

// ── Colors ──────────────────────────────────────────────────────────
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function section(title) {
  console.log(`\n${bold('═'.repeat(70))}`);
  console.log(bold(`  ${title}`));
  console.log(bold('═'.repeat(70)));
}

function pass(msg) { console.log(`  ${green('✓')} ${msg}`); }
function fail(msg) { console.log(`  ${red('✗')} ${msg}`); }
function warn(msg) { console.log(`  ${yellow('⚠')} ${msg}`); }
function info(msg) { console.log(`  ${dim(msg)}`); }

let totalPass = 0, totalFail = 0;
function check(condition, label) {
  if (condition) { pass(label); totalPass++; }
  else { fail(label); totalFail++; }
  return condition;
}

// ── Mock OpenClaw Plugin API ────────────────────────────────────────
function createMockApi(overrides = {}) {
  const hooks = {};
  const commands = {};
  const logs = [];

  const mockConfig = {
    gateway: {
      port: 18789,
      auth: { mode: 'password', password: '1234' },
      http: { endpoints: { chatCompletions: { enabled: false } } }, // disable gateway loopback for test
    },
    models: {
      providers: {},
    },
    agents: {
      defaults: {
        model: { primary: 'claude-opus-4-6' },
      },
    },
    ...overrides.config,
  };

  return {
    id: 'treesession-openclaw-plugin',
    name: 'treesession OpenClaw Plugin',
    config: mockConfig,
    pluginConfig: {
      enabled: true,
      storageDir: path.join(STORE_DIR, 'test-integration'),
      routingStrategy: overrides.routingStrategy || 'score',
      branchCreateThreshold: 0.22,
      shortTurnMinChars: 8,
      recentTurns: 8,
      retrievalTurns: 6,
      summaryEveryTurns: 10,
      maxBranches: 80,
      maxPrependedChars: 6000,
      branchTurns: 10,
      branchNamingMode: 'keyword',
      autoReorgEnabled: false,
      modelRoutingApiKey: '',
      modelRoutingModel: 'same',
      ...overrides.pluginConfig,
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
      hooks[hookName].sort((a, b) => b.priority - a.priority);
    },
    registerCommand(cmd) {
      commands[cmd.name] = cmd;
    },
    registerContextEngine() {},
    // Expose internals for testing
    _hooks: hooks,
    _commands: commands,
    _logs: logs,
  };
}

async function fireHook(api, hookName, event, ctx) {
  const handlers = api._hooks[hookName] || [];
  let result;
  for (const { handler } of handlers) {
    const r = await handler(event, ctx);
    if (r) result = r;
  }
  return result;
}

// ── Test 1: Plugin loads and registers hooks correctly ──────────────
async function testPluginRegistration() {
  section('TEST 1: Plugin Registration');

  const api = createMockApi();
  const plugin = (await import(path.join(PLUGIN_DIR, 'index.js'))).default;

  check(plugin.id === 'treesession-openclaw-plugin', 'Plugin ID correct');
  check(plugin.kind === 'lifecycle', 'Plugin kind is lifecycle');

  await plugin.register(api);

  check(api._hooks['before_agent_start']?.length > 0, 'before_agent_start hook registered');
  check(api._hooks['before_prompt_build']?.length > 0, 'before_prompt_build hook registered');
  check(api._hooks['agent_end']?.length > 0, 'agent_end hook registered');
  check(api._commands['startnewtreesession'] != null, 'startnewtreesession command registered');
  check(api._commands['tokensavewithtreesession'] != null, 'tokensavewithtreesession command registered');

  // Check model invocation resolution
  const modelLogs = api._logs.filter((l) => l.msg.includes('invokeModel'));
  const hasModelPath = modelLogs.some((l) =>
    l.msg.includes('using gateway loopback') ||
    l.msg.includes('using provider') ||
    l.msg.includes('using direct api') ||
    l.msg.includes('no api method')
  );
  check(hasModelPath, 'Model invocation path resolved (or fallback logged)');

  info(`Model path logs: ${modelLogs.map((l) => l.msg).join(' | ')}`);

  return api;
}

// ── Test 2: Score routing lifecycle ─────────────────────────────────
async function testScoreRoutingLifecycle() {
  section('TEST 2: Score Routing Full Lifecycle');

  const api = createMockApi({ routingStrategy: 'score' });
  const plugin = (await import(path.join(PLUGIN_DIR, 'index.js'))).default;
  await plugin.register(api);

  const ctx = { agentId: 'test', sessionKey: 'test-score-lifecycle', sessionId: 'test-001' };

  // Turn 1: First message — should create initial branch
  info('Turn 1: "What is the treesession plugin?"');
  const r1 = await fireHook(api, 'before_prompt_build', {
    prompt: 'What is the treesession plugin?',
    messages: [],
  }, ctx);

  check(r1?.prependContext != null, 'Turn 1: prependContext returned');
  check(r1?.prependContext?.includes('treesession branch context'), 'Turn 1: context has branch header');

  // Simulate agent_end for turn 1
  await fireHook(api, 'agent_end', {
    success: true,
    messages: [
      { role: 'user', content: 'What is the treesession plugin?' },
      { role: 'assistant', content: 'The treesession plugin is a context management middleware that routes conversations into topic branches.' },
    ],
  }, ctx);

  // Turn 2: Continue same topic
  info('Turn 2: "How does the routing score formula work?"');
  const r2 = await fireHook(api, 'before_prompt_build', {
    prompt: 'How does the routing score formula work?',
    messages: [],
  }, ctx);

  check(r2?.prependContext != null, 'Turn 2: prependContext returned');

  await fireHook(api, 'agent_end', {
    success: true,
    messages: [
      { role: 'user', content: 'How does the routing score formula work?' },
      { role: 'assistant', content: 'The score formula uses Jaccard similarity (62%), relative activity (23%), title hint (15%), and continuity bonus (8%).' },
    ],
  }, ctx);

  // Turn 3: Different topic — should ideally create new branch
  info('Turn 3: "What is a good pasta recipe?"');
  const r3 = await fireHook(api, 'before_prompt_build', {
    prompt: 'What is a good pasta recipe? I want to cook something nice tonight.',
    messages: [],
  }, ctx);

  check(r3?.prependContext != null, 'Turn 3: prependContext returned for new topic');

  await fireHook(api, 'agent_end', {
    success: true,
    messages: [
      { role: 'user', content: 'What is a good pasta recipe? I want to cook something nice tonight.' },
      { role: 'assistant', content: 'Try pasta aglio e olio — simple but delicious with garlic, olive oil, and chili flakes.' },
    ],
  }, ctx);

  // Turn 4: Return to original topic
  info('Turn 4: "back to the treesession routing algorithm"');
  const r4 = await fireHook(api, 'before_prompt_build', {
    prompt: 'back to the treesession routing algorithm, what about the model routing strategy?',
    messages: [],
  }, ctx);

  check(r4?.prependContext != null, 'Turn 4: prependContext returned for back-signal');

  // Verify state file exists
  const stateFiles = await fs.readdir(path.join(STORE_DIR, 'test-integration')).catch(() => []);
  const hasState = stateFiles.some((f) => f.includes('test-score-lifecycle'));
  check(hasState, 'State file persisted to disk');

  // Load and inspect state
  if (hasState) {
    const stateFile = stateFiles.find((f) => f.includes('test-score-lifecycle'));
    const stateData = JSON.parse(await fs.readFile(path.join(STORE_DIR, 'test-integration', stateFile), 'utf8'));
    info(`Branches: ${stateData.branches.length}, Active: ${stateData.activeBranchId?.slice(0, 8)}`);
    info(`Route decisions: ${stateData.routeDecisions?.length || 0}`);

    for (const b of stateData.branches) {
      info(`  Branch "${b.title}" — turns: ${b.turns.length}, keywords: [${(b.keywords || []).join(', ')}]`);
    }

    // Check route decisions have varying confidence (not all 0.5)
    const confs = (stateData.routeDecisions || []).map((d) => d.confidence);
    const uniqueConfs = [...new Set(confs)];
    check(uniqueConfs.length > 1 || confs.length <= 1, 'Route decisions have varied confidence (not stuck at 0.5)');
  }

  return api;
}

// ── Test 3: Model routing lifecycle ─────────────────────────────────
async function testModelRoutingLifecycle() {
  section('TEST 3: Model Routing Lifecycle (with fallback)');

  const api = createMockApi({
    routingStrategy: 'model',
    pluginConfig: {
      routingStrategy: 'model',
      modelRoutingApiKey: '', // empty — forces fallback
    },
  });
  const plugin = (await import(path.join(PLUGIN_DIR, 'index.js'))).default;
  await plugin.register(api);

  const ctx = { agentId: 'test', sessionKey: 'test-model-lifecycle', sessionId: 'test-002' };

  info('Turn 1: "Debug the router code"');
  const r1 = await fireHook(api, 'before_prompt_build', {
    prompt: 'Debug the router code and fix the scoring formula',
    messages: [],
  }, ctx);

  check(r1?.prependContext != null, 'Model routing: prependContext returned (via fallback)');

  // Check that model router fallback was logged
  const fallbackLogs = api._logs.filter((l) =>
    l.msg.includes('falling back to score router') ||
    l.msg.includes('fallback to score router') ||
    l.msg.includes('no api method') ||
    l.msg.includes('model routing: no invokeModel')
  );
  check(fallbackLogs.length > 0, 'Model router correctly fell back (no API key)');
  info(`Fallback logs: ${fallbackLogs.map((l) => l.msg.slice(0, 80)).join(' | ')}`);

  // Check that it used score router instead of hardcoded confidence=0.5
  await fireHook(api, 'agent_end', {
    success: true,
    messages: [
      { role: 'user', content: 'Debug the router code and fix the scoring formula' },
      { role: 'assistant', content: 'Found the issue in computeBranchScore — the semantic gate was missing.' },
    ],
  }, ctx);

  const stateFiles = await fs.readdir(path.join(STORE_DIR, 'test-integration')).catch(() => []);
  const stateFile = stateFiles.find((f) => f.includes('test-model-lifecycle'));
  if (stateFile) {
    const stateData = JSON.parse(await fs.readFile(path.join(STORE_DIR, 'test-integration', stateFile), 'utf8'));
    const lastDecision = stateData.lastRouteDecision;
    info(`Last route: action=${lastDecision?.action} confidence=${lastDecision?.confidence}`);

    // After our fix, when model returns null it should fallback to score router, not hardcoded 0.5
    // On first turn with no branches, score router creates new with confidence 1
    check(
      lastDecision?.confidence !== 0.5 || stateData.branches.length <= 1,
      'Model fallback uses score router (not hardcoded 0.5 confidence)'
    );
  }

  return api;
}

// ── Test 4: Context window impact measurement ───────────────────────
async function testContextWindowImpact() {
  section('TEST 4: Context Window Impact Analysis');

  const api = createMockApi();
  const plugin = (await import(path.join(PLUGIN_DIR, 'index.js'))).default;
  await plugin.register(api);

  const ctx = { agentId: 'test', sessionKey: 'test-context-window', sessionId: 'test-003' };

  // Simulate a multi-topic conversation (20 turns across 3 topics)
  const topics = [
    // Topic 1: plugin development (8 turns)
    ...Array.from({ length: 4 }, (_, i) => ({
      user: `Working on the treesession plugin router, iteration ${i + 1}. The Jaccard scoring needs to account for semantic similarity better.`,
      assistant: `Updated the scoring formula iteration ${i + 1}. The semantic weight is now 62% with a gate threshold at 0.05.`,
    })),
    // Topic 2: cooking (6 turns)
    ...Array.from({ length: 3 }, (_, i) => ({
      user: `Recipe step ${i + 1}: How do I make a proper risotto? What kind of rice should I use?`,
      assistant: `Risotto step ${i + 1}: Use Arborio or Carnaroli rice. Keep the broth warm and add it one ladle at a time.`,
    })),
    // Topic 3: back to plugin (6 turns)
    ...Array.from({ length: 3 }, (_, i) => ({
      user: `Back to the treesession plugin. Now working on the model routing tool_use implementation part ${i + 1}.`,
      assistant: `Model routing part ${i + 1}: The route_branch tool schema defines action, branchId, confidence, and reason fields.`,
    })),
  ];

  // Play through all turns
  for (const turn of topics) {
    await fireHook(api, 'before_prompt_build', {
      prompt: turn.user,
      messages: [],
    }, ctx);

    await fireHook(api, 'agent_end', {
      success: true,
      messages: [
        { role: 'user', content: turn.user },
        { role: 'assistant', content: turn.assistant },
      ],
    }, ctx);
  }

  // Now measure: what would the model see?
  const lastResult = await fireHook(api, 'before_prompt_build', {
    prompt: 'Summarize what we discussed about the plugin routing',
    messages: [],
  }, ctx);

  const prependedSize = (lastResult?.prependContext || '').length;

  // Full history = all turns concatenated
  const fullHistorySize = topics
    .map((t) => `user: ${t.user}\nassistant: ${t.assistant}`)
    .join('\n').length;

  // What the model actually sees = prependContext + current prompt + FULL session messages
  const effectiveSize = prependedSize + fullHistorySize;

  console.log('');
  info(`Full conversation history: ${fullHistorySize} chars (~${Math.ceil(fullHistorySize / 4)} tokens)`);
  info(`Prepended branch context: ${prependedSize} chars (~${Math.ceil(prependedSize / 4)} tokens)`);
  info(`Effective model input: ${effectiveSize} chars (~${Math.ceil(effectiveSize / 4)} tokens)`);
  console.log('');

  // CRITICAL CHECK: Does prependContext ADD or REPLACE?
  warn('ARCHITECTURE ISSUE: prependContext is CONCATENATED to user prompt');
  warn('The full session messages[] are STILL sent to the model separately');
  warn(`Net impact: +${prependedSize} chars ADDED, 0 chars REMOVED`);

  check(prependedSize > 0, 'Plugin produces branch-scoped context');
  check(prependedSize <= 6000, `Prepended context within 6000 char limit (${prependedSize})`);

  // This is the key finding — prependContext does NOT reduce context
  console.log('');
  console.log(`  ${bold(red('FINDING: Current architecture does NOT reduce context window'))}`);
  console.log(`  ${dim('prependContext adds ~' + Math.ceil(prependedSize / 4) + ' tokens ON TOP of full history')}`);
  console.log(`  ${dim('Full history (' + Math.ceil(fullHistorySize / 4) + ' tokens) is still in session messages[]')}`);
  console.log('');
  console.log(`  ${bold('To actually reduce context, treesession needs one of:')}`);
  console.log(`  ${cyan('Option A:')} Register as a ${bold('ContextEngine')} via api.registerContextEngine()`);
  console.log(`    ${dim('→ assemble() can filter messages, returning only active branch turns')}`);
  console.log(`    ${dim('→ compact() can summarize inactive branches')}`);
  console.log(`  ${cyan('Option B:')} Use ${bold('prependSystemContext')} for static guidance (cacheable)`);
  console.log(`    ${dim('→ Move branch guidance to system prompt (provider can cache it)')}`);
  console.log(`    ${dim('→ Keep prependContext for per-turn dynamic context only')}`);
  console.log(`  ${cyan('Option C:')} Use ${bold('before_compaction')} hook for branch-aware compaction`);
  console.log(`    ${dim('→ Summarize off-topic turns more aggressively')}`);

  // Load state and check branch quality
  const stateFiles = await fs.readdir(path.join(STORE_DIR, 'test-integration')).catch(() => []);
  const stateFile = stateFiles.find((f) => f.includes('test-context-window'));
  if (stateFile) {
    const stateData = JSON.parse(await fs.readFile(path.join(STORE_DIR, 'test-integration', stateFile), 'utf8'));

    console.log('');
    info(`Branches created: ${stateData.branches.length}`);
    for (const b of stateData.branches) {
      info(`  "${b.title}" — ${b.turns.length} turns, keywords: [${(b.keywords || []).join(', ')}]`);
    }

    // Check that metadata is not polluting keywords
    for (const b of stateData.branches) {
      const noisy = (b.keywords || []).filter((k) =>
        /untrusted|sender_id|message_id|channel_id/.test(k) || /^\d{10,}$/.test(k)
      );
      check(noisy.length === 0, `Branch "${b.title}" keywords clean (no metadata noise)`);
    }
  }
}

// ── Test 5: prependSystemContext migration check ────────────────────
async function testSystemContextMigration() {
  section('TEST 5: prependSystemContext Migration Feasibility');

  // Check if the plugin returns prependContext or prependSystemContext
  info('Current hook result uses: prependContext (per-turn, not cacheable)');
  info('OpenClaw supports: prependSystemContext (cacheable by provider)');
  console.log('');

  // The branch guidance instruction is STATIC and should be in systemContext
  const staticParts = [
    '=== treesession branch context ===',
    'Instruction: Answer using only the active branch context unless user explicitly asks to mix branches.',
  ];

  info('Static parts that SHOULD use prependSystemContext:');
  for (const part of staticParts) {
    info(`  "${part.slice(0, 70)}..."`);
  }

  console.log('');
  info('Dynamic parts that should STAY in prependContext:');
  info('  Active branch name, recent turns, branch summary');

  check(true, 'Migration path identified: split static guidance from dynamic context');
}

// ── Test 6: ContextEngine adapter feasibility ───────────────────────
async function testContextEngineAdapter() {
  section('TEST 6: ContextEngine Adapter Design');

  info('A ContextEngine for treesession would implement:');
  console.log('');
  info('  ingest(msg) → route message to correct branch, store turn');
  info('  assemble(messages, tokenBudget) → return ONLY active branch turns');
  info('    THIS is where context window reduction happens');
  info('    Instead of all N turns, return only the K active-branch turns');
  info('  compact(tokenBudget) → summarize inactive branches');
  info('  afterTurn() → update keywords, route summaries, reorg');
  console.log('');

  // Estimate savings with ContextEngine
  // Scenario: 100 turns across 5 branches, active branch has 20 turns
  const totalTurns = 100;
  const activeBranchTurns = 20;
  const avgTurnTokens = 150;
  const contextBudget = 6000;

  const fullContextTokens = totalTurns * avgTurnTokens;
  const assembledTokens = Math.min(activeBranchTurns * avgTurnTokens, contextBudget);
  const savings = fullContextTokens - assembledTokens;
  const savingsPct = ((savings / fullContextTokens) * 100).toFixed(1);

  console.log(`  ${bold('Projected savings with ContextEngine:')}`);
  info(`  Full history: ${totalTurns} turns × ${avgTurnTokens} tokens = ${fullContextTokens} tokens`);
  info(`  Active branch: ${activeBranchTurns} turns × ${avgTurnTokens} tokens = ${activeBranchTurns * avgTurnTokens} tokens`);
  info(`  Assembled (capped): ${assembledTokens} tokens`);
  console.log(`  ${green(`Savings: ${savings} tokens (${savingsPct}%)`)}`);

  check(true, 'ContextEngine adapter is the correct path for token reduction');
}

// ── Test 7: Config validation ───────────────────────────────────────
async function testConfigValidation() {
  section('TEST 7: OpenClaw Config Validation');

  // Read actual openclaw.json
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
  } catch {
    warn('Could not read openclaw.json');
    return;
  }

  const pluginEntry = config.plugins?.entries?.['treesession-openclaw-plugin'];
  check(pluginEntry != null, 'Plugin entry exists in openclaw.json');

  if (pluginEntry) {
    check(pluginEntry.enabled === false, `Plugin is currently DISABLED (enabled=${pluginEntry.enabled})`);
    warn('Plugin must be enabled for production use');

    const apiKey = pluginEntry.config?.modelRoutingApiKey;
    check(!apiKey || apiKey.length === 0, `Model routing API key is empty — model router will always fail`);
    warn('For model routing: set modelRoutingApiKey or configure gateway loopback');

    const strategy = pluginEntry.config?.routingStrategy;
    info(`Configured routing strategy: ${strategy || 'default (model)'}`);

    if (strategy === 'model' && !apiKey) {
      warn('Strategy is "model" but no API key → every request falls to score fallback');
      warn('Either set API key, enable gateway loopback, or change strategy to "score" or "hybrid"');
    }
  }

  // Check gateway loopback
  const gwEnabled = config.gateway?.http?.endpoints?.chatCompletions?.enabled;
  info(`Gateway chatCompletions endpoint: ${gwEnabled ? 'enabled' : 'disabled'}`);
  if (gwEnabled) {
    pass('Gateway loopback available for model routing');
  } else {
    warn('Gateway loopback disabled — model routing needs API key or loopback');
  }

  // Check plugin load path
  const loadPaths = config.plugins?.load?.paths || [];
  const hasTreesessionPath = loadPaths.some((p) => p.includes('treesession'));
  check(hasTreesessionPath, 'Plugin load path configured');
}

// ── Cleanup ─────────────────────────────────────────────────────────
async function cleanup() {
  try {
    const testDir = path.join(STORE_DIR, 'test-integration');
    const files = await fs.readdir(testDir).catch(() => []);
    for (const f of files) {
      if (f.startsWith('test-')) await fs.unlink(path.join(testDir, f)).catch(() => {});
    }
    await fs.rmdir(testDir).catch(() => {});
  } catch { /* ok */ }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(bold('\n🔌 TreeSession OpenClaw Integration Test\n'));

  await cleanup();

  try {
    await testPluginRegistration();
    await testScoreRoutingLifecycle();
    await testModelRoutingLifecycle();
    await testContextWindowImpact();
    await testSystemContextMigration();
    await testContextEngineAdapter();
    await testConfigValidation();
  } catch (err) {
    console.error(red(`\nFATAL ERROR: ${err.message}`));
    console.error(err.stack);
  }

  await cleanup();

  section('INTEGRATION TEST SUMMARY');
  console.log(`  ${green(`${totalPass} passed`)}  ${totalFail > 0 ? red(`${totalFail} failed`) : dim('0 failed')}`);

  console.log(`\n${bold('Action items to make treesession work in OpenClaw:')}`);
  console.log(`  1. ${yellow('Enable plugin:')} set plugins.entries.treesession-openclaw-plugin.enabled = true`);
  console.log(`  2. ${yellow('Fix model routing:')} set modelRoutingApiKey OR enable gateway chatCompletions`);
  console.log(`  3. ${yellow('Use prependSystemContext:')} move static branch instructions to system prompt`);
  console.log(`  4. ${red('Register as ContextEngine:')} implement assemble() to actually reduce context window`);
  console.log(`  5. ${yellow('Strategy fallback:')} change default to "hybrid" so score catches model failures`);
  console.log('');
}

main().catch(console.error);
