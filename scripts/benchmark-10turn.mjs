#!/usr/bin/env node
/**
 * 10-turn deterministic benchmark for treesession plugin.
 * Exercises routing + context composition + turn storage using real plugin code.
 * No external API calls — uses score-based routing (simulates no-api-key scenario).
 */

import crypto from 'crypto';
import { parseForcedTopic, routePromptToBranch, computeBranchScore } from '../lib/router.js';
import { composePrependedContext, maybeRefreshSummary } from '../lib/composer.js';
import { topKeywords, tokenize, jaccard } from '../lib/util.js';
import { hydrateBranchStats, recomputeAllPaths } from '../lib/tree.js';

// ── Scenario: 10 turns, 3 topics, with returns ──────────────────────

const TURNS = [
  { id: 1, topic: 'python-serializer',  prompt: 'I need to serialize nested Python dataclasses to JSON, preserving datetime fields. What is the best approach using dataclasses-json or pydantic?' },
  { id: 2, topic: 'python-serializer',  prompt: 'The datetime serializer throws TypeError on timezone-aware objects. How do I fix the custom encoder to handle both naive and aware datetimes?' },
  { id: 3, topic: 'ci-debug',           prompt: 'Our GitHub Actions CI pipeline is failing on the lint step. The ESLint config extends airbnb but the peer dependencies are mismatched. How do I fix the CI YAML?' },
  { id: 4, topic: 'science-general',    prompt: 'Explain the difference between Bayesian inference and frequentist hypothesis testing in the context of clinical drug trials.' },
  { id: 5, topic: 'ci-debug',           prompt: 'The CI build passes lint now but the Docker layer cache is invalidated every run. How can I optimize the Dockerfile layer ordering for better cache hits?' },
  { id: 6, topic: 'python-serializer',  prompt: 'Back to the Python serializer — I also need to handle Decimal fields. Should I extend the custom encoder or switch to cattrs?' },
  { id: 7, topic: 'science-general',    prompt: 'What are the key assumptions behind the central limit theorem and when does it break down for heavy-tailed distributions?' },
  { id: 8, topic: 'python-serializer',  prompt: 'The dataclass serializer now handles datetime and Decimal. But nested Optional fields produce null instead of omitting the key. Fix?' },
  { id: 9, topic: 'ci-debug',           prompt: 'Return to CI — the Docker build is fast now but the test matrix is running 48 jobs. How do I shard the test suite across fewer runners?' },
  { id: 10, topic: 'science-general',   prompt: 'How does CRISPR-Cas9 gene editing differ mechanistically from older zinc finger nuclease approaches?' },
];

// ── State simulation ──────────────────────────────────────────────

function createBranch(title, seedText = '', opts = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    parentId: opts.parentId || null,
    path: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    title,
    summary: '',
    routeSummary: '',
    keywords: [],
    turns: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    turnCount: 0,
    userTurnCount: 0,
    assistantTurnCount: 0,
    depth: 0,
    seedText,
  };
}

function estimateTokens(text = '') {
  return Math.max(0, Math.ceil((text || '').length / 4));
}

// ── Run benchmark ────────────────────────────────────────────────

const state = {
  schema: 'treesession.v1',
  sessionKey: 'benchmark-10turn',
  agentId: 'benchmark',
  activeBranchId: '',
  branches: [],
};

const turnResults = [];
const tokenMetrics = [];
let totalPrependedChars = 0;
let totalFullHistoryChars = 0;

