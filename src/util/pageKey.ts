export type PageKeyQuery = 'all' | 'none' | string[];

/**
 * Page identity used to scope PWEs and DOM mutants: origin + pathname + the
 * (sorted) query parameters selected by `mode`. Must stay identical to the
 * copies inlined in src/browser/*.ts.
 */
export function pageKeyOf(href: string, mode: PageKeyQuery = 'all'): string {
  const u = new URL(href);
  let entries = Array.from(u.searchParams.entries());
  if (mode === 'none') entries = [];
  else if (Array.isArray(mode)) entries = entries.filter(([k]) => mode.includes(k));
  entries.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  const q = entries.length ? '?' + entries.map(([k, v]) => k + '=' + v).join('&') : '';
  return u.origin + u.pathname + q;
}
