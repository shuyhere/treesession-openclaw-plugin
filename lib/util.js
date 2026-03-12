import os from 'os';

export function nowIso() {
  return new Date().toISOString();
}

export function expandHome(path) {
  if (!path) return path;
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return `${os.homedir()}${path.slice(1)}`;
  return path;
}

const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one','our','out',
  'has','have','been','from','they','will','with','this','that','then','than','them','each',
  'make','like','long','look','many','most','over','such','take','into','just','your','some',
  'very','when','what','which','while','about','after','again','being','below','could','does',
  'doing','during','every','first','going','great','here','other','should','their','there',
  'these','thing','those','through','under','until','using','want','were','where','would','also',
  'more','only','still','well','much','same','both','before','between','come','even','give',
  'how','its','may','new','now','old','see','way','who','did','get','let','say','she','too','use',
]);

export function tokenize(text = '') {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 200);
}

export function topKeywords(text = '', limit = 8) {
  const freq = new Map();
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export function jaccard(a = [], b = []) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter || 1);
}

export function clampText(text, maxChars) {
  if (!text) return '';
  if (!maxChars || maxChars <= 0) return text;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}
