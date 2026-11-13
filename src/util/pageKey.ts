export type PageKeyQuery = 'all' | 'none' | string[];

/**
 * Rewrite rules `[regex, replacement]` (applied globally, in order) to page
 * keys and network endpoint URLs. They make keys stable when URLs carry
 * run-specific data, e.g. `[["Q9[0-9a-f]{8}", "Q9#"]]` for test-generated ids.
 */
export type KeyNormalizer = Array<[string, string]>;

export function normalizeKey(key: string, rules?: KeyNormalizer): string {
  if (!rules) return key;
  for (const [p, r] of rules) key = key.replace(new RegExp(p, 'g'), r);
  return key;
}

/** origin + pathname of a URL, normalised (used to identify network endpoints). */
export function urlBaseOf(href: string, rules?: KeyNormalizer): string {
  try {
    const u = new URL(href);
    return normalizeKey(u.origin + u.pathname, rules);
  } catch {
    return href;
  }
}

/**
 * Page identity used to scope PWEs and DOM mutants: origin + pathname + the
 * (sorted) query parameters selected by `mode`. Must stay identical to the
 * copies inlined in src/browser/*.ts.
 */
export function pageKeyOf(href: string, mode: PageKeyQuery = 'all', rules?: KeyNormalizer): string {
  const u = new URL(href);
  let entries = Array.from(u.searchParams.entries());
  if (mode === 'none') entries = [];
  else if (Array.isArray(mode)) entries = entries.filter(([k]) => mode.includes(k));
  entries.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  const q = entries.length ? '?' + entries.map(([k, v]) => k + '=' + v).join('&') : '';
  return normalizeKey(u.origin + u.pathname + q, rules);
}
