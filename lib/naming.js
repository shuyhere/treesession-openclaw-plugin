function sanitizeTitle(s = '', fallback = 'new-topic') {
  const cleaned = (s || '')
    .replace(/[`"'\[\]{}()<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function resolveModelName(cfg, runtimeModel = '') {
  if (cfg.branchNamingModel === 'same' && runtimeModel) return runtimeModel;
  return cfg.branchNamingModel || runtimeModel || 'gpt-4o-mini';
}

function extractTextResult(result) {
  if (typeof result === 'string') return result;
  return result?.content || result?.text || result?.choices?.[0]?.message?.content || '';
}

async function postChat({ promptSystem, promptUser, cfg, log, runtimeModel, invokeModel, maxTokens = 64, temperature = 0.2 }) {
  // 1. Try internal runtime invocation (no API key needed)
  if (typeof invokeModel === 'function') {
    try {
      const result = await invokeModel({ system: promptSystem, user: promptUser, maxTokens, temperature });
      const text = extractTextResult(result);
      if (text) return text;
    } catch (err) {
      log?.warn?.(`[treesession] naming internal invoke failed; trying HTTP. ${String(err)}`);
    }
  }

  // 2. Fall back to external HTTP if API key is available
  if (!cfg.branchNamingApiKey) {
    log?.warn?.('[treesession] branchNamingApiKey missing and no invokeModel; skip model call');
    return '';
  }

  const model = resolveModelName(cfg, runtimeModel);
  const baseUrl = (cfg.branchNamingBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const endpoint = `${baseUrl}/chat/completions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.branchNamingApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: promptSystem },
          { role: 'user', content: promptUser },
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      log?.warn?.(`[treesession] model call failed (${res.status}); ${txt.slice(0, 200)}`);
      return '';
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    log?.warn?.(`[treesession] model call error; ${String(err)}`);
    return '';
  }
}

export async function generateBranchTitle({ prompt, cfg, fallbackTitle, log, runtimeModel = '', invokeModel }) {
  if (cfg.branchNamingMode !== 'model') return sanitizeTitle(fallbackTitle, 'new-topic');

  const system =
    'You generate concise topic branch names for conversation routing. Return only the title text, max 6 words, no punctuation at ends.';
  const user = `Conversation turn:\n${prompt}\n\nReturn a concise branch title.`;

  const text = await postChat({
    promptSystem: system,
    promptUser: user,
    cfg,
    log,
    runtimeModel,
    invokeModel,
    maxTokens: 24,
    temperature: 0.2,
  });

  if (!text) return sanitizeTitle(fallbackTitle, 'new-topic');
  return sanitizeTitle(text, fallbackTitle || 'new-topic');
}

export async function modelRouteDecision({ prompt, branches, activeBranchId, cfg, log, runtimeModel = '', invokeModel }) {
  const compact = (branches || []).slice(0, 60).map((b) => ({
    id: b.id,
    title: b.title,
    path: b.path,
    parentId: b.parentId || null,
    summary: (b.summary || '').slice(0, 180),
    keywords: (b.keywords || []).slice(0, 8),
  }));

  const system = [
    'You are a routing controller for hierarchical conversation branches.',
    'Decide whether to route to an existing branch or create a new branch.',
    'Output STRICT JSON only: {"decision":"existing|new","branchId":"...","newTitle":"...","parentBranchId":"..."}.',
    'If decision=existing, provide branchId from provided branches.',
    'If decision=new, provide newTitle and optional parentBranchId (or null).',
  ].join(' ');

  const user = JSON.stringify(
    {
      prompt,
      activeBranchId: activeBranchId || null,
      branches: compact,
    },
    null,
    2,
  );

  const text = await postChat({
    promptSystem: system,
    promptUser: user,
    cfg,
    log,
    runtimeModel,
    invokeModel,
    maxTokens: 120,
    temperature: 0,
  });

  if (!text) return null;

  try {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) return null;
    const obj = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

    if (obj?.decision === 'existing' && obj.branchId) {
      return { action: 'model_existing', branchId: String(obj.branchId) };
    }

    if (obj?.decision === 'new') {
      return {
        action: 'model_new',
        branchId: '',
        newTitle: sanitizeTitle(obj.newTitle || '', 'new-topic'),
        parentBranchId: obj.parentBranchId || null,
      };
    }
  } catch {
    return null;
  }

  return null;
}
