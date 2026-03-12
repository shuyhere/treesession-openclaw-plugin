#!/usr/bin/env node
/**
 * test-all-routers.mjs — Comprehensive router strategy test harness
 *
 * Tests score, model, and hybrid routing against:
 *   1. Real session data (loaded from treesession-store)
 *   2. Synthetic multi-topic instruction sets
 *
 * Usage:
 *   node scripts/test-all-routers.mjs [--real <session-file>] [--strategy score|model|hybrid|all]
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseForcedTopic, routePromptToBranch, computeBranchScore } from '../lib/router.js';
import { routeWithModel } from '../lib/model-router.js';
import { topKeywords, tokenize, jaccard } from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(process.env.HOME, '.openclaw/treesession-store');

// ── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const strategyArg = args.includes('--strategy') ? args[args.indexOf('--strategy') + 1] : 'all';
const realFileArg = args.includes('--real') ? args[args.indexOf('--real') + 1] : null;

// ── Helpers ─────────────────────────────────────────────────────────
function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function daysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

function stripMetadata(text = '') {
  let t = String(text || '');
  t = t.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/\[\[reply_to_current\]\]\s*/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

function colorize(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (s) => colorize(s, 32);
const red = (s) => colorize(s, 31);
const yellow = (s) => colorize(s, 33);
const cyan = (s) => colorize(s, 36);
const bold = (s) => colorize(s, 1);
const dim = (s) => colorize(s, 2);

function printSectionHeader(title) {
  console.log('\n' + bold('═'.repeat(70)));
  console.log(bold(`  ${title}`));
  console.log(bold('═'.repeat(70)));
}

function printResult(test, result, { showDiagnostics = true } = {}) {
  const actionColor = result.action?.includes('new') ? yellow : green;
  const branchLabel = result.branchId
    ? `→ ${result.branchId.slice(0, 8)}...`
    : `→ (NEW: ${result.newTitle || 'untitled'})`;

  console.log(`\n  ${cyan(test.name)}`);
  console.log(`  Prompt: ${dim(test.prompt.slice(0, 80))}${test.prompt.length > 80 ? '...' : ''}`);
  console.log(`  Action: ${actionColor(result.action)}  ${branchLabel}  Score: ${(result.score || 0).toFixed(3)}  Confidence: ${(result.confidence || 0).toFixed(3)}`);

  if (test.expectedAction) {
    const pass = result.action?.includes(test.expectedAction);
    console.log(`  Expected: ${test.expectedAction}  ${pass ? green('✓ PASS') : red('✗ FAIL')}`);
    if (test.expectedBranchTitle && result.branchId) {
      console.log(`  Expected branch: "${test.expectedBranchTitle}"`);
    }
  }

  if (showDiagnostics && result.diagnostics?.candidates?.length) {
    console.log(`  ${dim('─ Candidate scores ─')}`);
    for (const c of result.diagnostics.candidates.slice(0, 5)) {
      const bar = '█'.repeat(Math.round(c.score * 30));
      console.log(`    ${c.titleText?.padEnd(30) || 'untitled'.padEnd(30)} ${bar} ${c.score.toFixed(3)} (sem=${c.semantic.toFixed(3)} act=${c.activity.toFixed(3)} tit=${c.title.toFixed(3)} cont=${c.continuity.toFixed(3)} int=${(c.intentPenalty || 0).toFixed(2)})`);
    }
  }
}

// ── Bug detector: metadata pollution ────────────────────────────────
function checkMetadataPollution(branches) {
  const issues = [];
  const noisePatterns = [
    /untrusted metadata/i,
    /message_id/i,
    /sender_id/i,
    /channel_id/i,
    /reply_to_current/i,
    /\b1016345962735734895\b/,
  ];

  for (const b of branches) {
    for (const field of ['summary', 'routeSummary', 'keywords']) {
      const val = Array.isArray(b[field]) ? b[field].join(' ') : b[field] || '';
      for (const pat of noisePatterns) {
        if (pat.test(val)) {
          issues.push({ branchId: b.id, branchTitle: b.title, field, pattern: pat.toString() });
        }
      }
    }
  }
  return issues;
}

// ── Bug detector: keyword quality ───────────────────────────────────
function checkKeywordQuality(branches) {
  const issues = [];
  const stopwords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'you', 'are', 'was', 'json', 'sender', 'untrusted']);

  for (const b of branches) {
    const kws = b.keywords || [];
    const noisy = kws.filter((k) => stopwords.has(k) || /^\d{10,}$/.test(k));
    if (noisy.length > kws.length * 0.3) {
      issues.push({ branchTitle: b.title, keywords: kws, noisy, ratio: `${noisy.length}/${kws.length}` });
    }
  }
  return issues;
}

