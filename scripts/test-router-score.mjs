#!/usr/bin/env node
import { parseForcedTopic, routePromptToBranch } from '../lib/router.js';

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

const branches = [
  {
    id: 'b1',
    title: 'paper writing treesession',
    keywords: ['paper', 'writing', 'treesession', 'related', 'work'],
    lastActiveAt: hoursAgo(1),
  },
  {
    id: 'b2',
    title: 'plugin implementation openclaw',
    keywords: ['plugin', 'openclaw', 'implementation', 'router', 'code'],
    lastActiveAt: hoursAgo(10),
  },
  {
    id: 'b3',
    title: 'personal life plans',
    keywords: ['travel', 'family', 'weekend'],
    lastActiveAt: hoursAgo(2),
  },
];

const tests = [
  {
    name: 'implementation prompt should prefer plugin branch',
    prompt: 'now patch router code and implement plugin for openclaw',
    activeBranchId: 'b1',
  },
  {
    name: 'short ack should keep active branch',
    prompt: 'ok',
    activeBranchId: 'b2',
  },
  {
    name: 'forced topic should create/find explicitly',
    prompt: 'topic: plugin implementation openclaw\nlet us continue',
    activeBranchId: 'b1',
  },
];

for (const t of tests) {
  const out = routePromptToBranch({
    prompt: t.prompt,
    branches,
    activeBranchId: t.activeBranchId,
    forcedTopic: parseForcedTopic(t.prompt, 'topic:'),
    returnDiagnostics: true,
  });
  console.log(`\n=== ${t.name} ===`);
  console.log('action:', out.action, 'branchId:', out.branchId || '(new)', 'score:', Number(out.score || 0).toFixed(3));
  if (out.diagnostics?.candidates?.length) {
    console.table(
      out.diagnostics.candidates.map((c) => ({
        branchId: c.branchId,
        title: c.titleText,
        semantic: c.semantic.toFixed(3),
        activity: c.activity.toFixed(3),
        titleScore: c.title.toFixed(3),
        continuity: c.continuity.toFixed(3),
        total: c.score.toFixed(3),
      })),
    );
  }
}
