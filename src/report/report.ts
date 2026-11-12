import type { Counts, Layer, RunReport } from '../types';
import { countResults, perLayer, countBy } from '../engine/classifier';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/* --------------------------------------------------------------- text */

export function textSummary(r: RunReport): string {
  const t = r.totals;
  const lines = [
    `MultilayerMT report: ${r.app} (PWE-${r.config.maxPwe}, ${r.config.workers} workers)`,
    `  Total Mutants Generated: ${t.generated}`,
    `   Killed:   ${t.killed} (${pct(t.generated ? t.killed / t.generated : 0)})`,
    `   Survived: ${t.survived} (${pct(t.generated ? t.survived / t.generated : 0)})`,
    `   Skipped:  ${t.skipped} (${pct(t.generated ? t.skipped / t.generated : 0)})`,
    `   Errors:   ${t.error + t.timeout} (${pct(t.generated ? (t.error + t.timeout) / t.generated : 0)})`,
    ``,
    `  Mutation Score: ${pct(t.mutationScore)}   Applicability: ${pct(t.applicability)}`,
    `  Execution Time: ${(r.wallTimeMs / 1000).toFixed(1)} s  (per executed mutant: ${t.executed ? (r.wallTimeMs / 1000 / t.executed).toFixed(2) : '–'} s)`,
    ``,
    `  Layer      Ops  Gen.  Exec.  Skip.  Killed  Survived  MS`,
  ];
  for (const l of ['dom', 'network', 'test'] as Layer[]) {
    const c = r.perLayer[l];
    const ops = Object.keys(r.perOperator).filter((o) => r.results.find((x) => x.mutant.operator === o)?.mutant.layer === l).length;
    lines.push(`  ${l.padEnd(9)} ${String(ops).padStart(4)} ${String(c.generated).padStart(5)} ${String(c.executed).padStart(6)} ${String(c.skipped).padStart(6)} ${String(c.killed).padStart(7)} ${String(c.survived).padStart(9)}  ${pct(c.mutationScore)}`);
  }
  return lines.join('\n');
}

/* --------------------------------------------------------------- html */

function countsRow(label: string, c: Counts, extra = ''): string {
  return `<tr><td>${esc(label)}</td>${extra}<td>${c.generated}</td><td>${c.executed}</td><td>${c.skipped}</td><td>${c.killed}</td><td>${c.survived}</td><td>${c.error + c.timeout}</td><td><b>${pct(c.mutationScore)}</b></td><td>${pct(c.applicability)}</td></tr>`;
}
const COUNT_HEAD = '<th>Gen.</th><th>Exec.</th><th>Skip.</th><th>Killed</th><th>Survived</th><th>Err.</th><th>MS</th><th>Applic.</th>';

