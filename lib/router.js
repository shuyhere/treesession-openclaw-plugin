import { jaccard, topKeywords, tokenize } from './util.js';

function titleHintScore(prompt, title = '') {
  const p = (prompt || '').toLowerCase();
  const t = (title || '').toLowerCase().trim();
  if (!p || !t) return 0;

  // Exact phrase match is strong, but don't over-trigger on tiny titles.
  if (t.length >= 5 && p.includes(t)) return 1;

  const tokens = tokenize(t);
  if (!tokens.length) return 0;
  const matched = tokens.filter((x) => p.includes(x)).length;
  return matched / tokens.length;
}

export function parseForcedTopic(prompt = '', prefix = 'topic:') {
  const p = (prompt || '').trim();
  const key = (prefix || 'topic:').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match only when user explicitly starts a line with topic:
  // e.g. "topic: planning" or "...\ntopic: planning"
  const rx = new RegExp(`(?:^|\\n)\\s*${key}\\s*(.+)`, 'i');
  const m = p.match(rx);
  if (!m) return '';

  const value = (m[1] || '').split('\n')[0].trim();
  return value.slice(0, 80);
}

function normalizeTitle(s = '') {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function safeNum(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function detectIntentTags(text = '') {
  const s = (text || '').toLowerCase();
  const tags = new Set();
  if (/\b(fix|debug|error|bug|issue|broken|trace|crash|leak)\b/.test(s)) tags.add('debug');
  if (/\b(write|draft|paper|related work|abstract|method|section|review)\b/.test(s)) tags.add('writing');
  if (/\b(implement|code|build|plugin|patch|refactor)\b/.test(s)) tags.add('implementation');
  if (/\b(auth|oauth|token|callback|login|credential)\b/.test(s)) tags.add('auth');
  if (/\b(sync|obsidian|gdrive|rclone|notes)\b/.test(s)) tags.add('sync');
  return tags;
}

function explicitSwitchSignal(text = '') {
  const s = (text || '').toLowerCase();
  return /\b(switch topic|instead|move to|back to|different task|new task)\b/.test(s) || /^\s*now\b.*\b(fix|write|implement|review|move|switch)\b/.test(s);
}

function buildRelativeActivity(branches = []) {
  const now = Date.now();
  const ages = branches.map((b) => {
    const t = new Date(b?.lastActiveAt || 0).getTime();
    if (!Number.isFinite(t) || t <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - t);
  });

  const finiteAges = ages.filter(Number.isFinite);
  const minAge = finiteAges.length ? Math.min(...finiteAges) : 0;
  const maxAge = finiteAges.length ? Math.max(...finiteAges) : 0;

  const turns = branches.map((b) => safeNum(b?.turnCount, 0));
  const maxTurns = Math.max(0, ...turns);

  return branches.map((b, i) => {
    const age = ages[i];

    // Relative recency in [0,1] without fixed half-life.
    let recencyRel = 0;
    if (!Number.isFinite(age)) {
      recencyRel = 0;
    } else if (maxAge === minAge) {
      recencyRel = 0.5;
    } else {
      recencyRel = 1 - (age - minAge) / (maxAge - minAge);
    }

    // Relative interaction volume in [0,1].
    const turnsRel = maxTurns > 0 ? safeNum(b?.turnCount, 0) / maxTurns : 0;

    // Relative activity score: blend recency + branch usage.
    const activity = 0.7 * recencyRel + 0.3 * turnsRel;

    return {
      branchId: b.id,
      recencyRel: Math.max(0, Math.min(1, recencyRel)),
      turnsRel: Math.max(0, Math.min(1, turnsRel)),
      activity: Math.max(0, Math.min(1, activity)),
    };
  });
}

export function computeBranchScore({ prompt, promptKeys, promptIntents, branch, activeBranchId, activityMap }) {
  const memoryKeys = topKeywords(`${branch.summary || ''} ${branch.routeSummary || ''} ${branch.title || ''}`, 12);
  const combinedKeys = [...new Set([...(branch.keywords || []), ...memoryKeys])];
  const semantic = jaccard(promptKeys, combinedKeys);
  const activity = activityMap.get(branch.id) || 0;
  const title = titleHintScore(prompt, branch.title);
  const continuity = branch.id === activeBranchId ? 0.08 : 0;

  const branchIntents = detectIntentTags(`${branch.title || ''} ${branch.summary || ''} ${branch.routeSummary || ''}`);
  const intentOverlap = [...promptIntents].some((t) => branchIntents.has(t));
  const intentPenalty = promptIntents.size && branchIntents.size && !intentOverlap ? -0.12 : 0;

  // When semantic similarity is very low, discount activity so that unrelated
  // topics don't stay above the branch-creation threshold purely from recency.
  const semanticGate = semantic < 0.05 ? 0.3 : 1;
  const scoreRaw = 0.62 * semantic + 0.23 * activity * semanticGate + 0.15 * title + continuity + intentPenalty;
  const score = Math.max(0, Math.min(1, scoreRaw));

  return {
    branchId: branch.id,
    titleText: branch.title,
    semantic,
    activity,
    title,
    continuity,
    intentPenalty,
    score,
  };
}

export function routePromptToBranch({
  prompt,
  branches,
  activeBranchId,
  createThreshold = 0.22,
  forcedTopic = '',
  ambiguityMargin = 0.06,
  shortTurnMinChars = 8,
  returnDiagnostics = false,
}) {
  const safeBranches = Array.isArray(branches) ? branches : [];
  const text = (prompt || '').trim();
  const promptKeys = topKeywords(text, 12);

  if (forcedTopic) {
    const target = normalizeTitle(forcedTopic);
    const found = safeBranches.find((b) => normalizeTitle(b.title) === target);
    const result = found
      ? { action: 'forced_existing', branchId: found.id, confidence: 1, score: 1 }
      : { action: 'forced_new', branchId: '', confidence: 1, score: 1, newTitle: forcedTopic };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: [] };
    return result;
  }

  // If no branches yet, create first.
  if (!safeBranches.length) {
    const title = promptKeys.slice(0, 4).join('-') || 'new-topic';
    const result = { action: 'auto_new', branchId: '', confidence: 1, score: 0, newTitle: title };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: [] };
    return result;
  }

  // Tiny acknowledgements should prefer continuity over accidental new branch creation.
  if (text.length < shortTurnMinChars && activeBranchId) {
    const result = { action: 'auto_existing_short', branchId: activeBranchId, confidence: 0.6, score: 0.6 };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: [] };
    return result;
  }

  const activityList = buildRelativeActivity(safeBranches);
  const activityMap = new Map(activityList.map((x) => [x.branchId, x.activity]));
  const promptIntents = detectIntentTags(text);

  const scored = safeBranches.map((b) => computeBranchScore({
    prompt: text,
    promptKeys,
    promptIntents,
    branch: b,
    activeBranchId,
    activityMap,
  }));

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];

  // Strong return signal: if user says back/return and a title matches, prefer that existing branch.
  const backSignal = /\b(back to|return to|again|as before)\b/.test(text.toLowerCase());
  if (backSignal) {
    const titleBest = [...scored].sort((a, b) => b.title - a.title)[0];
    if (titleBest && titleBest.title >= 0.34) {
      const result = {
        action: 'auto_existing_back_signal',
        branchId: titleBest.branchId,
        confidence: Math.max(titleBest.score, titleBest.title),
        score: titleBest.score,
      };
      if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: scored, activity: activityList };
      return result;
    }
  }

  // Ambiguous routing: if top-2 are too close, keep active branch to reduce branch thrashing.
  if (
    activeBranchId &&
    second &&
    best.branchId !== activeBranchId &&
    Math.abs(best.score - second.score) < ambiguityMargin
  ) {
    const result = { action: 'auto_existing_ambiguous', branchId: activeBranchId, confidence: best.score, score: best.score };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: scored, activity: activityList };
    return result;
  }

  // Explicit switch wording should lower resistance to branch split.
  if (explicitSwitchSignal(text) && best && best.branchId === activeBranchId && best.score < (createThreshold + 0.1)) {
    const title = promptKeys.slice(0, 4).join('-') || 'new-topic';
    const result = {
      action: 'auto_new_explicit_switch',
      branchId: '',
      confidence: Math.max(0.5, 1 - (best?.score || 0)),
      score: best?.score || 0,
      newTitle: title,
    };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: scored, activity: activityList };
    return result;
  }

  if (!best || best.score < createThreshold) {
    const title = promptKeys.slice(0, 4).join('-') || 'new-topic';
    const result = {
      action: 'auto_new',
      branchId: '',
      confidence: 1 - (best?.score || 0),
      score: best?.score || 0,
      newTitle: title,
    };
    if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: scored, activity: activityList };
    return result;
  }

  const result = { action: 'auto_existing', branchId: best.branchId, confidence: best.score, score: best.score };
  if (returnDiagnostics) result.diagnostics = { promptKeys, candidates: scored, activity: activityList };
  return result;
}
