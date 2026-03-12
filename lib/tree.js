function slugify(s = '') {
  const x = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return x || 'new-topic';
}

export function normalize(s = '') {
  return String(s || '').toLowerCase().trim();
}

export function findBranchByTarget(state, target = '') {
  const t = normalize(target);
  if (!t) return null;

  return (
    state.branches.find((b) => b.id === target) ||
    state.branches.find((b) => normalize(b.path || '') === t) ||
    state.branches.find((b) => normalize(b.title || '') === t) ||
    null
  );
}

export function computePath(branch, byId) {
  const parts = [slugify(branch.title || 'topic')];
  let cur = branch;
  let guard = 0;
  while (cur?.parentId && guard < 64) {
    const p = byId.get(cur.parentId);
    if (!p) break;
    parts.push(slugify(p.title || 'topic'));
    cur = p;
    guard += 1;
  }
  return parts.reverse().join('/');
}

export function recomputeAllPaths(state) {
  const byId = new Map(state.branches.map((b) => [b.id, b]));
  for (const b of state.branches) {
    b.path = computePath(b, byId);
  }
}

export function branchDepth(branch, byId) {
  let d = 0;
  let cur = branch;
  let guard = 0;
  while (cur?.parentId && guard < 64) {
    const p = byId.get(cur.parentId);
    if (!p) break;
    d += 1;
    cur = p;
    guard += 1;
  }
  return d;
}

export function hydrateBranchStats(state) {
  if (!state?.branches?.length) return;
  const byId = new Map(state.branches.map((b) => [b.id, b]));

  for (const b of state.branches) {
    const turns = Array.isArray(b.turns) ? b.turns : [];

    if (!Number.isFinite(b.userTurnCount)) {
      b.userTurnCount = turns.filter((t) => t?.role === 'user').length;
    }
    if (!Number.isFinite(b.assistantTurnCount)) {
      b.assistantTurnCount = turns.filter((t) => t?.role === 'assistant').length;
    }
    if (!Number.isFinite(b.turnCount)) {
      b.turnCount = b.userTurnCount + b.assistantTurnCount;
    }

    b.depth = branchDepth(b, byId);
  }
}

function escMermaidLabel(s = '') {
  return String(s || '')
    .replace(/"/g, "'")
    .replace(/\n/g, ' ')
    .trim();
}

function mermaidNodeId(branchId = '') {
  return `b_${String(branchId).replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function renderMermaidTree(state, opts = {}) {
  const branches = Array.isArray(state?.branches) ? state.branches : [];
  if (!branches.length) return 'flowchart TD\n  EMPTY["No branches yet"]';

  const includeAssistantTurns = opts.includeAssistantTurns !== false;
  hydrateBranchStats(state);

  const byId = new Map(branches.map((b) => [b.id, b]));
  const lines = ['flowchart TD'];

  for (const b of branches) {
    const id = mermaidNodeId(b.id);
    const userTurns = Number.isFinite(b.userTurnCount) ? b.userTurnCount : 0;
    const assistantTurns = Number.isFinite(b.assistantTurnCount) ? b.assistantTurnCount : 0;
    const depth = Number.isFinite(b.depth) ? b.depth : branchDepth(b, byId);
    const activeMark = b.id === state.activeBranchId ? ' | active' : '';

    const parts = [
      escMermaidLabel(b.title || b.path || b.id),
      `depth:${depth}`,
      `u:${userTurns}`,
    ];
    if (includeAssistantTurns) parts.push(`a:${assistantTurns}`);
    if (b.path) parts.push(escMermaidLabel(b.path));

    lines.push(`  ${id}["${parts.join(' | ')}${activeMark}"]`);
  }

  for (const b of branches) {
    if (!b.parentId) continue;
    const p = byId.get(b.parentId);
    if (!p) continue;
    lines.push(`  ${mermaidNodeId(p.id)} --> ${mermaidNodeId(b.id)}`);
  }

  return lines.join('\n');
}

export function mergeBranchInto(state, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const source = state.branches.find((b) => b.id === sourceId);
  const target = state.branches.find((b) => b.id === targetId);
  if (!source || !target) return false;

  // move turns
  target.turns = [...(target.turns || []), ...(source.turns || [])]
    .sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0))
    .slice(-300);

  // merge summary
  if (source.summary) {
    const merged = [target.summary || '', source.summary].filter(Boolean).join(' | ');
    target.summary = merged.slice(0, 800);
  }

  // merge keywords
  const ks = new Set([...(target.keywords || []), ...(source.keywords || [])]);
  target.keywords = [...ks].slice(0, 30);
  target.userTurnCount = (target.userTurnCount || 0) + (source.userTurnCount || 0);
  target.assistantTurnCount = (target.assistantTurnCount || 0) + (source.assistantTurnCount || 0);
  target.turnCount = (target.turnCount || 0) + (source.turnCount || 0);
  target.lastActiveAt = new Date().toISOString();

  // reparent children of source -> target
  for (const b of state.branches) {
    if (b.parentId === source.id) b.parentId = target.id;
  }

  // drop source
  state.branches = state.branches.filter((b) => b.id !== source.id);

  if (state.activeBranchId === source.id) state.activeBranchId = target.id;
  recomputeAllPaths(state);
  return true;
}
