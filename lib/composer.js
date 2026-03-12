import { clampText, tokenize, jaccard } from './util.js';

function cleanTurnText(text = '') {
  let t = String(text || '');

  // Drop injected treesession envelope if present in stored turns.
  const marker = 'Instruction: Use branch-scoped context from this file-tree memory. Do NOT mix unrelated branches unless user asks.';
  while (t.trimStart().startsWith('=== treesession context manager ===')) {
    const idx = t.indexOf(marker);
    if (idx < 0) break;
    t = t.slice(idx + marker.length).trimStart();
  }

  // Also strip branch-context variant envelope.
  const altMarker = 'Instruction: Answer using only the active branch context unless user explicitly asks to mix branches.';
  while (t.trimStart().startsWith('=== treesession branch context ===')) {
    const idx = t.indexOf(altMarker);
    if (idx < 0) break;
    t = t.slice(idx + altMarker.length).trimStart();
  }

  // Drop OpenClaw metadata envelope blocks that should not pollute memory.
  t = t.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/Chat history since last reply \(untrusted, for context\):[\s\S]*?```\s*/gi, '');

  // Remove common JSON envelope fragments and tree dumps when they leak into content.
  t = t.replace(/\bjson\s*\{[\s\S]*$/gi, '');
  t = t.replace(/Branch file tree \(\* active\):[\s\S]*$/gi, '');

  // Remove residual metadata ID fields that leak through.
  t = t.replace(/"message_id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"channel_id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"sender_id"\s*:\s*"[^"]*"/g, '');

  // Keep mention tail if present.
  const mentionMatch = t.match(/@\w+[\s\S]*$/);
  if (mentionMatch) t = mentionMatch[0];

  return t.replace(/\s+/g, ' ').trim();
}

function looksLikeMetadataNoise(text = '') {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('conversation info (untrusted metadata)') ||
    s.includes('sender (untrusted metadata)') ||
    s.includes('"message_id"') ||
    s.includes('=== treesession context manager ===') ||
    s.includes('branch file tree (* active):') ||
    s.includes('=== treesession branch context ===')
  );
}

function fmtTurn(t) {
  const role = t.role === 'assistant' ? 'Assistant' : 'User';
  const clean = cleanTurnText(t.content);
  const compact = clean.length > 260 ? `${clean.slice(0, 260)}...` : clean;
  return `- ${role}: ${compact}`;
}

function scoreTurn(turn, queryTokens) {
  const txt = cleanTurnText(turn?.content || '');
  const toks = tokenize(txt);
  const sim = jaccard(queryTokens, toks);
  const recencyBoost = turn?.ts ? 0.03 : 0;
  return sim + recencyBoost;
}

function selectBranchTurns(branch, prompt = '', branchTurns = 10) {
  const turns = (branch?.turns || []).filter((t) => cleanTurnText(t?.content || '').length > 0);
  if (!turns.length) return [];

  const qTokens = tokenize(prompt || '');

  // If no clear query, keep recent branch memory only.
  if (!qTokens.length) return turns.slice(-Math.max(1, branchTurns));

  // Blend relevance + recency: keep strongest matches, then stable order by time.
  const ranked = turns
    .map((t, i) => ({ t, i, s: scoreTurn(t, qTokens) }))
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, Math.max(1, branchTurns));

  return ranked.sort((a, b) => a.i - b.i).map((x) => x.t);
}

export function composePrependedContext({
  branch,
  siblingBranch,
  branches = [],
  activeBranchId = '',
  recentTurns = 8,
  retrievalTurns = 6,
  maxPrependedChars = 6000,
  prompt = '',
  branchTurns = 10,
}) {
  if (!branch) return '';

  // Use branch turns (topic memory) rather than full tree + generic recent turns.
  const selected = selectBranchTurns(branch, prompt, branchTurns);

  const blocks = [];
  blocks.push('=== treesession branch context ===');
  blocks.push(`Active branch: ${branch.title}`);
  if (branch.path) blocks.push(`Branch path: ${branch.path}`);
  const cleanSummary = cleanTurnText(branch.summary || '');
  if (cleanSummary && !looksLikeMetadataNoise(cleanSummary)) {
    blocks.push(`Branch summary: ${cleanSummary.slice(0, 420)}`);
  }

  blocks.push('\nRelevant branch turns:');
  for (const t of selected) blocks.push(fmtTurn(t));

  if (siblingBranch?.summary) {
    blocks.push(`\nFallback sibling summary (${siblingBranch.title}): ${cleanTurnText(siblingBranch.summary)}`);
  }

  blocks.push('\nInstruction: Answer using only the active branch context unless user explicitly asks to mix branches.');

  return clampText(blocks.join('\n'), maxPrependedChars);
}

export function maybeRefreshSummary(branch, everyTurns = 10) {
  if (!branch) return;
  if (!branch.turnCount || branch.turnCount % everyTurns !== 0) return;

  const tail = (branch.turns || []).slice(-16).map((t) => cleanTurnText(t.content)).join(' ');
  const compact = tail.replace(/\s+/g, ' ').trim();
  if (!compact) return;
  branch.summary = compact.slice(0, 500);
}
