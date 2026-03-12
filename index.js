#!/usr/bin/env node
import { loadState, saveState, createBranch } from './lib/store.js';
import { parseForcedTopic, routePromptToBranch } from './lib/router.js';
import { composePrependedContext, maybeRefreshSummary } from './lib/composer.js';
import { topKeywords } from './lib/util.js';
import { generateBranchTitle } from './lib/naming.js';
import { parseBranchCommand } from './lib/commands.js';
import { routeWithModel } from './lib/model-router.js';

import { findBranchByTarget, mergeBranchInto, recomputeAllPaths, hydrateBranchStats, renderMermaidTree } from './lib/tree.js';
import { modelReorganizeTree } from './lib/maintainer.js';

function getCfg(pluginConfig = {}) {
  return {
    enabled: pluginConfig.enabled !== false,
    storageDir: pluginConfig.storageDir || '~/.openclaw/treesession-store',
    recentTurns: pluginConfig.recentTurns ?? 8,
    retrievalTurns: pluginConfig.retrievalTurns ?? 6,
    summaryEveryTurns: pluginConfig.summaryEveryTurns ?? 10,
    maxBranches: pluginConfig.maxBranches ?? 80,
    branchCreateThreshold: pluginConfig.branchCreateThreshold ?? 0.22,
    shortTurnMinChars: pluginConfig.shortTurnMinChars ?? 8,
    forceTopicPrefix: pluginConfig.forceTopicPrefix || 'topic:',
    includeSiblingFallback: pluginConfig.includeSiblingFallback === true,
    maxPrependedChars: pluginConfig.maxPrependedChars ?? 6000,
    branchTurns: pluginConfig.branchTurns ?? 10,

    // Naming
    branchNamingMode: pluginConfig.branchNamingMode || 'model',
    branchNamingModel:
      pluginConfig.branchNamingModel ||
      pluginConfig.branchNamingModelFallback ||
      process.env.TREESESSION_BRANCH_NAMING_MODEL ||
      'same',
    branchNamingBaseUrl:
      pluginConfig.branchNamingBaseUrl || process.env.OPENAI_BASE_URL || process.env.TREESESSION_BRANCH_NAMING_BASE_URL || 'https://api.openai.com/v1',
    branchNamingApiKey:
      pluginConfig.branchNamingApiKey || process.env.OPENAI_API_KEY || process.env.TREESESSION_BRANCH_NAMING_API_KEY || '',

    // Routing
    routingStrategy: pluginConfig.routingStrategy || 'hybrid', // score | model | hybrid
    hybridModelFallbackThreshold: pluginConfig.hybridModelFallbackThreshold ?? 0.32,
    hybridAmbiguityMargin: pluginConfig.hybridAmbiguityMargin ?? 0.08,
    modelRoutingModel:
      pluginConfig.modelRoutingModel ||
      pluginConfig.modelRoutingModelFallback ||
      process.env.TREESESSION_MODEL_ROUTING_MODEL ||
      'same',
    modelRoutingBaseUrl:
      pluginConfig.modelRoutingBaseUrl || process.env.OPENAI_BASE_URL || process.env.TREESESSION_MODEL_ROUTING_BASE_URL || 'https://api.openai.com/v1',
    modelRoutingApiKey:
      pluginConfig.modelRoutingApiKey || process.env.OPENAI_API_KEY || process.env.TREESESSION_MODEL_ROUTING_API_KEY || '',

    // Tree reorganization
    autoReorgEnabled: pluginConfig.autoReorgEnabled !== false,
    reorgIdleDays: pluginConfig.reorgIdleDays ?? 7,
    reorgCooldownHours: pluginConfig.reorgCooldownHours ?? 24,
    reorgMaxOps: pluginConfig.reorgMaxOps ?? 3,
  };
}

/**
 * Build an internal model invocation function from the plugin API.
 *
 * Strategy (ordered by preference):
 *  1. Direct method on api (api.callModel / api.invokeModel / etc.) — future-proof.
 *  2. OpenClaw gateway loopback (/v1/chat/completions) — uses the gateway's own
 *     model routing, so credentials are resolved by the gateway itself.
 *  3. HTTP call to provider from api.config.models.providers — direct provider call.
 *  4. Returns null — caller falls back to score-only routing.
 */