// ── Bug detector: route decision quality ────────────────────────────
function checkRouteDecisions(state) {
  const issues = [];
  const decisions = state.routeDecisions || [];

  // Check if all confidences are identical (model fallback)
  const confs = decisions.map((d) => d.confidence);
  const uniqueConfs = [...new Set(confs)];
  if (decisions.length > 3 && uniqueConfs.length === 1) {
    issues.push({
      type: 'stale_confidence',
      detail: `All ${decisions.length} decisions have confidence=${uniqueConfs[0]} — model router likely always failing`,
    });
  }

  // Check if everything routes to same branch
  const uniqueBranches = [...new Set(decisions.map((d) => d.nodeId))];
  if (decisions.length > 5 && uniqueBranches.length === 1) {
    issues.push({
      type: 'single_branch_trap',
      detail: `All ${decisions.length} decisions route to same branch "${decisions[0]?.title}" — no topic splitting occurring`,
    });
  }

  return issues;
}

// ── Synthetic branches for multi-topic testing ──────────────────────
function buildSyntheticBranches() {
  return [
    {
      id: 'syn-paper',
      parentId: null,
      path: 'academic-paper-writing',
      title: 'Academic Paper Writing',
      summary: 'Writing related work section, methodology, designing experiments for the treesession context memory paper',
      routeSummary: 'related work section literature review methodology experiment design ablation study',
      keywords: ['paper', 'writing', 'related', 'work', 'methodology', 'experiment', 'treesession', 'ablation', 'context'],
      turns: [
        { role: 'user', content: 'lets work on the related work section', ts: hoursAgo(2) },
        { role: 'assistant', content: 'I found several relevant papers on context management and session branching', ts: hoursAgo(2) },
        { role: 'user', content: 'what about the methodology section', ts: hoursAgo(1.5) },
        { role: 'assistant', content: 'For methodology we should describe the scoring formula and tree structure', ts: hoursAgo(1.5) },
      ],
      lastActiveAt: hoursAgo(1),
      turnCount: 8,
      userTurnCount: 4,
      assistantTurnCount: 4,
      createdAt: daysAgo(3),
    },
    {
      id: 'syn-plugin',
      parentId: null,
      path: 'plugin-development',
      title: 'Plugin Development',
      summary: 'Building and debugging the treesession OpenClaw plugin, router implementation, score formula, model routing',
      routeSummary: 'fix router bug implement model routing tool_use schema hybrid strategy fallback',
      keywords: ['plugin', 'router', 'code', 'implement', 'debug', 'score', 'model', 'openclaw', 'bug', 'fix'],
      turns: [
        { role: 'user', content: 'debug the router scoring formula', ts: hoursAgo(4) },
        { role: 'assistant', content: 'The Jaccard similarity is computing correctly but the activity weight seems off', ts: hoursAgo(4) },
        { role: 'user', content: 'implement the model routing with tool_use', ts: hoursAgo(3) },
        { role: 'assistant', content: 'Added route_branch tool schema with action, branchId, confidence fields', ts: hoursAgo(3) },
      ],
      lastActiveAt: hoursAgo(3),
      turnCount: 12,
      userTurnCount: 6,
      assistantTurnCount: 6,
      createdAt: daysAgo(5),
    },
    {
      id: 'syn-news',
      parentId: null,
      path: 'world-news',
      title: 'World News and Current Events',
      summary: 'Discussing US Iran conflict, geopolitics, oil prices, military operations',
      routeSummary: 'US Iran war oil prices strait hormuz military conflict geopolitical crisis',
      keywords: ['iran', 'war', 'news', 'oil', 'conflict', 'military', 'geopolitics', 'prices'],
      turns: [
        { role: 'user', content: 'what is happening in Iran', ts: hoursAgo(6) },
        { role: 'assistant', content: 'The US-Iran conflict has escalated with strikes on Tehran', ts: hoursAgo(6) },
      ],
      lastActiveAt: hoursAgo(6),
      turnCount: 4,
      userTurnCount: 2,
      assistantTurnCount: 2,
      createdAt: daysAgo(1),
    },
    {
      id: 'syn-projects',
      parentId: null,
      path: 'personal-projects',
      title: 'Personal Projects Overview',
      summary: 'OttoOS AI linux distro, Tako, multiuser LLM, project management and planning',
      routeSummary: 'ottoos arch linux distro tako workspace multiuser llm project overview',
      keywords: ['ottoos', 'project', 'linux', 'tako', 'workspace', 'planning', 'distro'],
      turns: [
        { role: 'user', content: 'check the projects I have', ts: hoursAgo(8) },
        { role: 'assistant', content: 'You have ottoos, tako, multiuser-llm projects', ts: hoursAgo(8) },
      ],
      lastActiveAt: hoursAgo(8),
      turnCount: 4,
      userTurnCount: 2,
      assistantTurnCount: 2,
      createdAt: daysAgo(2),
    },
    {
      id: 'syn-treesession-meta',
      parentId: 'syn-plugin',
      path: 'plugin-development/treesession-mechanics',
      title: 'Treesession Internal Mechanics',
      summary: 'How the treesession plugin works internally, branch context injection, turn counters, session key resolution',
      routeSummary: 'treesession context injection branch turns counters session key routing prepended context',
      keywords: ['treesession', 'branch', 'context', 'turns', 'counters', 'session', 'injection', 'prepended'],
      turns: [
        { role: 'user', content: 'are you using the treesession', ts: hoursAgo(5) },
        { role: 'assistant', content: 'Yes the treesession context manager injects branch context into each message', ts: hoursAgo(5) },
      ],
      lastActiveAt: hoursAgo(5),
      turnCount: 4,
      userTurnCount: 2,
      assistantTurnCount: 2,
      createdAt: daysAgo(1),
    },
  ];
}

