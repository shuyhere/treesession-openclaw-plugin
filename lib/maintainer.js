import { mergeBranchInto, recomputeAllPaths } from './tree.js';

function daysIdle(lastActiveAt) {
  if (!lastActiveAt) return 999;
  const ms = Date.now() - new Date(lastActiveAt).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function safeParseJsonBlock(text = '') {
  const m = String(text || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function extractTextResult(result) {
  if (typeof result === 'string') return result;
  return result?.content || result?.text || result?.choices?.[0]?.message?.content || '';
}

async function invokeReorgModel({ system, user, invokeModel, cfg, runtimeModel, log, maxTokens = 220, temperature = 0.1 }) {
  // 1. Try internal runtime invocation
  if (typeof invokeModel === 'function') {
    try {
      const result = await invokeModel({ system, user, maxTokens, temperature });
      const text = extractTextResult(result);
      if (text) return text;
    } catch (err) {
      log?.warn?.(`[treesession] reorg internal invoke failed; trying HTTP. ${String(err)}`);
    }
  }

  // 2. Fall back to external HTTP
  if (!cfg.modelRoutingApiKey) {
    log?.warn?.('[treesession] reorg: no invokeModel and no api key; skip');
    return '';
  }

  const model =
    (cfg.modelRoutingModel === 'same' ? runtimeModel : '') ||
    runtimeModel ||
    cfg.modelRoutingModel ||
    cfg.modelRoutingModelFallback ||
    'gpt-4o-mini';
  const baseUrl = (cfg.modelRoutingBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.modelRoutingApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.warn?.(`[treesession] reorg request failed ${res.status}: ${txt.slice(0, 160)}`);
      return '';
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    log?.warn?.(`[treesession] reorg HTTP error: ${String(err)}`);
    return '';
  }
}

export async function modelReorganizeTree({ state, cfg, runtimeModel, invokeModel, force = false, log }) {
  if (!cfg.autoReorgEnabled && !force) return { changed: false, reason: 'disabled' };

  const candidates = state.branches.filter((b) => daysIdle(b.lastActiveAt) >= cfg.reorgIdleDays);
  if (!force && candidates.length < 2) return { changed: false, reason: 'not_enough_idle' };

  // Need either invokeModel or API key
  if (typeof invokeModel !== 'function' && !cfg.modelRoutingApiKey) {
    return { changed: false, reason: 'no_invocation_path' };
  }

  const payload = {
    branches: state.branches.map((b) => ({
      id: b.id,
      title: b.title,
      path: b.path || '',
      parentId: b.parentId || '',
      turnCount: b.turnCount || 0,
      lastActiveAt: b.lastActiveAt || '',
      summary: (b.summary || '').slice(0, 160),
    })),
    idleDaysThreshold: cfg.reorgIdleDays,
    maxOps: cfg.reorgMaxOps,
    task: 'Suggest merge operations for idle overlapping branches. Return strict JSON array: [{"op":"merge","sourceId":"...","targetId":"..."}]',
  };

  try {
    const content = await invokeReorgModel({
      system: 'You are a branch-tree maintainer. Only return JSON.',
      user: JSON.stringify(payload),
      invokeModel,
      cfg,
      runtimeModel,
      log,
    });

    if (!content) return { changed: false, reason: 'no_response' };

    const parsed = safeParseJsonBlock(content);
    const ops = Array.isArray(parsed) ? parsed : [];

    let applied = 0;
    for (const op of ops.slice(0, cfg.reorgMaxOps)) {
      if (op?.op !== 'merge') continue;
      if (mergeBranchInto(state, op.sourceId, op.targetId)) applied += 1;
    }

    if (applied > 0) {
      state.lastReorgAt = new Date().toISOString();
      recomputeAllPaths(state);
      return { changed: true, applied };
    }
    return { changed: false, reason: 'no_ops' };
  } catch (err) {
    log?.warn?.(`[treesession] reorg error: ${String(err)}`);
    return { changed: false, reason: 'error' };
  }
}