export function htmlReport(r: RunReport): string {
  const t = r.totals;
  const layers = (['dom', 'network', 'test'] as Layer[]).map((l) => countsRow(l.toUpperCase(), r.perLayer[l])).join('');
  const ops = Object.entries(r.perOperator)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([op, c]) => countsRow(op, c))
    .join('');
  const survivors = r.results
    .filter((x) => x.status === 'SURVIVED')
    .map((x) => `<tr><td>${esc(x.mutant.id)}</td><td>${esc(x.mutant.operator)}</td><td>${esc(x.gapCategory)}</td><td class="mono">${esc(x.mutant.target.description)}</td><td class="mono small">${esc(x.reason)}</td></tr>`)
    .join('');
  const all = r.results
    .map((x) => `<tr class="st-${x.status}"><td>${esc(x.mutant.id)}</td><td>${esc(x.mutant.layer)}</td><td>${esc(x.mutant.operator)}</td><td><span class="badge">${x.status}</span></td><td>${(x.durationMs / 1000).toFixed(1)}s</td><td class="mono">${esc(x.mutant.target.description)}</td><td class="mono small">${esc(x.reason)}</td></tr>`)
    .join('');
  const pwe = r.pwe
    .map(
      (p) => `<details><summary><span class="mono">${esc(p.pageKey)}</span> &mdash; ${p.selected.length}/${p.candidates} elements</summary>
<table><thead><tr><th>#</th><th>Selector</th><th>Tag</th><th>I</th><th>V</th><th>S</th><th>Score</th><th>click/fill/focus/hover</th></tr></thead><tbody>
${p.selected
  .map((e) => `<tr><td>${e.rank}</td><td class="mono">${esc(e.selector)}</td><td>${esc(e.element.tag)}</td><td>${e.norm.interaction.toFixed(2)}</td><td>${e.norm.visibility.toFixed(2)}</td><td>${e.norm.semantic.toFixed(2)}</td><td><b>${e.score.toFixed(3)}</b></td><td>${e.interactions.click}/${e.interactions.fill}/${e.interactions.focus}/${e.interactions.hover}</td></tr>`)
  .join('')}
</tbody></table></details>`,
    )
    .join('');
  const gapsTotal = Object.values(r.gapCategories).reduce((a, b) => a + b, 0);
  const gaps = Object.entries(r.gapCategories)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td><td>${pct(gapsTotal ? v / gapsTotal : null)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MultilayerMT Report</title>
<style>
:root{--bg:#fff;--fg:#1c1f23;--muted:#5f6b76;--line:#e3e6ea;--card:#f6f8fa;--kill:#1f7a3a;--surv:#b42318;--skip:#6b7280;--err:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--muted:#9aa4ae;--line:#2a2f36;--card:#171a20;--kill:#4ade80;--surv:#f87171;--skip:#9ca3af;--err:#fbbf24}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px 16px;max-width:1280px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.card .v{font-size:22px;font-weight:600}.card .k{color:var(--muted);font-size:12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}.small{font-size:11px;color:var(--muted)}
.badge{font-size:11px;font-weight:600}.st-KILLED .badge{color:var(--kill)}.st-SURVIVED .badge{color:var(--surv)}.st-SKIPPED .badge{color:var(--skip)}.st-ERROR .badge,.st-TIMEOUT .badge{color:var(--err)}
details{margin:6px 0}summary{cursor:pointer}
</style></head><body>
<h1>MultilayerMT &mdash; ${esc(r.app)}</h1>
<div class="muted">PWE-${r.config.maxPwe} &middot; layers: ${r.config.layers.join(', ')} &middot; ${r.config.workers} workers &middot; test selection: ${esc(r.config.testSelection)} &middot; ${esc(r.startedAt)}</div>
<div class="cards">
<div class="card"><div class="k">Mutation score</div><div class="v">${pct(t.mutationScore)}</div></div>
<div class="card"><div class="k">Generated</div><div class="v">${t.generated}</div></div>
<div class="card"><div class="k">Executed (applicable)</div><div class="v">${t.executed}</div></div>
<div class="card"><div class="k">Killed</div><div class="v">${t.killed}</div></div>
<div class="card"><div class="k">Survived</div><div class="v">${t.survived}</div></div>
<div class="card"><div class="k">Skipped</div><div class="v">${t.skipped}</div></div>
<div class="card"><div class="k">Applicability</div><div class="v">${pct(t.applicability)}</div></div>
<div class="card"><div class="k">Wall time</div><div class="v">${(r.wallTimeMs / 1000).toFixed(1)}s</div></div>
</div>
<h2>Per layer</h2><div class="wrap"><table><thead><tr><th>Layer</th>${COUNT_HEAD}</tr></thead><tbody>${layers}${countsRow('Total', t)}</tbody></table></div>
<h2>Test gap categories (survived mutants)</h2><div class="wrap"><table><thead><tr><th>Category</th><th>Survived</th><th>Share</th></tr></thead><tbody>${gaps}</tbody></table></div>
<h2>Survived mutants (test gaps)</h2><div class="wrap"><table><thead><tr><th>ID</th><th>Operator</th><th>Gap</th><th>Target</th><th>Details</th></tr></thead><tbody>${survivors || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table></div>
<h2>Per operator</h2><div class="wrap"><table><thead><tr><th>Operator</th>${COUNT_HEAD}</tr></thead><tbody>${ops}</tbody></table></div>
<h2>Prioritized Web Elements</h2>${pwe || '<p class="muted">no pages</p>'}
<h2>All mutants</h2><div class="wrap"><table><thead><tr><th>ID</th><th>Layer</th><th>Operator</th><th>Status</th><th>Time</th><th>Target</th><th>Details</th></tr></thead><tbody>${all}</tbody></table></div>
</body></html>`;
}

/* ---------------------------------------------------------- aggregate */

/**
 * Aggregate several run reports (e.g. 7 apps x PWE-4/8/16 = 21 runs) into the
 * tables of thesis Ch. 5 (Tables 5.4, 5.5, 5.7, 5.8).
 */
export function aggregate(reports: RunReport[]): string {
  const results = reports.flatMap((r) => r.results);
  const totals = countResults(results);
  const layers = perLayer(results);
  const byApp = new Map<string, RunReport[]>();
  for (const r of reports) byApp.set(r.app, [...(byApp.get(r.app) || []), r]);
  const wall = reports.reduce((n, r) => n + r.wallTimeMs, 0);
  const seq = reports.reduce((n, r) => n + r.sumMutantTimeMs, 0);
  const workers = Math.max(1, ...reports.map((r) => r.config.workers));
  const speedup = wall ? seq / wall : 0;
  const lines: string[] = [];
  lines.push(`# MultilayerMT aggregate (${reports.length} run(s), ${byApp.size} app(s))`, '');
  lines.push('## Overall (cf. Table 5.4)', '', '| Metric | Value | Percentage | Mean per App |', '|---|---|---|---|');
  const perApp = (x: number) => (byApp.size ? Math.round(x / byApp.size) : 0);
  lines.push(`| Generated Mutants | ${totals.generated} | 100% | ${perApp(totals.generated)} |`);
  lines.push(`| Executed Mutants | ${totals.executed} | ${pct(totals.applicability)} | ${perApp(totals.executed)} |`);
  lines.push(`| Skipped Mutants | ${totals.skipped} | ${pct(totals.generated ? totals.skipped / totals.generated : null)} | ${perApp(totals.skipped)} |`);
  lines.push(`| Killed (of executed) | ${totals.killed} | ${pct(totals.mutationScore)} | ${perApp(totals.killed)} |`);
  lines.push(`| Survived (of executed) | ${totals.survived} | ${pct(totals.executed ? totals.survived / totals.executed : null)} | ${perApp(totals.survived)} |`);
  lines.push(`| Mutation Score | — | ${pct(totals.mutationScore)} | |`);
  lines.push(`| Total Time (min) | ${(wall / 60000).toFixed(1)} | — | ${(wall / 60000 / Math.max(1, byApp.size)).toFixed(1)} |`);
  lines.push(`| Per-Mutant Time (s) | ${totals.executed ? (wall / 1000 / totals.executed).toFixed(2) : '–'} | — | |`, '');

  lines.push('## Per application (cf. Table 5.5)', '', '| Application | Executed | Killed | Survived | MS (%) | Time (min) |', '|---|---|---|---|---|---|');
  for (const [app, rs] of [...byApp.entries()].sort()) {
    const c = countResults(rs.flatMap((r) => r.results));
    lines.push(`| ${app} | ${c.executed} | ${c.killed} | ${c.survived} | ${pct(c.mutationScore)} | ${(rs.reduce((n, r) => n + r.wallTimeMs, 0) / 60000).toFixed(1)} |`);
  }
  lines.push('', '## Per layer (cf. Table 5.7)', '', '| Layer | Ops | Gen. | Exec. | Skip. | Killed | Survived | MS (%) |', '|---|---|---|---|---|---|---|---|');
  const opsPerLayer = (l: Layer) => new Set(results.filter((x) => x.mutant.layer === l).map((x) => x.mutant.operator)).size;
  for (const l of ['dom', 'network', 'test'] as Layer[]) {
    const c = layers[l];
    lines.push(`| ${l} | ${opsPerLayer(l)} | ${c.generated} | ${c.executed} | ${c.skipped} | ${c.killed} | ${c.survived} | ${pct(c.mutationScore)} |`);
  }
  lines.push(`| Total | ${new Set(results.map((x) => x.mutant.operator)).size} | ${totals.generated} | ${totals.executed} | ${totals.skipped} | ${totals.killed} | ${totals.survived} | ${pct(totals.mutationScore)} |`);

  const gaps = countBy(results.filter((x) => x.status === 'SURVIVED'), (x) => x.gapCategory || 'Weak Assertions');
  lines.push('', '## Test gap categories (cf. Table 5.6)', '', '| Category | Survived | Share |', '|---|---|---|');
  for (const [k, c] of Object.entries(gaps)) lines.push(`| ${k} | ${c.generated} | ${pct(totals.survived ? c.generated / totals.survived : null)} |`);

  lines.push('', '## Performance (cf. Table 5.8)', '', '| Metric | Value |', '|---|---|');
  lines.push(`| Sequential estimate (sum of mutant runs) | ${(seq / 60000).toFixed(1)} min |`);
  lines.push(`| Parallel execution (${workers} workers) | ${(wall / 60000).toFixed(1)} min |`);
  lines.push(`| Speedup factor | ${speedup.toFixed(2)}x |`);
  lines.push(`| Parallel efficiency | ${pct(speedup / workers)} |`);
  return lines.join('\n') + '\n';
}
