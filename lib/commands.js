function firstLine(text = '') {
  return (text || '').split('\n')[0].trim();
}

function normalizeLeadingCommandToken(lineRaw = '') {
  let out = (lineRaw || '').trim();
  // Optional bot mention prefix: "@coder /cmd" or "<@id> /cmd"
  out = out.replace(/^<@!?\d+>\s+/, '');
  out = out.replace(/^@[\w.-]+\s+/, '');
  // Optional slash command form
  out = out.replace(/^\//, '');
  return out;
}

export function parseBranchCommand(prompt = '') {
  const lineRaw = normalizeLeadingCommandToken(firstLine(prompt));
  const line = lineRaw.toLowerCase();

  // startnewtreesession: <optional title>
  if (line.startsWith('startnewtreesession:') || line.startsWith('startnewtreesession ')) {
    const raw = lineRaw.replace(/^startnewtreesession\s*:?/i, '').trim();
    return { type: 'start_tree', title: raw || 'new-tree-session' };
  }
  if (line === 'startnewtreesession') {
    return { type: 'start_tree', title: 'new-tree-session' };
  }

  // tokensavewithtreesession
  if (line.startsWith('tokensavewithtreesession')) {
    return { type: 'token_save_report' };
  }

  // newsessionbranch: <title>
  if (line.startsWith('newsessionbranch:') || line.startsWith('newsessionbranch ')) {
    const raw = lineRaw.replace(/^newsessionbranch\s*:?/i, '').trim();
    return { type: 'new', title: raw || 'new-branch' };
  }

  // resumesessionbranch: <title|id|path>
  if (
    line.startsWith('resumesessionbranch:') ||
    line.startsWith('resumesessionbranch ') ||
    line.startsWith('resume session branch:') ||
    line.startsWith('resume session branch ')
  ) {
    const raw = lineRaw
      .replace(/^resumesessionbranch\s*:?/i, '')
      .replace(/^resume\s+session\s+branch\s*:?/i, '')
      .trim();
    return { type: 'resume', query: raw };
  }

  // mergesessionbranch: <source> -> <target>
  if (line.startsWith('mergesessionbranch:') || line.startsWith('mergesessionbranch ')) {
    const raw = lineRaw.replace(/^mergesessionbranch\s*:?/i, '').trim();
    const [source, target] = raw.split('->').map((x) => (x || '').trim());
    if (source && target) return { type: 'merge', source, target };
    return { type: 'merge_invalid' };
  }

  // auto routing mode control
  // autosessionbranch: on|off|status|now
  if (line.startsWith('autosessionbranch:') || line.startsWith('autosessionbranch ')) {
    const raw = lineRaw.replace(/^autosessionbranch\s*:?/i, '').trim().toLowerCase();
    const action = raw || 'status';
    if (['on', 'off', 'status', 'now'].includes(action)) return { type: 'auto_mode', action };
    return { type: 'auto_mode', action: 'status' };
  }

  // summarize branch memory for routing/search
  // summarizebranch: <optional target>
  if (line.startsWith('summarizebranch:') || line.startsWith('summarizebranch ')) {
    const raw = lineRaw.replace(/^summarizebranch\s*:?/i, '').trim();
    return { type: 'summarize', query: raw };
  }

  // reorganize triggers
  if (
    line === 'reorganizesessionbranch' ||
    line.startsWith('reorganizesessionbranch ') ||
    line === 'reorganizesessiontree' ||
    line.startsWith('reorganizesessiontree ') ||
    line === 'reorganizebranches' ||
    line.startsWith('reorganizebranches ') ||
    line === 'automergebranches' ||
    line.startsWith('automergebranches ')
  ) {
    return { type: 'reorg' };
  }

  // visualize tree as Mermaid with depth + turn counts
  if (
    line === 'visualizesessiontree' ||
    line.startsWith('visualizesessiontree ') ||
    line === 'visualizebranches' ||
    line.startsWith('visualizebranches ') ||
    line === 'mermaidsessiontree' ||
    line.startsWith('mermaidsessiontree ')
  ) {
    return { type: 'visualize' };
  }

  return null;
}