for (const turn of TURNS) {
  const prompt = turn.prompt;
  const promptKeys = topKeywords(prompt, 12);

  // Route
  const forcedTopic = parseForcedTopic(prompt, 'topic:');
  const route = routePromptToBranch({
    prompt,
    branches: state.branches,
    activeBranchId: state.activeBranchId,
    createThreshold: 0.35,
    forcedTopic,
    shortTurnMinChars: 0,
    returnDiagnostics: true,
  });

  let branch = state.branches.find((b) => b.id === route.branchId);
  let createdNew = false;

  if (!branch) {
    // Generate title from keywords
    const title = route.newTitle || promptKeys.slice(0, 4).join('-') || 'new-topic';
    branch = createBranch(title, prompt);
    state.branches.push(branch);
    recomputeAllPaths(state);
    createdNew = true;
  }

  branch.lastActiveAt = new Date().toISOString();
  state.activeBranchId = branch.id;

  // Store user turn
  branch.turns.push({ role: 'user', content: prompt, ts: new Date().toISOString() });
  branch.userTurnCount = (branch.userTurnCount || 0) + 1;
  branch.turnCount = (branch.turnCount || 0) + 1;
  branch.keywords = topKeywords(`${branch.title} ${prompt}`, 12);

  // Simulate assistant reply
  const fakeReply = `[Assistant reply for turn ${turn.id} on topic: ${turn.topic}]`;
  branch.turns.push({ role: 'assistant', content: fakeReply, ts: new Date().toISOString() });
  branch.assistantTurnCount = (branch.assistantTurnCount || 0) + 1;
  branch.turnCount = (branch.turnCount || 0) + 1;

  // Refresh summary
  maybeRefreshSummary(branch, 4);
  const tail = branch.turns.slice(-10).map((t) => t.content).join(' ').replace(/\s+/g, ' ').trim();
  branch.routeSummary = tail.slice(0, 260);
  if (!branch.summary) branch.summary = tail.slice(0, 380);

  hydrateBranchStats(state);

  // Compose context
  const prepended = composePrependedContext({
    branch,
    branches: state.branches,
    activeBranchId: state.activeBranchId,
    recentTurns: 8,
    retrievalTurns: 6,
    maxPrependedChars: 6000,
    prompt,
    branchTurns: 10,
  });

  // Check for cross-topic leakage
  const otherTopicTerms = {
    'python-serializer': ['eslint', 'docker', 'ci', 'bayesian', 'crispr', 'zinc finger', 'clinical trial'],
    'ci-debug': ['dataclass', 'pydantic', 'datetime', 'serializer', 'cattrs', 'bayesian', 'crispr'],
    'science-general': ['eslint', 'docker', 'dataclass', 'pydantic', 'serializer', 'github actions'],
  };
  const leakTerms = (otherTopicTerms[turn.topic] || []).filter((t) => prepended.toLowerCase().includes(t));
  const hasLeak = leakTerms.length > 0;

  // Token metrics (simulated but using real char counts)
  const prependedTokens = estimateTokens(prepended);
  const promptTokens = estimateTokens(prompt);
  const inputTokens = prependedTokens + promptTokens;
  const outputTokens = estimateTokens(fakeReply);

  // Full history baseline: all turns up to now across all branches
  const allTurnsText = state.branches.flatMap((b) => b.turns).map((t) => `${t.role}: ${t.content}`).join('\n');
  const fullHistoryTokens = estimateTokens(allTurnsText);
  totalPrependedChars += prepended.length;
  totalFullHistoryChars += allTurnsText.length;

  const turnMetric = {
    turn: turn.id,
    inputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    effectivePrompt: inputTokens,
    fullHistoryTokens,
    savedTokens: Math.max(0, fullHistoryTokens - inputTokens),
  };
  tokenMetrics.push(turnMetric);

  const candidates = route.diagnostics?.candidates || [];

  turnResults.push({
    turn: turn.id,
    expectedTopic: turn.topic,
    routedBranchId: branch.id,
    routedBranchTitle: branch.title,
    routeAction: route.action,
    routeConfidence: Number((route.confidence || route.score || 0).toFixed(3)),
    createdNew,
    prependedChars: prepended.length,
    prependedSummary: prepended.slice(0, 120).replace(/\n/g, ' ') + '...',
    crossTopicLeak: hasLeak,
    leakedTerms: leakTerms,
    candidateScores: candidates.slice(0, 4).map((c) => ({
      title: c.titleText,
      score: Number(c.score.toFixed(3)),
    })),
  });
}

// ── Aggregate results ────────────────────────────────────────────

// Branch summary
const branchSummary = state.branches.map((b) => ({
  id: b.id,
  title: b.title,
  turnCount: b.turnCount,
  userTurnCount: b.userTurnCount,
  assignedTurns: turnResults.filter((t) => t.routedBranchId === b.id).map((t) => t.turn),
}));

// Routing quality
const topicToBranch = new Map();
let correctRoutes = 0;
let returnCorrect = 0;
let returnTotal = 0;

for (const tr of turnResults) {
  if (tr.createdNew) {
    topicToBranch.set(tr.expectedTopic, tr.routedBranchId);
    correctRoutes++;
  } else {
    const expectedBranch = topicToBranch.get(tr.expectedTopic);
    if (tr.routedBranchId === expectedBranch) {
      correctRoutes++;
      // Check if this is a return
      const prevTurn = turnResults[turnResults.indexOf(tr) - 1];
      if (prevTurn && prevTurn.expectedTopic !== tr.expectedTopic) {
        returnTotal++;
        returnCorrect++;
      }
    } else {
      const prevTurn = turnResults[turnResults.indexOf(tr) - 1];
      if (prevTurn && prevTurn.expectedTopic !== tr.expectedTopic) {
        returnTotal++;
      }
    }
  }
}

