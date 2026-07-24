export interface SearchPlan {
  raw: string;
  normalized: string;
  text: string;
  tokens: string[];
  phrase: string;
  strictQuery: string;
  broadQuery: string;
  author?: string;
  category?: string;
  domain?: string;
}

const DIRECTIVE_RE = /(?:^|\s)(@[\p{L}\p{N}_]{1,50}|(?:author|from|category|domain):(?:"[^"]+"|'[^']+'|[^\s]+))/giu;
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function cleanDirectiveValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').replace(/^@/, '');
}

function ftsToken(token: string, prefix = false): string {
  const escaped = token.replace(/"/g, '""');
  return `"${escaped}"${prefix && token.length >= 3 ? '*' : ''}`;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchPlan(value: string): SearchPlan {
  const raw = value ?? '';
  const normalized = normalizeSearchText(raw).slice(0, 500);
  let author: string | undefined;
  let category: string | undefined;
  let domain: string | undefined;

  const text = normalized.replace(DIRECTIVE_RE, (match, directive: string) => {
    const trimmed = directive.trim();
    if (trimmed.startsWith('@')) {
      author = cleanDirectiveValue(trimmed);
      return ' ';
    }
    const splitAt = trimmed.indexOf(':');
    const key = trimmed.slice(0, splitAt).toLowerCase();
    const directiveValue = cleanDirectiveValue(trimmed.slice(splitAt + 1));
    if (key === 'author' || key === 'from') author = directiveValue;
    if (key === 'category') category = directiveValue.toLowerCase();
    if (key === 'domain') domain = directiveValue.toLowerCase();
    return ' ';
  }).replace(/\s+/g, ' ').trim();

  const tokens = Array.from(text.toLowerCase().matchAll(TOKEN_RE))
    .map((match) => match[0])
    .filter((token) => token.length > 1 || /^\d+$/.test(token))
    .slice(0, 16);
  const uniqueTokens = [...new Set(tokens)];
  const strictQuery = uniqueTokens.map((token) => ftsToken(token, true)).join(' AND ');
  const broadQuery = uniqueTokens.map((token) => ftsToken(token, true)).join(' OR ');

  return {
    raw,
    normalized,
    text,
    tokens: uniqueTokens,
    phrase: text.toLowerCase(),
    strictQuery,
    broadQuery,
    author,
    category,
    domain,
  };
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}