function makeInvokeModel(api) {
  const log = api?.logger ?? console;

  // ── 1. Direct method (future OpenClaw versions may expose this) ────
  const directFn = api?.callModel || api?.invokeModel || api?.chat || api?.completeChat || null;
  if (typeof directFn === 'function') {
    log.info?.('[treesession] invokeModel: using direct api method');
    return async ({ system, user, maxTokens = 120, temperature = 0.1, tools, tool_choice }) => {
      const params = {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        max_tokens: maxTokens,
        temperature,
      };
      if (tools) params.tools = tools;
      if (tool_choice) params.tool_choice = tool_choice;
      const result = await directFn(params);
      // Return raw response when tool_calls present so caller can extract them
      if (result?.choices?.[0]?.message?.tool_calls) return result;
      if (typeof result === 'string') return result;
      return result?.content || result?.text || result?.choices?.[0]?.message?.content || '';
    };
  }

  // ── 2. Gateway loopback (/v1/chat/completions) ─────────────────────
  const gwPort = api?.config?.gateway?.port || 18789;
  const gwAuth = api?.config?.gateway?.auth || {};
  const gwChatEnabled = api?.config?.gateway?.http?.endpoints?.chatCompletions?.enabled;
  // Resolve model id from agent defaults or first provider model
  const agentModel = api?.config?.agents?.defaults?.model?.primary || '';
  const providers = api?.config?.models?.providers;

  let providerModelId = '';
  let providerBaseUrl = '';
  let providerApiKey = '';
  let providerName = '';

  if (providers && typeof providers === 'object') {
    for (const [name, prov] of Object.entries(providers)) {
      if (prov?.baseUrl && Array.isArray(prov.models) && prov.models.length > 0) {
        providerBaseUrl = prov.baseUrl.replace(/\/$/, '');
        providerApiKey = prov.apiKey || '';
        providerModelId = prov.models[0].id;
        providerName = name;
        break;
      }
    }
  }

  // Use the same model the agent uses — no external model, no downgrade.
  // The gateway routes through the same native auth the agent already has.
  const modelId = agentModel || providerModelId || 'claude-sonnet-4-6';

  // Timeout for model routing calls
  const ROUTING_TIMEOUT_MS = 30_000;

  if (gwChatEnabled) {
    const gwUrl = `http://127.0.0.1:${gwPort}/v1/chat/completions`;
    const gwHeaders = { 'Content-Type': 'application/json' };
    if (gwAuth.mode === 'password' && gwAuth.password) {
      gwHeaders['Authorization'] = `Bearer ${gwAuth.password}`;
    } else if (gwAuth.mode === 'token' && gwAuth.token) {
      gwHeaders['Authorization'] = `Bearer ${gwAuth.token}`;
    }

    log.info?.(`[treesession] invokeModel: using gateway loopback at ${gwUrl} (model: ${modelId}, timeout: ${ROUTING_TIMEOUT_MS}ms)`);

    return async ({ system, user, maxTokens = 120, temperature = 0.1, tools, tool_choice }) => {
      try {
        const body = {
          model: modelId,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        };
        if (tools) body.tools = tools;
        if (tool_choice) body.tool_choice = tool_choice;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
        const res = await fetch(gwUrl, {
          method: 'POST',
          headers: gwHeaders,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          log.warn?.(`[treesession] invokeModel gateway HTTP ${res.status}: ${txt.slice(0, 200)}`);
          throw new Error(`gateway HTTP ${res.status}`);
        }

        const data = await res.json();
        // Return raw response when tool_calls present
        if (data?.choices?.[0]?.message?.tool_calls) return data;
        return data?.choices?.[0]?.message?.content || '';
      } catch (err) {
        log.warn?.(`[treesession] invokeModel gateway error: ${String(err)}`);
        // Throw instead of returning '' so the model-router catch block
        // triggers and falls through to the HTTP fallback path.
        throw err;
      }
    };
  }

  // ── 3. Direct provider HTTP call ───────────────────────────────────
  if (providerBaseUrl) {
    log.info?.(`[treesession] invokeModel: using provider "${providerName}" at ${providerBaseUrl} (model: ${providerModelId})`);

    return async ({ system, user, maxTokens = 120, temperature = 0.1, tools, tool_choice }) => {
      const endpoint = `${providerBaseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (providerApiKey) headers['Authorization'] = `Bearer ${providerApiKey}`;

      try {
        const body = {
          model: providerModelId,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        };
        if (tools) body.tools = tools;
        if (tool_choice) body.tool_choice = tool_choice;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          log.warn?.(`[treesession] invokeModel provider HTTP ${res.status}: ${txt.slice(0, 200)}`);
          throw new Error(`provider HTTP ${res.status}`);
        }

        const data = await res.json();
        // Return raw response when tool_calls present
        if (data?.choices?.[0]?.message?.tool_calls) return data;
        return data?.choices?.[0]?.message?.content || '';
      } catch (err) {
        log.warn?.(`[treesession] invokeModel provider error: ${String(err)}`);
        throw err;
      }
    };
  }

  // ── 4. No invocation path ──────────────────────────────────────────
  log.warn?.('[treesession] invokeModel: no api method, no gateway chatCompletions, no provider; model calls disabled');
  return null;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .join('\n')
      .trim();
  }
  return content.text || content.content || '';
}

/**
 * Strip treesession envelopes and OpenClaw metadata wrappers from text.
 * Preserves multi-line user content; only strips known envelope patterns.
 */
function stripTreesessionEnvelope(text = '') {
  let t = String(text || '');
  const marker = 'Instruction: Use branch-scoped context from this file-tree memory. Do NOT mix unrelated branches unless user asks.';

  // Remove one or more prepended treesession envelopes from the front.
  while (t.trimStart().startsWith('=== treesession context manager ===') || t.trimStart().startsWith('=== treesession branch context ===')) {
    const idx = t.indexOf(marker);
    if (idx < 0) {
      // Try alternate closing marker.
      const altMarker = 'Instruction: Answer using only the active branch context unless user explicitly asks to mix branches.';
      const altIdx = t.indexOf(altMarker);
      if (altIdx < 0) break;
      t = t.slice(altIdx + altMarker.length).trimStart();
      continue;
    }
    t = t.slice(idx + marker.length).trimStart();
  }

  // Remove OpenClaw metadata wrappers that are forwarded in the raw user text.
  // These come as: "Label (untrusted metadata):\n```json\n{...}\n```"
  t = t.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/gi, '');
  t = t.replace(/Chat history since last reply \(untrusted, for context\):[\s\S]*?```\s*/gi, '');
  // Fallback: strip any remaining "...(untrusted metadata):" blocks with JSON
  t = t.replace(/\w[\w\s]*\(untrusted(?:\s+metadata)?\)\s*:\s*```[\s\S]*?```\s*/gi, '');
  // Strip raw JSON blocks containing message_id/sender_id (Discord metadata leaked without label)
  t = t.replace(/```json\s*\{[^}]*"(?:message_id|sender_id|sender|timestamp)"[^}]*\}\s*```/gi, '');

  // Remove JSON envelope fragments and branch file tree dumps.
  t = t.replace(/Branch file tree \(\* active\):[\s\S]*$/gi, '');

  // Keep mention payload tail when present (e.g., "@coder ...").
  const mentionMatch = t.match(/@\w+[\s\S]*$/);
  if (mentionMatch) t = mentionMatch[0];

  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Extra cleaning for content before storing as a branch turn.
 * Prevents metadata/envelope fragments from polluting stored memory.
 */
function cleanContentForStorage(text = '') {
  let t = stripTreesessionEnvelope(text);

  // Drop residual metadata noise patterns.
  t = t.replace(/"message_id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"channel_id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"sender_id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"sender"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"timestamp"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"label"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"username"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"tag"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"name"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/"id"\s*:\s*"[^"]*"/g, '');
  t = t.replace(/\bjson\s*\{[\s\S]*$/gi, '');
  // Strip OpenClaw reply routing tags
  t = t.replace(/\[\[reply_to_\w+\]\]/g, '');
  // Strip residual empty JSON objects and curly braces
  t = t.replace(/\{\s*[,\s]*\}/g, '');

  return t.replace(/\s+/g, ' ').trim();
}

function pickLastTurn(event) {
  const msgs = event?.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
  const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant');
  const user = cleanContentForStorage(extractText(lastUser?.content));
  const assistant = cleanContentForStorage(extractText(lastAssistant?.content));
  return { user, assistant };
}

function getRuntimeModelId(event, ctx) {
  return event?.model || event?.modelId || event?.resolvedModel || ctx?.model || ctx?.modelId || '';
}

function boundedPushBranch(state, branch, maxBranches) {
  if (state.branches.length >= maxBranches) {
    state.branches.sort((a, b) => new Date(a.lastActiveAt) - new Date(b.lastActiveAt));
    state.branches = state.branches.slice(-maxBranches + 1);
  }
  state.branches.push(branch);
}

function needAutoReorg(state, cfg) {
  if (!cfg.autoReorgEnabled) return false;
  const last = state.lastReorgAt ? new Date(state.lastReorgAt).getTime() : 0;
  const cooldownMs = cfg.reorgCooldownHours * 60 * 60 * 1000;
  return !last || Date.now() - last >= cooldownMs;
}

function refreshBranchRouteSummary(branch) {
  if (!branch) return;
  const tail = (branch.turns || [])
    .slice(-10)
    .map((t) => cleanContentForStorage(t.content))
    .filter((c) => c.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!tail) return;
  branch.routeSummary = tail.slice(0, 260);
  if (!branch.summary) branch.summary = tail.slice(0, 380);
}

function normalizeRouteDecision({ turn, route, branch, createdNew }) {
  return {
    turn,
    nodeId: branch?.id || '',
    title: branch?.title || route?.newTitle || 'new-topic',
    parentId: branch?.parentId || 'root',
    action: createdNew ? 'new' : 'existing',
    confidence: Number(route?.confidence ?? route?.score ?? 0.5),
  };
}

function resolveSessionRoutingKey(ctx, event) {
  const candidates = [
    ctx?.sessionKey,
    ctx?.threadId,
    ctx?.subagentThreadId,
    event?.threadId,
    event?.subagentThreadId,
    event?.chatId,
  ].filter(Boolean);

  // Keep backward compatibility: if only sessionKey exists, key remains unchanged.
  if (candidates.length <= 1) return candidates[0] || 'session';
  return candidates.join('::');
}

function estimateTokensApprox(text = '') {
  return Math.max(0, Math.ceil((text || '').length / 4));
}

/**
 * Detect if a prompt is an internal treesession routing/naming call
 * that was re-entered through the gateway chatCompletions endpoint.
 * These must be skipped to prevent infinite recursion.
 */
function isInternalRoutingCall(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  // Routing payloads always contain these JSON keys
  if (prompt.includes('"activeBranchId"') && prompt.includes('"branches"')) return true;
  if (prompt.includes('"activeBranchId"') && prompt.includes('"previousUserTurn"')) return true;
  // Branch naming payloads
  if (prompt.includes('Return a concise branch title') || prompt.includes('concise branch title')) return true;
  if (prompt.includes('Conversation turn:') && prompt.includes('branch title')) return true;
  // Route judge system prompts that leaked into user content
  if (prompt.includes('route judge for hierarchical conversation branches')) return true;
  // JSON-only routing fallback
  if (prompt.includes('"action":"existing"') && prompt.includes('"confidence"')) return true;
  if (prompt.includes('"action":"new"') && prompt.includes('"confidence"')) return true;
  return false;
}

/**
 * Check ALL message content in an event for internal routing patterns.
 * The gateway may pass the prompt in event.prompt, event.messages, or both.
 */
function isInternalRoutingEvent(event) {
  // Check event.prompt
  const prompt = extractText(event?.prompt);
  if (isInternalRoutingCall(prompt)) return true;
  // Check all messages
  const msgs = event?.messages || [];
  for (const m of msgs) {
    const text = extractText(m?.content);
    if (isInternalRoutingCall(text)) return true;
  }
  // Check system message (routing system prompts)
  const sys = extractText(event?.system || event?.systemPrompt);
  if (sys && isInternalRoutingCall(sys)) return true;
  return false;
}

function buildRoutingHistoryTurns(activeBranch, event, prompt, maxTurns = 14) {
  const tail = (activeBranch?.turns || []).slice(-Math.max(1, maxTurns));
  const fromBranch = tail
    .map((t) => ({ role: t?.role === 'assistant' ? 'assistant' : 'user', content: String(t?.content || '') }))
    .filter((t) => t.content.trim().length > 0);

  // Also include recent visible chat turns from this run context (user + assistant), not only current prompt.
  const fromEvent = (event?.messages || [])
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: stripTreesessionEnvelope(extractText(m?.content)) }))
    .filter((t) => t.content.trim().length > 0)
    .slice(-Math.max(1, maxTurns));

  // Remove overlap between branch-tail and event-tail to avoid duplicate turn sequences.
  let overlap = 0;
  const maxOverlap = Math.min(fromBranch.length, fromEvent.length);
  for (let k = maxOverlap; k > 0; k -= 1) {
    const a = fromBranch.slice(-k);
    const b = fromEvent.slice(0, k);
    if (JSON.stringify(a) === JSON.stringify(b)) {
      overlap = k;
      break;
    }
  }

  const merged = [...fromBranch, ...fromEvent.slice(overlap)];
  const history = merged.slice(-Math.max(1, maxTurns * 2));

  if (prompt && String(prompt).trim()) {
    const p = String(prompt).trim();
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== p) history.push({ role: 'user', content: p });
  }

  return history;
}

function flattenTurnsChronological(state) {
  const all = [];
  for (const b of state?.branches || []) {
    for (const t of b?.turns || []) {
      all.push({
        role: t?.role || 'user',
        content: t?.content || '',
        ts: t?.ts || b?.lastActiveAt || b?.createdAt || '',
      });
    }
  }
  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return all;
}

export default {
  id: 'treesession-openclaw-plugin',
  name: 'treesession OpenClaw Plugin',
  description: 'Automatic routed hierarchical context/session middleware',
  kind: 'lifecycle',

  register(api) {
    const log = api.logger ?? console;
    const cfg = getCfg(api.pluginConfig);
    const runtimeRoute = new Map();
    const invokeModel = makeInvokeModel(api);

    if (invokeModel) {
      log.info?.('[treesession] model invocation ACTIVE — routing/naming will use LLM judge calls');
    } else {
      log.warn?.('[treesession] model invocation UNAVAILABLE — falling back to score-only routing. Check config.models.providers.');
    }

    function resolveCommandSessionKey(cmdCtx = {}) {
      return (
        cmdCtx.sessionKey ||
        cmdCtx.threadSessionKey ||
        cmdCtx.threadId ||
        cmdCtx.chatId ||
        `command:${cmdCtx.channel || 'unknown'}:${cmdCtx.senderId || 'unknown'}`
      );
    }

    api.registerCommand?.({
      name: 'startnewtreesession',
      nativeNames: { default: ['startnewtreesession'], discord: ['startnewtreesession'] },
      description: 'Reset current treesession and start a fresh root branch',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (cmdCtx) => {
        if (!cfg.enabled) return { text: 'treesession plugin is disabled.' };

        const sessionKey = resolveCommandSessionKey(cmdCtx);
        const agentId = cmdCtx.agentId || cmdCtx.agent || '';
        const { file, state } = await loadState(cfg.storageDir, sessionKey, agentId);

        state.activeBranchId = '';
        state.branches = [];
        state.routeTurnCounter = 0;
        state.routeDecisions = [];
        state.lastRouteDecision = null;

        const titleArg = String(cmdCtx.args || '').trim() || 'new-tree-session';
        const modelTitle = await generateBranchTitle({
          prompt: titleArg,
          cfg,
          fallbackTitle: titleArg,
          runtimeModel: '',
          invokeModel,
          log,
        });

        const branch = createBranch(modelTitle, titleArg, { parentId: null, parentPath: '' });
        boundedPushBranch(state, branch, cfg.maxBranches);
        state.activeBranchId = branch.id;
        recomputeAllPaths(state);
        hydrateBranchStats(state);
        await saveState(file, state);

        return { text: `Started new treesession. Active branch: ${branch.title}` };
      },
    });

    api.registerCommand?.({
      name: 'tokensavewithtreesession',
      nativeNames: { default: ['tokensavewithtreesession'], discord: ['tokensavewithtreesession'] },
      description: 'Show approximate token savings from treesession context',
      acceptsArgs: false,
      requireAuth: true,
      handler: async (cmdCtx) => {
        if (!cfg.enabled) return { text: 'treesession plugin is disabled.' };

        const sessionKey = resolveCommandSessionKey(cmdCtx);
        const agentId = cmdCtx.agentId || cmdCtx.agent || '';
        const { state } = await loadState(cfg.storageDir, sessionKey, agentId);
        hydrateBranchStats(state);

        const active = state.branches.find((b) => b.id === state.activeBranchId) || state.branches[0] || null;
        if (!active) return { text: 'No treesession data yet. Talk first, then run /tokensavewithtreesession.' };

        const prepended = composePrependedContext({
          branch: active,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          recentTurns: cfg.recentTurns,
          retrievalTurns: cfg.retrievalTurns,
          maxPrependedChars: cfg.maxPrependedChars,
          prompt: '',
          branchTurns: cfg.branchTurns,
        });

        const allTurns = flattenTurnsChronological(state);
        const fullHistoryText = allTurns.map((t) => `${t.role}: ${t.content}`).join('\n');
        const fullTokens = estimateTokensApprox(fullHistoryText);
        const activeTokens = estimateTokensApprox(prepended || '');
        const savedTokens = Math.max(0, fullTokens - activeTokens);
        const savedPct = fullTokens > 0 ? (savedTokens / fullTokens) * 100 : 0;

        return {
          text: [
            'treesession approximate token-saving report',
            `Session key: ${sessionKey}`,
            `Active branch: ${active.title}`,
            `Full history tokens (approx): ${fullTokens}`,
            `Active treesession context tokens (approx): ${activeTokens}`,
            `Approx tokens saved: ${savedTokens} (${savedPct.toFixed(2)}%)`,
          ].join('\n'),
        };
      },
    });

    api.on('before_agent_start', async (event, ctx) => {
      if (!cfg.enabled) return;
      if (isInternalRoutingEvent(event)) {
        log.info?.('[treesession] skipping internal routing call (before_agent_start)');
        return;
      }
      const prompt = stripTreesessionEnvelope(event?.prompt || '');
      if (!prompt || prompt.length < 2) return;

      const runtimeModel = getRuntimeModelId(event, ctx);
      const routingSessionKey = resolveSessionRoutingKey(ctx, event);
      const { file, state } = await loadState(cfg.storageDir, routingSessionKey, ctx?.agentId);
      if (typeof state.autoRoutingEnabled !== 'boolean') state.autoRoutingEnabled = true;
      if (!Number.isFinite(state.routeTurnCounter)) state.routeTurnCounter = 0;
      if (!Array.isArray(state.routeDecisions)) state.routeDecisions = [];
      hydrateBranchStats(state);

      // Periodic model reorganization on idle tree
      if (needAutoReorg(state, cfg)) {
        const r = await modelReorganizeTree({ state, cfg, runtimeModel, invokeModel, force: false, log });
        if (r.changed) log.info?.(`[treesession] auto-reorg applied (${r.applied || 0} merges)`);
      }

      // Commands
      const cmd = parseBranchCommand(prompt);

      if (cmd?.type === 'auto_mode') {
        if (cmd.action === 'on') state.autoRoutingEnabled = true;
        if (cmd.action === 'off') state.autoRoutingEnabled = false;
        if (cmd.action === 'now') state.autoRoutingEnabled = true;
        await saveState(file, state);
        const msg = `treesession auto routing: ${state.autoRoutingEnabled ? 'ON' : 'OFF'}`;
        return { prependContext: `${msg}\nAcknowledge this status briefly.` };
      }

      if (cmd?.type === 'summarize') {
        const target = cmd.query ? findBranchByTarget(state, cmd.query) : state.branches.find((b) => b.id === state.activeBranchId);
        if (target) {
          refreshBranchRouteSummary(target);
          hydrateBranchStats(state);
          await saveState(file, state);
          return { prependContext: `Refreshed branch summary for: ${target.title}. Acknowledge briefly.` };
        }
      }

      if (cmd?.type === 'start_tree') {
        state.activeBranchId = '';
        state.branches = [];
        state.routeTurnCounter = 0;
        state.routeDecisions = [];
        state.lastRouteDecision = null;

        const modelTitle = await generateBranchTitle({
          prompt: cmd.title,
          cfg,
          fallbackTitle: cmd.title || 'new-tree-session',
          runtimeModel,
          invokeModel,
          log,
        });

        const branch = createBranch(modelTitle, cmd.title || 'new-tree-session', {
          parentId: null,
          parentPath: '',
        });

        boundedPushBranch(state, branch, cfg.maxBranches);
        state.activeBranchId = branch.id;
        runtimeRoute.set(routingSessionKey, branch.id);
        recomputeAllPaths(state);
        hydrateBranchStats(state);
        await saveState(file, state);

        const prependContext = composePrependedContext({
          branch,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          recentTurns: cfg.recentTurns,
          retrievalTurns: cfg.retrievalTurns,
          maxPrependedChars: cfg.maxPrependedChars,
          prompt,
          branchTurns: cfg.branchTurns,
        });

        const msg = [
          `Started a NEW treesession for key: ${routingSessionKey}`,
          `Active branch: ${branch.title}`,
          'Acknowledge briefly and continue in this new tree session.',
        ].join('\n');

        return { prependContext: `${msg}\n\n${prependContext}` };
      }

      if (cmd?.type === 'token_save_report') {
        const active = state.branches.find((b) => b.id === state.activeBranchId) || state.branches[0] || null;
        if (!active) {
          return {
            prependContext:
              'treesession token-saving report: no active branch yet. Ask user to chat a bit first, then run tokensavewithtreesession again.',
          };
        }

        const prepended = composePrependedContext({
          branch: active,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          recentTurns: cfg.recentTurns,
          retrievalTurns: cfg.retrievalTurns,
          maxPrependedChars: cfg.maxPrependedChars,
          prompt,
          branchTurns: cfg.branchTurns,
        });

        const allTurns = flattenTurnsChronological(state);
        const fullHistoryText = allTurns.map((t) => `${t.role}: ${t.content}`).join('\n');
        const activeBranchText = prepended || '';

        const fullTokens = estimateTokensApprox(fullHistoryText);
        const activeTokens = estimateTokensApprox(activeBranchText);
        const savedTokens = Math.max(0, fullTokens - activeTokens);
        const savedPct = fullTokens > 0 ? (savedTokens / fullTokens) * 100 : 0;

        const report = [
          'treesession approximate token-saving report',
          `Session key: ${routingSessionKey}`,
          `Agent: ${ctx?.agentId || 'default'}`,
          `Active branch: ${active.title}`,
          `Full history tokens (approx): ${fullTokens}`,
          `Active treesession context tokens (approx): ${activeTokens}`,
          `Approx tokens saved: ${savedTokens} (${savedPct.toFixed(2)}%)`,
          '',
          'Reply with these numbers in a short, user-friendly summary and mention this is approximate.',
        ].join('\n');

        return { prependContext: report };
      }

      if (cmd?.type === 'new') {
        const parent = state.branches.find((b) => b.id === state.activeBranchId) || null;
        const modelTitle = await generateBranchTitle({
          prompt: cmd.title,
          cfg,
          fallbackTitle: cmd.title || 'new-branch',
          runtimeModel,
          invokeModel,
          log,
        });
        const branch = createBranch(modelTitle, prompt, {
          parentId: parent?.id || null,
          parentPath: parent?.path || '',
        });
        boundedPushBranch(state, branch, cfg.maxBranches);
        state.activeBranchId = branch.id;
        runtimeRoute.set(routingSessionKey, branch.id);
        recomputeAllPaths(state);
        hydrateBranchStats(state);
        await saveState(file, state);

        const prependContext = composePrependedContext({
          branch,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          recentTurns: cfg.recentTurns,
          retrievalTurns: cfg.retrievalTurns,
          maxPrependedChars: cfg.maxPrependedChars,
          prompt,
          branchTurns: cfg.branchTurns,
        });
        return prependContext ? { prependContext } : undefined;
      }

      if (cmd?.type === 'resume') {
        const found = findBranchByTarget(state, cmd.query);
        if (found) {
          state.activeBranchId = found.id;
          found.lastActiveAt = new Date().toISOString();
          runtimeRoute.set(routingSessionKey, found.id);
          await saveState(file, state);

          const prependContext = composePrependedContext({
            branch: found,
            branches: state.branches,
            activeBranchId: state.activeBranchId,
            recentTurns: cfg.recentTurns,
            retrievalTurns: cfg.retrievalTurns,
            maxPrependedChars: cfg.maxPrependedChars,
            prompt,
            branchTurns: cfg.branchTurns,
          });
          return prependContext ? { prependContext } : undefined;
        }
      }

      if (cmd?.type === 'merge') {
        const source = findBranchByTarget(state, cmd.source);
        const target = findBranchByTarget(state, cmd.target);
        if (source && target && source.id !== target.id) {
          mergeBranchInto(state, source.id, target.id);
          hydrateBranchStats(state);
          state.lastReorgAt = new Date().toISOString();
          await saveState(file, state);
          const active = state.branches.find((b) => b.id === state.activeBranchId) || target;
          const prependContext = composePrependedContext({
            branch: active,
            branches: state.branches,
            activeBranchId: active.id,
            recentTurns: cfg.recentTurns,
            retrievalTurns: cfg.retrievalTurns,
            maxPrependedChars: cfg.maxPrependedChars,
            prompt,
            branchTurns: cfg.branchTurns,
          });
          return prependContext ? { prependContext } : undefined;
        }
      }

      if (cmd?.type === 'reorg') {
        await modelReorganizeTree({ state, cfg, runtimeModel, invokeModel, force: true, log });
        hydrateBranchStats(state);
        await saveState(file, state);
        const active = state.branches.find((b) => b.id === state.activeBranchId) || state.branches[0];
        if (active) {
          const prependContext = composePrependedContext({
            branch: active,
            branches: state.branches,
            activeBranchId: active.id,
            recentTurns: cfg.recentTurns,
            retrievalTurns: cfg.retrievalTurns,
            maxPrependedChars: cfg.maxPrependedChars,
            prompt,
            branchTurns: cfg.branchTurns,
          });
          return prependContext ? { prependContext } : undefined;
        }
      }

      if (cmd?.type === 'visualize') {
        const mermaid = renderMermaidTree(state, { includeAssistantTurns: true });
        const active = state.branches.find((b) => b.id === state.activeBranchId) || state.branches[0] || null;
        const prefix = active
          ? composePrependedContext({
              branch: active,
              branches: state.branches,
              activeBranchId: state.activeBranchId,
              recentTurns: cfg.recentTurns,
              retrievalTurns: cfg.retrievalTurns,
              maxPrependedChars: Math.min(cfg.maxPrependedChars, 4000),
            })
          : '';
        const vizInstruction = [
          'User requested session tree visualization.',
          'Reply with valid Mermaid only in a fenced block.',
          'Each node label must include: depth, user turns (u), assistant turns (a).',
          'Do not add extra prose.',
          '',
          '```mermaid',
          mermaid,
          '```',
        ].join('\n');
        return { prependContext: `${prefix}\n\n${vizInstruction}`.trim() };
      }

      // No command matched — before_agent_start only handles commands, reorg, and state init.
      // Auto routing + context composition is done in before_prompt_build (fires before every model request).
    });

    // ── before_prompt_build: routing + context injection (fires before EVERY model request) ──
    api.on('before_prompt_build', async (event, ctx) => {
      if (!cfg.enabled) return;
      if (isInternalRoutingEvent(event)) {
        log.info?.('[treesession] skipping internal routing call (before_prompt_build)');
        return;
      }
      const prompt = stripTreesessionEnvelope(event?.prompt || '');
      if (!prompt || prompt.length < 2) return;

      const runtimeModel = getRuntimeModelId(event, ctx);
      const routingSessionKey = resolveSessionRoutingKey(ctx, event);
      const { file, state } = await loadState(cfg.storageDir, routingSessionKey, ctx?.agentId);
      if (typeof state.autoRoutingEnabled !== 'boolean') state.autoRoutingEnabled = true;
      if (!Number.isFinite(state.routeTurnCounter)) state.routeTurnCounter = 0;
      if (!Array.isArray(state.routeDecisions)) state.routeDecisions = [];
      hydrateBranchStats(state);

      // Auto routing
      const activeBranch = state.branches.find((b) => b.id === state.activeBranchId) || null;
      const previousUserTurn =
        activeBranch?.turns
          ?.slice()
          .reverse()
          .find((t) => t?.role === 'user')?.content || '';
      const routingHistoryTurns = buildRoutingHistoryTurns(activeBranch, event, prompt, Math.max(cfg.recentTurns * 2, 12));

      const forcedTopic = parseForcedTopic(prompt, cfg.forceTopicPrefix);
      let route = null;

      if (!state.autoRoutingEnabled && !forcedTopic) {
        const keepId = state.activeBranchId || state.branches[0]?.id || '';
        route = keepId
          ? { action: 'auto_disabled_keep', branchId: keepId, score: 0.5, confidence: 0.5 }
          : { action: 'auto_disabled_new', branchId: '', newTitle: 'new-topic', score: 0.5, confidence: 0.5 };
      }

      // Pure model routing via tool_use (dry-prompt the LLM with route_branch tool)
      if (!route && cfg.routingStrategy === 'model') {
        log.info?.(`[treesession] before_prompt_build routing: strategy=model invokeModel=${invokeModel ? 'active' : 'null'} branches=${state.branches.length}`);
        route = await routeWithModel({
          prompt,
          previousUserTurn,
          historyTurns: routingHistoryTurns,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          cfg,
          runtimeModel,
          invokeModel,
          log,
        });

        if (route) {
          log.info?.(`[treesession] model router decided: ${route.action} conf=${route.confidence || route.score || '?'}`);
        } else {
          log.warn?.('[treesession] model router returned null — falling back to score router');
          // Fall back to score router instead of blindly keeping active branch.
          route = routePromptToBranch({
            prompt,
            branches: state.branches,
            activeBranchId: state.activeBranchId,
            createThreshold: cfg.branchCreateThreshold,
            forcedTopic,
            shortTurnMinChars: cfg.shortTurnMinChars,
          });
        }
      }

      // Hybrid routing
      if (!route && cfg.routingStrategy === 'hybrid') {
        const scoreRoute = routePromptToBranch({
          prompt,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          createThreshold: cfg.branchCreateThreshold,
          forcedTopic,
          shortTurnMinChars: cfg.shortTurnMinChars,
          returnDiagnostics: true,
        });

        const cand = scoreRoute?.diagnostics?.candidates || [];
        const top = cand[0]?.score ?? scoreRoute?.score ?? 0;
        const second = cand[1]?.score ?? 0;
        const ambiguous = cand.length > 1 && Math.abs(top - second) < cfg.hybridAmbiguityMargin;
        const lowConfidence = top < cfg.hybridModelFallbackThreshold;

        if (forcedTopic || (!ambiguous && !lowConfidence)) {
          route = scoreRoute;
        } else {
          const modelRoute = await routeWithModel({
            prompt,
            previousUserTurn,
            historyTurns: routingHistoryTurns,
            branches: state.branches,
            activeBranchId: state.activeBranchId,
            cfg,
            runtimeModel,
            invokeModel,
            log,
          });
          route = modelRoute || scoreRoute;
        }
      }

      // Default / score-only routing
      if (!route) {
        route = routePromptToBranch({
          prompt,
          branches: state.branches,
          activeBranchId: state.activeBranchId,
          createThreshold: cfg.branchCreateThreshold,
          forcedTopic,
          shortTurnMinChars: cfg.shortTurnMinChars,
        });
      }

      let branch = state.branches.find((b) => b.id === route.branchId);
      let createdNew = false;
      if (!branch) {
        const parent = route.parentId
          ? state.branches.find((b) => b.id === route.parentId)
          : state.branches.find((b) => b.id === state.activeBranchId);

        const fallbackTitle = route.newTitle || 'new-topic';
        const modelTitle = await generateBranchTitle({
          prompt,
          cfg,
          fallbackTitle,
          runtimeModel,
          invokeModel,
          log,
        });

        branch = createBranch(modelTitle, prompt, {
          parentId: parent?.id || null,
          parentPath: parent?.path || '',
        });
        boundedPushBranch(state, branch, cfg.maxBranches);
        recomputeAllPaths(state);
        createdNew = true;
      }

      branch.lastActiveAt = new Date().toISOString();
      state.activeBranchId = branch.id;
      runtimeRoute.set(routingSessionKey, branch.id);

      let sibling = null;
      if (cfg.includeSiblingFallback) {
        sibling = state.branches
          .filter((b) => b.id !== branch.id && b.summary)
          .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))[0] || null;
      }

      hydrateBranchStats(state);

      state.routeTurnCounter += 1;
      const routeDecision = normalizeRouteDecision({
        turn: state.routeTurnCounter,
        route,
        branch,
        createdNew,
      });
      state.lastRouteDecision = routeDecision;
      state.routeDecisions.push(routeDecision);
      if (state.routeDecisions.length > 500) state.routeDecisions = state.routeDecisions.slice(-500);

      await saveState(file, state);

      const prependContext = composePrependedContext({
        branch,
        siblingBranch: sibling,
        branches: state.branches,
        activeBranchId: state.activeBranchId,
        recentTurns: cfg.recentTurns,
        retrievalTurns: cfg.retrievalTurns,
        maxPrependedChars: cfg.maxPrependedChars,
        prompt,
        branchTurns: cfg.branchTurns,
      });

      log.info?.(`[treesession] before_prompt_build routed -> ${branch.title} (${route.action}, score=${(route.score || 0).toFixed(3)})`);

      if (!prependContext) return undefined;

      // Split static guidance (cacheable by provider) from dynamic branch turns.
      // prependSystemContext is prepended to the system prompt and can be cached
      // across turns, saving per-turn token cost for static instructions.
      const prependSystemContext = [
        'You are in a treesession-managed conversation with topic branching.',
        'Answer using only the active branch context unless user explicitly asks to mix branches.',
        'Do not reference treesession internals unless the user asks about them.',
      ].join(' ');

      return { prependContext, prependSystemContext };
    });

    api.on('agent_end', async (event, ctx) => {
      if (!cfg.enabled) return;
      if (!event?.success || !event?.messages?.length) return;
      if (isInternalRoutingEvent(event)) {
        log.info?.('[treesession] skipping internal routing call (agent_end)');
        return;
      }

      const routingSessionKey = resolveSessionRoutingKey(ctx, event);
      const { file, state } = await loadState(cfg.storageDir, routingSessionKey, ctx?.agentId);
      hydrateBranchStats(state);
      const branchId = runtimeRoute.get(routingSessionKey) || state.activeBranchId;
      const branch = state.branches.find((b) => b.id === branchId);
      if (!branch) return;

      const { user, assistant } = pickLastTurn(event);
      if (user) {
        branch.turns.push({ role: 'user', content: user, ts: new Date().toISOString() });
        branch.userTurnCount = (branch.userTurnCount || 0) + 1;
      }
      if (assistant) {
        branch.turns.push({ role: 'assistant', content: assistant, ts: new Date().toISOString() });
        branch.assistantTurnCount = (branch.assistantTurnCount || 0) + 1;
      }

      branch.turnCount = (branch.userTurnCount || 0) + (branch.assistantTurnCount || 0);
      branch.lastActiveAt = new Date().toISOString();
      // Accumulate keywords from recent branch turns, not just the last one.
      const recentTurnText = (branch.turns || [])
        .slice(-10)
        .map((t) => cleanContentForStorage(t.content))
        .join(' ');
      branch.keywords = topKeywords(`${branch.title} ${recentTurnText} ${user} ${assistant}`, 12);

      if (branch.turns.length > 200) branch.turns = branch.turns.slice(-200);

      maybeRefreshSummary(branch, cfg.summaryEveryTurns);
      refreshBranchRouteSummary(branch);
      hydrateBranchStats(state);
      await saveState(file, state);
    });
  },
};
