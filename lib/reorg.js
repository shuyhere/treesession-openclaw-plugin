function norm(s = '') {
  return String(s || '').toLowerCase().trim();
}

function slug(s = '') {
  return norm(s)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'branch';
}

function safeDate(ts) {
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

export function listInactiveBranches(branches = [], activeBranchId = '', idleDays = 7) {
  const cutoff = Date.now() - idleDays * 24 * 60 * 60 * 1000;
  return branches.filter((b) => b.id !== activeBranchId && safeDate(b.lastActiveAt) < cutoff);
}

export function updateSubtreePaths(branches = [], rootId) {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const children = new Map();
  for (const b of branches) {
    const p = b.parentId || '__root__';
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(b);
  }

  const walk = (id) => {
    const parent = byId.get(id);
    if (!parent) return;
    const kids = children.get(id) || [];
    for (const k of kids) {
      const leaf = slug(k.title || k.path || k.id);
      k.path = parent.path ? `${parent.path}/${leaf}` : leaf;
      walk(k.id);
    }
  };

  walk(rootId);
}

export function moveBranch(branches = [], branchId, newParentId = null) {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const node = byId.get(branchId);
  if (!node) return false;
  if (newParentId === branchId) return false;

  if (newParentId) {
    // cycle guard: cannot move under own descendant
    let cur = byId.get(newParentId);
    while (cur) {
      if (cur.id === branchId) return false;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
  }

  node.parentId = newParentId || null;

  const leaf = slug(node.title || node.path || node.id);
  if (!newParentId) {
    node.path = leaf;
  } else {
    const parent = byId.get(newParentId);
    node.path = parent?.path ? `${parent.path}/${leaf}` : leaf;
  }

  updateSubtreePaths(branches, node.id);
  return true;
}

export function mergeBranches(branches = [], sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return false;

  const byId = new Map(branches.map((b) => [b.id, b]));
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target) return false;

  target.turns = [...(target.turns || []), ...(source.turns || [])]
    .sort((a, b) => safeDate(a.ts) - safeDate(b.ts))
    .slice(-300);

  target.keywords = Array.from(new Set([...(target.keywords || []), ...(source.keywords || [])])).slice(0, 20);

  if (!target.summary && source.summary) target.summary = source.summary;
  target.turnCount = (target.turnCount || 0) + (source.turnCount || 0);
  target.lastActiveAt = new Date(Math.max(safeDate(target.lastActiveAt), safeDate(source.lastActiveAt))).toISOString();

  // move children under target
  for (const b of branches) {
    if (b.parentId === source.id) b.parentId = target.id;
  }

  // remove source
  const i = branches.findIndex((b) => b.id === source.id);
  if (i >= 0) branches.splice(i, 1);

  // re-path target subtree
  updateSubtreePaths(branches, target.id);
  return true;
}

function modelName(cfg, runtimeModel = '') {
  if (cfg.branchNamingModel === 'same' && runtimeModel) return runtimeModel;
  return cfg.branchNamingModel || runtimeModel || 'gpt-4o-mini';
}

function extractTextResult(result) {
  if (typeof result === 'string') return result;
  return result?.content || result?.text || result?.choices?.[0]?.message?.content || '';
}

async function callModel({ cfg, runtimeModel, invokeModel, log, system, user, maxTokens = 220 }) {
  // 1. Try internal runtime invocation
  if (typeof invokeModel === 'function') {
    try {
      const result = await invokeModel({ system, user, maxTokens, temperature: 0 });
      const text = extractTextResult(result);
      if (text) return text;
    } catch (err) {
      log?.warn?.(`[treesession] reorg internal invoke failed; trying HTTP. ${String(err)}`);
    }
  }

  // 2. Fall back to external HTTP
  if (!cfg.branchNamingApiKey) return '';
  const endpoint = `${(cfg.branchNamingBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.branchNamingApiKey}`,
      },
      body: JSON.stringify({
        model: modelName(cfg, runtimeModel),
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      log.warn?.(`[treesession] reorg model call failed (${res.status})`);
      return '';
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || '';
  } catch (e) {
    log.warn?.(`[treesession] reorg model call error: ${String(e)}`);
    return '';
  }
}

export async function modelSuggestReorg({ branches = [], activeBranchId = '', idleDays = 7, cfg, runtimeModel, invokeModel, log }) {
  const inactive = listInactiveBranches(branches, activeBranchId, idleDays).map((b) => ({
    id: b.id,
    title: b.title,
    path: b.path,
    parentId: b.parentId || null,
    summary: (b.summary || '').slice(0, 200),
    keywords: (b.keywords || []).slice(0, 10),
  }));

  if (!inactive.length) return [];

  const system = [
    'You organize hierarchical conversation branches.',
    'For inactive branches only, suggest merge/move operations.',
    'Return STRICT JSON: {"ops":[{"kind":"merge","sourceId":"...","targetId":"..."},{"kind":"move","branchId":"...","newParentId":"...|null"}]}.',
    'Never touch active branch. Prefer conservative edits (0-3 ops).',
  ].join(' ');

  const user = JSON.stringify(
    {
      activeBranchId,
      inactiveBranches: inactive,
      allBranches: branches.slice(0, 120).map((b) => ({ id: b.id, path: b.path, title: b.title, parentId: b.parentId || null })),
    },
    null,
    2,
  );

  const text = await callModel({ cfg, runtimeModel, invokeModel, log, system, user });
  if (!text) return [];

  try {
    const a = text.indexOf('{');
    const z = text.lastIndexOf('}');
    if (a < 0 || z < 0 || z <= a) return [];
    const obj = JSON.parse(text.slice(a, z + 1));
    const ops = Array.isArray(obj?.ops) ? obj.ops : [];
    return ops.slice(0, 3);
  } catch {
    return [];
  }
}

export function applyReorgOps({ branches = [], ops = [], activeBranchId = '' }) {
  const applied = [];
  for (const op of ops) {
    if (op?.kind === 'merge' && op.sourceId && op.targetId) {
      if (op.sourceId === activeBranchId || op.targetId === activeBranchId) continue;
      const ok = mergeBranches(branches, String(op.sourceId), String(op.targetId));
      if (ok) applied.push({ kind: 'merge', sourceId: String(op.sourceId), targetId: String(op.targetId) });
      continue;
    }

    if (op?.kind === 'move' && op.branchId) {
      if (op.branchId === activeBranchId) continue;
      const newParentId = op.newParentId ? String(op.newParentId) : null;
      if (newParentId === activeBranchId) continue;
      const ok = moveBranch(branches, String(op.branchId), newParentId);
      if (ok) applied.push({ kind: 'move', branchId: String(op.branchId), newParentId });
    }
  }
  return applied;
}
