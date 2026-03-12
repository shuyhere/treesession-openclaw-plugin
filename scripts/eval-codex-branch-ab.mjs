#!/usr/bin/env node
import fs from 'fs';
import { routePromptToBranch } from '../lib/router.js';
import { createBranch } from '../lib/store.js';
import { composePrependedContext } from '../lib/composer.js';

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}

const sessionFile = arg('sessionFile');
const sampleN = Number(arg('sample', '20'));
const model = arg('model', process.env.EVAL_MODEL || 'gpt-5.3-codex');
const baseUrl = (arg('baseUrl', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')).replace(/\/$/, '');
const apiKey = arg('apiKey', process.env.OPENAI_API_KEY || '');
const systemPrompt = arg('system', 'You are a helpful assistant.');
const outJson = arg('outJson', './eval-branch-ab.json');

if (!sessionFile) {
  console.error('Missing --sessionFile');
  process.exit(1);
}
if (!apiKey) {
  console.error('Missing API key (set OPENAI_API_KEY or --apiKey)');
  process.exit(2);
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => x?.text || x?.content || '').join('\n').trim();
  }
  return content.text || content.content || '';
}

function loadMessages(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== 'message' || !obj.message) continue;
    const role = obj.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textFromContent(obj.message.content).trim();
    if (!text) continue;
    rows.push({ role, text });
  }
  return rows;
}