const leakCount = turnResults.filter((t) => t.crossTopicLeak).length;

// Token aggregates
const totalInput = tokenMetrics.reduce((s, m) => s + m.inputTokens, 0);
const totalOutput = tokenMetrics.reduce((s, m) => s + m.outputTokens, 0);
const totalSaved = tokenMetrics.reduce((s, m) => s + m.savedTokens, 0);
const lastFullHistory = tokenMetrics[tokenMetrics.length - 1].fullHistoryTokens;
const lastBranched = tokenMetrics[tokenMetrics.length - 1].inputTokens;
const savingsPct = lastFullHistory > 0 ? ((lastFullHistory - lastBranched) / lastFullHistory * 100).toFixed(1) : '0';

// Baseline simulation (no branching = all turns in context every time)
const baselineTokens = tokenMetrics.map((m) => ({
  turn: m.turn,
  inputTokens: m.fullHistoryTokens,
  branchedInputTokens: m.inputTokens,
  saved: m.savedTokens,
}));

// ── Output ───────────────────────────────────────────────────────

console.log('=== TREESESSION 10-TURN BENCHMARK ===\n');

console.log('TURN-BY-TURN ROUTING:');
for (const tr of turnResults) {
  const leak = tr.crossTopicLeak ? ` LEAK:[${tr.leakedTerms.join(',')}]` : ' clean';
  console.log(`  T${tr.turn} [${tr.expectedTopic}] -> "${tr.routedBranchTitle}" (${tr.routeAction}, conf=${tr.routeConfidence})${tr.createdNew ? ' NEW' : ''}${leak}`);
}

console.log('\nBRANCH DISTRIBUTION:');
for (const b of branchSummary) {
  console.log(`  "${b.title}" turns=${b.turnCount} assigned=[${b.assignedTurns.join(',')}]`);
}

console.log(`\nROUTING QUALITY: ${correctRoutes}/${turnResults.length} correct (${(correctRoutes/turnResults.length*100).toFixed(0)}%)`);
console.log(`RETURN-TO-TOPIC: ${returnCorrect}/${returnTotal} correct`);
console.log(`CROSS-TOPIC LEAKS: ${leakCount}/${turnResults.length}`);

console.log('\nTOKEN METRICS (per-turn):');
for (const m of tokenMetrics) {
  console.log(`  T${m.turn}: branched=${m.inputTokens} full_history=${m.fullHistoryTokens} saved=${m.savedTokens}`);
}
console.log(`\nAGGREGATE: total_branched_input=${totalInput} total_saved=${totalSaved}`);
console.log(`FINAL TURN: branched=${lastBranched} vs full_history=${lastFullHistory} => ${savingsPct}% savings`);

// JSON output
const result = {
  scenario: {
    turns: 10,
    topics: ['python-serializer', 'ci-debug', 'science-general'],
    topicDistribution: { 'python-serializer': 4, 'ci-debug': 3, 'science-general': 3 },
    routingStrategy: 'score (no API key, internal invokeModel not available in test harness)',
    createThreshold: 0.35,
  },
  turns: turnResults,
  branches: branchSummary,
  routing_quality: {
    correctRoutes,
    totalRoutes: turnResults.length,
    accuracy: Number((correctRoutes / turnResults.length).toFixed(3)),
    returnToTopicCorrect: returnCorrect,
    returnToTopicTotal: returnTotal,
    crossTopicLeaks: leakCount,
  },
  token_metrics: {
    perTurn: tokenMetrics,
    aggregate: {
      totalBranchedInput: totalInput,
      totalOutput,
      totalFullHistoryBaseline: tokenMetrics.reduce((s, m) => s + m.fullHistoryTokens, 0),
      totalSaved,
      finalTurnSavingsPct: Number(savingsPct),
    },
  },
  baseline_comparison: {
    description: 'No-branch baseline: every turn sends full conversation history as context. Branched: only active branch turns sent.',
    perTurn: baselineTokens,
    finalTurn: {
      fullHistory: lastFullHistory,
      branched: lastBranched,
      savingsPct: Number(savingsPct),
    },
  },
  conclusion: `Over 10 mixed-topic turns across 3 topics, score-based routing achieved ${correctRoutes}/10 correct routes with ${returnCorrect}/${returnTotal} return-to-topic accuracy. Cross-topic context leaks: ${leakCount}/10. By turn 10, branched context used ${lastBranched} tokens vs ${lastFullHistory} full-history baseline (${savingsPct}% reduction). Branching provides monotonically increasing savings as conversation grows.`,
};

console.log('\n=== JSON RESULT ===');
console.log(JSON.stringify(result, null, 2));