// ── Test instruction sets ───────────────────────────────────────────
function buildTestCases(branches) {
  return [
    // ── Topic continuation (should route to existing) ──
    {
      name: 'Continue paper writing',
      prompt: 'lets finish the experiment design section for the paper',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',
      expectedBranchTitle: 'Academic Paper Writing',
    },
    {
      name: 'Continue plugin debugging',
      prompt: 'the router score is still too low for existing branches, check the Jaccard computation',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
      expectedBranchTitle: 'Plugin Development',
    },
    {
      name: 'Continue news discussion',
      prompt: 'what about the oil prices after the Iran strikes',
      activeBranchId: 'syn-news',
      expectedAction: 'existing',
      expectedBranchTitle: 'World News and Current Events',
    },

    // ── Topic switch (should route to different existing branch) ──
    {
      name: 'Switch from paper to plugin code',
      prompt: 'now patch the router code and fix the model routing fallback',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',
      expectedBranchTitle: 'Plugin Development',
    },
    {
      name: 'Switch from plugin to news',
      prompt: 'what is the latest on the Iran US conflict',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
      expectedBranchTitle: 'World News and Current Events',
    },
    {
      name: 'Switch from news to projects',
      prompt: 'check my ottoos project status',
      activeBranchId: 'syn-news',
      expectedAction: 'existing',
      expectedBranchTitle: 'Personal Projects Overview',
    },

    // ── New topic (should create new branch) ──
    {
      name: 'Completely new topic: cooking',
      prompt: 'what is a good recipe for making pasta carbonara from scratch',
      activeBranchId: 'syn-paper',
      expectedAction: 'new',
    },
    {
      name: 'Completely new topic: fitness',
      prompt: 'design me a 4 day gym workout split for hypertrophy',
      activeBranchId: 'syn-plugin',
      expectedAction: 'new',
    },
    {
      name: 'Completely new topic: travel',
      prompt: 'plan a 2 week trip to Japan visiting Tokyo Kyoto and Osaka',
      activeBranchId: 'syn-news',
      expectedAction: 'new',
    },

    // ── Short acknowledgements (should stay on active) ──
    {
      name: 'Short ack: "ok"',
      prompt: 'ok',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',
    },
    {
      name: 'Short ack: "yes"',
      prompt: 'yes',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
    },
    {
      name: 'Short ack: "go"',
      prompt: 'go',
      activeBranchId: 'syn-news',
      expectedAction: 'existing',
    },

    // ── Forced topic ──
    {
      name: 'Forced topic: existing branch',
      prompt: 'topic: Plugin Development\nlets continue fixing the hybrid strategy',
      activeBranchId: 'syn-paper',
      expectedAction: 'forced_existing',
    },
    {
      name: 'Forced topic: new branch',
      prompt: 'topic: Database Migration\nmigrate the schema to v2',
      activeBranchId: 'syn-paper',
      expectedAction: 'forced_new',
    },

    // ── Back-signal ──
    {
      name: 'Back signal: return to paper',
      prompt: 'back to the paper writing',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
    },

    // ── Explicit switch signal ──
    {
      name: 'Explicit switch: different task',
      prompt: 'switch topic, I want to set up a CI/CD pipeline for deployment',
      activeBranchId: 'syn-paper',
      expectedAction: 'new',
    },

    // ── Ambiguous / cross-topic ──
    {
      name: 'Ambiguous: paper + plugin overlap',
      prompt: 'describe the treesession routing algorithm for the methodology section',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',  // should prefer active branch when ambiguous
    },
    {
      name: 'Ambiguous: news + projects overlap',
      prompt: 'how will the Iran conflict affect our project timelines',
      activeBranchId: 'syn-projects',
      expectedAction: 'existing',  // should prefer active
    },

    // ── Intent tag detection ──
    {
      name: 'Debug intent → plugin',
      prompt: 'fix the crash in the router when branches array is empty',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',
      expectedBranchTitle: 'Plugin Development',
    },
    {
      name: 'Writing intent → paper',
      prompt: 'draft the abstract section summarizing our contributions',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
      expectedBranchTitle: 'Academic Paper Writing',
    },

    // ── Edge cases ──
    {
      name: 'Empty-ish prompt',
      prompt: '...',
      activeBranchId: 'syn-paper',
      expectedAction: 'existing',
    },
    {
      name: 'Very long prompt',
      prompt: 'I need you to analyze the full routing algorithm including the Jaccard similarity computation the relative activity scoring the title hint matching the continuity bonus the intent tag detection the back signal recognition the ambiguity margin the forced topic parsing and the hybrid model fallback threshold and then write a comprehensive test suite covering all edge cases',
      activeBranchId: 'syn-plugin',
      expectedAction: 'existing',
      expectedBranchTitle: 'Plugin Development',
    },
  ];
}