async function chat(messages) {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`chat failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  return {
    text: j?.choices?.[0]?.message?.content || '',
    usage: j?.usage || {},
    latencyMs,
  };
}

function spacedIndices(total, k) {
  if (k <= 0 || total <= 0) return [];
  if (k >= total) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(Math.floor((i * (total - 1)) / (k - 1)));
  }
  return [...new Set(out)];
}

function ensureBranch(state, route, prompt) {
  let branch = state.branches.find((b) => b.id === route.branchId);
  if (!branch) {
    const parent = state.branches.find((b) => b.id === state.activeBranchId) || null;
    branch = createBranch(route.newTitle || 'new-topic', prompt, {
      parentId: parent?.id || null,
      parentPath: parent?.path || '',
    });
    state.branches.push(branch);
  }
  state.activeBranchId = branch.id;
  return branch;
}

function branchStateBeforeTurn(rows) {
  const state = { activeBranchId: '', branches: [] };
  let currentBranchId = '';

  for (const r of rows) {
    if (r.role === 'user') {
      const route = routePromptToBranch({
        prompt: r.text,
        branches: state.branches,
        activeBranchId: state.activeBranchId,
      });
      const b = ensureBranch(state, route, r.text);
      currentBranchId = b.id;
      b.turns.push({ role: 'user', content: r.text, ts: new Date().toISOString() });
      b.userTurnCount = (b.userTurnCount || 0) + 1;
      b.turnCount = (b.turnCount || 0) + 1;
      b.lastActiveAt = new Date().toISOString();
    } else if (r.role === 'assistant' && currentBranchId) {
      const b = state.branches.find((x) => x.id === currentBranchId);
      if (b) {
        b.turns.push({ role: 'assistant', content: r.text, ts: new Date().toISOString() });
        b.assistantTurnCount = (b.assistantTurnCount || 0) + 1;
        b.turnCount = (b.turnCount || 0) + 1;
        b.lastActiveAt = new Date().toISOString();
      }
    }
  }

  return state;
}

function buildFullContext(prevRows) {
  return prevRows.map((r) => `${r.role}: ${r.text}`).join('\n');
}

async function judge({ prompt, baseline, branch }) {
  const sys = 'You are an evaluator. Return strict JSON only.';
  const usr = JSON.stringify(
    {
      task: 'Compare two answers for the same user prompt.',
      criteria: [
        'utility_1_to_5: how useful and complete',
        'topic_fit_1_to_5: how well aligned with user topic',
      ],
      user_prompt: prompt,
      baseline_output: baseline,
      branch_output: branch,
      output_json_schema: {
        baseline: { utility_1_to_5: 0, topic_fit_1_to_5: 0 },
        branch: { utility_1_to_5: 0, topic_fit_1_to_5: 0 },
        winner: 'baseline|branch|tie',
        rationale: 'short',
      },
    },
    null,
    2,
  );

  const res = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ]);

  try {
    const s = res.text;
    const a = s.indexOf('{');
    const z = s.lastIndexOf('}');
    if (a >= 0 && z > a) return JSON.parse(s.slice(a, z + 1));
  } catch {}
  return { baseline: {}, branch: {}, winner: 'tie', rationale: 'parse-failed' };
}

async function main() {
  const all = loadMessages(sessionFile);
  const userIdx = all.map((m, i) => [m, i]).filter(([m]) => m.role === 'user').map(([, i]) => i);
  const pick = spacedIndices(userIdx.length, sampleN).map((k) => userIdx[k]);

  const rows = [];

  for (const msgIndex of pick) {
    const prev = all.slice(0, msgIndex);
    const cur = all[msgIndex];

    const state = branchStateBeforeTurn(prev);

    const fullContext = buildFullContext(prev);

    const route = routePromptToBranch({
      prompt: cur.text,
      branches: state.branches,
      activeBranchId: state.activeBranchId,
    });
    const active = ensureBranch(state, route, cur.text);

    const branchContext = composePrependedContext({
      branch: active,
      branches: state.branches,
      activeBranchId: state.activeBranchId,
      recentTurns: 8,
      retrievalTurns: 6,
      maxPrependedChars: 6000,
    });

    const baseRes = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Context:\n${fullContext}\n\nUser:\n${cur.text}` },
    ]);

    const brRes = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Context:\n${branchContext}\n\nUser:\n${cur.text}` },
    ]);

    const evalRes = await judge({ prompt: cur.text, baseline: baseRes.text, branch: brRes.text });

    rows.push({
      prompt: cur.text,
      routeAction: route.action,
      routeScore: route.score ?? null,
      baseline: {
        output: baseRes.text,
        promptTokens: baseRes.usage.prompt_tokens ?? null,
        completionTokens: baseRes.usage.completion_tokens ?? null,
        latencyMs: baseRes.latencyMs,
        contextChars: fullContext.length,
      },
      branch: {
        output: brRes.text,
        promptTokens: brRes.usage.prompt_tokens ?? null,
        completionTokens: brRes.usage.completion_tokens ?? null,
        latencyMs: brRes.latencyMs,
        contextChars: branchContext.length,
      },
      judge: evalRes,
    });

    console.error(`done ${rows.length}/${pick.length}`);
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const bPrompt = rows.map((r) => r.baseline.promptTokens).filter((x) => Number.isFinite(x));
  const brPrompt = rows.map((r) => r.branch.promptTokens).filter((x) => Number.isFinite(x));
  const bLat = rows.map((r) => r.baseline.latencyMs);
  const brLat = rows.map((r) => r.branch.latencyMs);

  const summary = {
    samples: rows.length,
    avgBaselinePromptTokens: Math.round(avg(bPrompt)),
    avgBranchPromptTokens: Math.round(avg(brPrompt)),
    avgPromptTokenSaving: Math.round(avg(bPrompt) - avg(brPrompt)),
    avgPromptTokenSavingRatioPct: bPrompt.length ? +((1 - avg(brPrompt) / avg(bPrompt)) * 100).toFixed(1) : null,
    avgBaselineLatencyMs: Math.round(avg(bLat)),
    avgBranchLatencyMs: Math.round(avg(brLat)),
    avgLatencyDeltaMs: Math.round(avg(brLat) - avg(bLat)),
  };

  const out = {
    meta: {
      sessionFile,
      model,
      baseUrl,
      sampleN,
      systemPrompt,
      timestamp: new Date().toISOString(),
    },
    summary,
    rows,
  };

  fs.writeFileSync(outJson, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.error(`wrote ${outJson}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
