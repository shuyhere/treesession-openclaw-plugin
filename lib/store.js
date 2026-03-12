import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { expandHome, nowIso } from './util.js';

function safeKey(str = 'unknown') {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export function sessionFile(storageDir, sessionKey, agentId) {
  const base = expandHome(storageDir || '~/.openclaw/treesession-store');
  const key = `${safeKey(sessionKey || 'session')}${agentId ? `__${safeKey(agentId)}` : ''}`;
  return path.join(base, `${key}.json`);
}

export async function loadState(storageDir, sessionKey, agentId) {
  const file = sessionFile(storageDir, sessionKey, agentId);
  try {
    const txt = await fs.readFile(file, 'utf8');
    return { file, state: JSON.parse(txt) };
  } catch {
    const init = {
      schema: 'treesession.v1',
      sessionKey,
      agentId: agentId || '',
      activeBranchId: '',
      updatedAt: nowIso(),
      branches: [],
    };
    return { file, state: init };
  }
}

export async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  state.updatedAt = nowIso();
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

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

export function createBranch(title, seedText = '', opts = {}) {
  const id = crypto.randomUUID();
  const cleanTitle = title || `topic-${id.slice(0, 6)}`;
  const node = slugify(cleanTitle);
  const parentPath = opts.parentPath || '';
  const branchPath = parentPath ? `${parentPath}/${node}` : node;

  return {
    id,
    parentId: opts.parentId || null,
    path: branchPath,
    title: cleanTitle,
    summary: '',
    keywords: [],
    turns: [],
    createdAt: nowIso(),
    lastActiveAt: nowIso(),
    turnCount: 0,
    userTurnCount: 0,
    assistantTurnCount: 0,
    depth: 0,
    seedText,
  };
}