// ── Score router test runner ────────────────────────────────────────
function runScoreTests(branches, tests) {
  printSectionHeader('SCORE ROUTER');
  let pass = 0, fail = 0;

  for (const t of tests) {
    const forcedTopic = parseForcedTopic(t.prompt, 'topic:');
    const result = routePromptToBranch({
      prompt: t.prompt,
      branches,
      activeBranchId: t.activeBranchId,
      createThreshold: 0.22,
      forcedTopic,
      ambiguityMargin: 0.06,
      shortTurnMinChars: 8,
      returnDiagnostics: true,
    });

    printResult(t, result);

    if (t.expectedAction) {
      if (result.action?.includes(t.expectedAction)) pass++;
      else fail++;
    }
  }

  console.log(`\n  ${bold('Score Router Results:')} ${green(`${pass} passed`)}  ${fail > 0 ? red(`${fail} failed`) : dim('0 failed')}`);
  return { pass, fail };
}

// ── Model router test runner (mock) ─────────────────────────────────
async function runModelTests(branches, tests) {
  printSectionHeader('MODEL ROUTER (mocked invokeModel)');

  // Create a simple mock that simulates what a model SHOULD return
  const mockInvokeModel = async ({ system, user }) => {
    const input = JSON.parse(user);
    const prompt = input.prompt || '';
    const branchList = input.branches || [];
    const activeBranchId = input.activeBranchId || '';

    // Simple keyword matching to simulate model behavior
    const promptLower = prompt.toLowerCase();

    // Check for new topic signals
    const newTopicSignals = ['recipe', 'cooking', 'gym', 'workout', 'trip', 'travel', 'ci/cd', 'pipeline', 'deployment'];
    const isNewTopic = newTopicSignals.some((s) => promptLower.includes(s));

    if (isNewTopic) {
      return {
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'route_branch',
                arguments: JSON.stringify({
                  action: 'new',
                  branchId: '',
                  newTitle: prompt.slice(0, 40),
                  parentId: activeBranchId || '',
                  confidence: 0.85,
                  reason: 'New topic not matching any existing branch',
                }),
              },
            }],
          },
        }],
      };
    }

    // Find best matching branch by keyword overlap
    let bestBranch = null;
    let bestScore = 0;

    for (const b of branchList) {
      const branchText = `${b.title} ${b.summary}`.toLowerCase();
      const promptTokens = tokenize(prompt);
      const branchTokens = tokenize(branchText);
      const sim = jaccard(promptTokens, branchTokens);
      if (sim > bestScore) {
        bestScore = sim;
        bestBranch = b;
      }
    }

    // If no good match, use active branch
    if (!bestBranch || bestScore < 0.1) {
      const active = branchList.find((b) => b.id === activeBranchId);
      if (active) {
        return {
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'route_branch',
                  arguments: JSON.stringify({
                    action: 'existing',
                    branchId: active.id,
                    confidence: 0.5,
                    reason: 'No strong match, keeping active branch',
                  }),
                },
              }],
            },
          }],
        };
      }
    }

    return {
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'route_branch',
              arguments: JSON.stringify({
                action: 'existing',
                branchId: bestBranch.id,
                confidence: Math.min(0.95, bestScore + 0.3),
                reason: `Best keyword match with "${bestBranch.title}"`,
              }),
            },
          }],
        },
      }],
    };
  };

  const cfg = {
    routingStrategy: 'model',
    modelRoutingModel: 'mock',
    modelRoutingBaseUrl: '',
    modelRoutingApiKey: '',
  };

  let pass = 0, fail = 0;

  for (const t of tests) {
    // Skip forced-topic tests (model router doesn't handle those)
    if (t.prompt.startsWith('topic:')) {
      console.log(`\n  ${dim(`[SKIP] ${t.name} (forced topic — score router handles this)`)}`);
      continue;
    }

    try {
      const activeBranch = branches.find((b) => b.id === t.activeBranchId);
      const result = await routeWithModel({
        prompt: t.prompt,
        previousUserTurn: '',
        historyTurns: (activeBranch?.turns || []).slice(-4),
        branches,
        activeBranchId: t.activeBranchId,
        cfg,
        runtimeModel: 'mock',
        invokeModel: mockInvokeModel,
        log: { info: () => {}, warn: () => {} },
      });

      if (result) {
        printResult(t, result, { showDiagnostics: false });
        if (t.expectedAction && result.action?.includes(t.expectedAction)) pass++;
        else if (t.expectedAction) fail++;
      } else {
        console.log(`\n  ${red(`[NULL] ${t.name}`)} — model returned null`);
        fail++;
      }
    } catch (err) {
      console.log(`\n  ${red(`[ERROR] ${t.name}`)}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\n  ${bold('Model Router Results:')} ${green(`${pass} passed`)}  ${fail > 0 ? red(`${fail} failed`) : dim('0 failed')}`);
  return { pass, fail };
}

// ── Hybrid router test runner ───────────────────────────────────────
async function runHybridTests(branches, tests) {
  printSectionHeader('HYBRID ROUTER');

  let scoreUsed = 0, modelUsed = 0, pass = 0, fail = 0;

  for (const t of tests) {
    const forcedTopic = parseForcedTopic(t.prompt, 'topic:');

    // Step 1: Run score router with diagnostics
    const scoreRoute = routePromptToBranch({
      prompt: t.prompt,
      branches,
      activeBranchId: t.activeBranchId,
      createThreshold: 0.22,
      forcedTopic,
      ambiguityMargin: 0.06,
      shortTurnMinChars: 8,
      returnDiagnostics: true,
    });

    const cand = scoreRoute?.diagnostics?.candidates || [];
    const top = cand[0]?.score ?? scoreRoute?.score ?? 0;
    const second = cand[1]?.score ?? 0;
    const ambiguous = cand.length > 1 && Math.abs(top - second) < 0.08;
    const lowConfidence = top < 0.32;

    let result;
    let routerUsed;

    if (forcedTopic || (!ambiguous && !lowConfidence)) {
      result = scoreRoute;
      routerUsed = 'score';
      scoreUsed++;
    } else {
      // Would call model router here, but use score as fallback for testing
      result = scoreRoute;
      routerUsed = `model-fallback (ambiguous=${ambiguous}, lowConf=${lowConfidence})`;
      modelUsed++;
    }

    console.log(`\n  ${cyan(t.name)} ${dim(`[${routerUsed}]`)}`);
    console.log(`  Prompt: ${dim(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '...' : ''}`);

    const actionColor = result.action?.includes('new') ? yellow : green;
    const branchLabel = result.branchId
      ? `→ ${result.branchId.slice(0, 12)}...`
      : `→ (NEW: ${result.newTitle || 'untitled'})`;
    console.log(`  Action: ${actionColor(result.action)}  ${branchLabel}  Score: ${(result.score || 0).toFixed(3)}`);

    if (ambiguous) console.log(`  ${yellow('⚠ AMBIGUOUS')} top=${top.toFixed(3)} second=${second.toFixed(3)} gap=${Math.abs(top - second).toFixed(3)}`);
    if (lowConfidence) console.log(`  ${yellow('⚠ LOW CONFIDENCE')} top=${top.toFixed(3)} < threshold=0.32`);

    if (t.expectedAction) {
      const ok = result.action?.includes(t.expectedAction);
      console.log(`  Expected: ${t.expectedAction}  ${ok ? green('✓ PASS') : red('✗ FAIL')}`);
      if (ok) pass++; else fail++;
    }
  }

  console.log(`\n  ${bold('Hybrid Router Results:')} ${green(`${pass} passed`)}  ${fail > 0 ? red(`${fail} failed`) : dim('0 failed')}`);
  console.log(`  Score-only decisions: ${scoreUsed}  Model-needed decisions: ${modelUsed}`);
  return { pass, fail };
}

// ── Real session analysis ───────────────────────────────────────────
async function analyzeRealSession(filePath) {
  printSectionHeader('REAL SESSION ANALYSIS');

  let data;
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    data = JSON.parse(txt);
  } catch (err) {
    console.log(red(`  Failed to load ${filePath}: ${err.message}`));
    return;
  }

  console.log(`  Session: ${data.sessionKey}`);
  console.log(`  Branches: ${data.branches?.length || 0}`);
  console.log(`  Active: ${data.activeBranchId?.slice(0, 12)}...`);
  console.log(`  Route turns: ${data.routeTurnCounter}`);
  console.log(`  Auto routing: ${data.autoRoutingEnabled}`);

  // Bug 1: Metadata pollution
  const pollution = checkMetadataPollution(data.branches || []);
  if (pollution.length) {
    console.log(`\n  ${red('BUG: Metadata pollution detected')}`);
    for (const p of pollution.slice(0, 5)) {
      console.log(`    Branch "${p.branchTitle}" field=${p.field} matched=${p.pattern}`);
    }
  } else {
    console.log(`\n  ${green('✓ No metadata pollution in branch fields')}`);
  }

  // Bug 2: Keyword quality
  const kwIssues = checkKeywordQuality(data.branches || []);
  if (kwIssues.length) {
    console.log(`\n  ${red('BUG: Poor keyword quality')}`);
    for (const k of kwIssues) {
      console.log(`    Branch "${k.branchTitle}" noisy=${k.ratio} keywords=[${k.keywords.join(', ')}]`);
    }
  } else {
    console.log(`  ${green('✓ Keyword quality acceptable')}`);
  }

  // Bug 3: Route decision quality
  const routeIssues = checkRouteDecisions(data);
  if (routeIssues.length) {
    console.log(`\n  ${red('BUG: Route decision issues')}`);
    for (const r of routeIssues) {
      console.log(`    ${r.type}: ${r.detail}`);
    }
  } else {
    console.log(`  ${green('✓ Route decisions look healthy')}`);
  }

  // Replay: what SHOULD have happened with score router on the real turns
  if (data.branches?.length) {
    console.log(`\n  ${bold('── Replay: Score router on real session turns ──')}`);
    const branch = data.branches[0];
    const userTurns = (branch.turns || []).filter((t) => t.role === 'user');

    for (const turn of userTurns) {
      const cleanPrompt = stripMetadata(turn.content);
      if (cleanPrompt.length < 3) continue;

      const result = routePromptToBranch({
        prompt: cleanPrompt,
        branches: data.branches,
        activeBranchId: data.activeBranchId,
        createThreshold: 0.22,
        shortTurnMinChars: 8,
        returnDiagnostics: true,
      });

      const actionColor = result.action?.includes('new') ? yellow : green;
      console.log(`    "${cleanPrompt.slice(0, 60)}..." → ${actionColor(result.action)} score=${(result.score || 0).toFixed(3)}`);
    }
  }

  // Show what topic splits SHOULD have happened
  console.log(`\n  ${bold('── Suggested topic splits for this session ──')}`);
  const topics = new Map();
  const branch = data.branches?.[0];
  if (branch?.turns) {
    for (const turn of branch.turns.filter((t) => t.role === 'user')) {
      const clean = stripMetadata(turn.content);
      if (clean.length < 5) continue;

      // Detect topic category
      const lower = clean.toLowerCase();
      let topic = 'general';
      if (/\b(iran|war|news|conflict|oil)\b/.test(lower)) topic = 'world-news';
      else if (/\b(project|ottoos|tako|workspace)\b/.test(lower)) topic = 'projects';
      else if (/\b(treesession|branch|router|score|session|context)\b/.test(lower)) topic = 'treesession-debug';
      else if (/\b(skill|who are you|capabilities)\b/.test(lower)) topic = 'identity';
      else if (/\b(web|search|fetch|api)\b/.test(lower)) topic = 'tools-debug';

      if (!topics.has(topic)) topics.set(topic, []);
      topics.get(topic).push(clean.slice(0, 60));
    }

    for (const [topic, turns] of topics) {
      console.log(`    ${cyan(topic)} (${turns.length} turns)`);
      for (const t of turns.slice(0, 3)) console.log(`      - ${dim(t)}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(bold('\n🌳 TreeSession Router Debug & Test Harness\n'));

  const branches = buildSyntheticBranches();
  const tests = buildTestCases(branches);

  const results = {};

  if (strategyArg === 'all' || strategyArg === 'score') {
    results.score = runScoreTests(branches, tests);
  }

  if (strategyArg === 'all' || strategyArg === 'model') {
    results.model = await runModelTests(branches, tests);
  }

  if (strategyArg === 'all' || strategyArg === 'hybrid') {
    results.hybrid = await runHybridTests(branches, tests);
  }

  // Real session analysis
  const realFile = realFileArg
    ? realFileArg
    : path.join(STORE_DIR, 'agent_main_discord_direct_1016345962735734895__main.json');

  try {
    await fs.access(realFile);
    await analyzeRealSession(realFile);
  } catch {
    console.log(dim(`\n  No real session file found at ${realFile}`));
  }

  // Summary
  printSectionHeader('OVERALL SUMMARY');

  let totalPass = 0, totalFail = 0;
  for (const [strategy, r] of Object.entries(results)) {
    totalPass += r.pass;
    totalFail += r.fail;
    console.log(`  ${strategy.padEnd(10)} ${green(`${r.pass} pass`)}  ${r.fail > 0 ? red(`${r.fail} fail`) : dim('0 fail')}`);
  }
  console.log(`  ${'TOTAL'.padEnd(10)} ${green(`${totalPass} pass`)}  ${totalFail > 0 ? red(`${totalFail} fail`) : dim('0 fail')}`);

  console.log(`\n${bold('Known bugs detected in codebase:')}`);
  console.log(`  1. ${red('refreshBranchRouteSummary()')} builds routeSummary from raw turns — metadata leaks into routing`);
  console.log(`  2. ${red('Model router always returns null')} — all route decisions have confidence=0.5 (fallback)`);
  console.log(`  3. ${red('shortTurnMinChars defaults to 0')} in getCfg() — short-turn guard never fires`);
  console.log(`  4. ${red('Keywords from last turn only')} — accumulated topic signal lost on each turn`);
  console.log(`  5. ${red('Single-branch trap')} — diverse topics stuck in one branch when model router fails`);
  console.log('');
}

main().catch(console.error);
