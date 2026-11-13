#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { ConfigError, findConfigFile, loadConfigAsync, UserConfig } from './config';
import { AbortError, MutationEngine, VERSION } from './engine/engine';
import { listTestMutationSites, mutateTestSource } from './api';
import { registry } from './operators/registry';
import { aggregate, htmlReport, textSummary } from './report/report';
import type { Layer, RunReport, SuiteTrace } from './types';
import { readJson } from './util/fs';
import { consoleLogger, Logger, silentLogger } from './util/log';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, THRESHOLD: 3, ABORTED: 130 } as const;

const HELP = `MultilayerMT ${VERSION} - multi-layer runtime mutation testing for Playwright E2E suites

Usage: mlmt <command> [options]

Pipeline commands (use the config, see "mlmt init"):
  run                       trace -> PWE -> generate -> execute -> report
  trace                     baseline + trace run (writes <outputDir>/trace.json)
  pwe                       print the PWE ranking computed from the trace
  generate                  write mutant descriptors without executing them

Standalone commands:
  init                      create mlmt.config.json in the current directory
  operators                 list the mutation operators (--set thesis|literature|plugin, --layer)
  sites <test-file>         list test-script mutation sites of a test file
  mutate <test-file>        print a mutated test file (--operator, --site)
  report <report.json>      re-render the HTML report of a run
  aggregate <a.json> ...    aggregate run reports into Markdown tables (thesis Ch. 5)

Config:
  -c, --config <file>       config file (default: mlmt.config.{js,cjs,mjs,json} in cwd)
  --project-root <dir>      --playwright-config <file>   --test-dir <dir>
  --output-dir <dir>        --app <name>                 --plugin <module> (repeatable)

Run options:
  --max-pwe <n>             top-N PWEs per page (e.g. 4, 8, 16)
  --workers <n>             parallel mutant executions
  --layers <list>           subset of dom,network,test
  --operator-set <set>      thesis (the 51 thesis operators), literature, or all (default)
  --operators <list>        operator ids / family prefixes to include
  --exclude <list>          operator ids / family prefixes to exclude
  --max-mutants <n>         execute a seeded random sample of n mutants
  --reuse-trace             reuse <outputDir>/trace.json
  --all-tests               run the whole suite for every mutant
  --keep-sandboxes          keep sandbox directories for inspection
  --reporter <name|module>  json, html, markdown, console (repeatable)
  --threshold <0-100>       exit with code 3 if the mutation score is lower

Output:
  --json                    machine-readable JSON on stdout (logs go to stderr)
  -q, --quiet               no progress output
  -v, --verbose             debug output
  -o, --out <file>          output file (mutate, report, aggregate)

Exit codes: 0 ok, 1 error, 2 usage/config error, 3 below threshold, 130 interrupted
`;

const FLAGS = new Set(['reuse-trace', 'all-tests', 'keep-sandboxes', 'json', 'q', 'quiet', 'v', 'verbose', 'h', 'help', 'version', 'force']);
const REPEATABLE = new Set(['plugin', 'reporter']);

export function parseArgs(argv: string[]): { pos: string[]; opts: Record<string, any> } {
  const pos: string[] = [];
  const opts: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    const [k, inline] = a.replace(/^-+/, '').split(/=(.*)/s, 2);
    let v: string | boolean;
    if (inline !== undefined) v = inline;
    else if (FLAGS.has(k)) v = true;
    else {
      v = argv[++i];
      if (v === undefined) throw new UsageError(`option --${k} needs a value`);
    }
    if (REPEATABLE.has(k)) (opts[k] ||= []).push(v);
    else opts[k] = v;
  }
  return { pos, opts };
}

class UsageError extends Error {}

const list = (v: unknown) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
function int(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

export function overridesFrom(o: Record<string, any>): UserConfig {
  const c: UserConfig = {
    app: o.app,
    projectRoot: o['project-root'],
    playwrightConfig: o['playwright-config'],
    testDir: o['test-dir'],
    outputDir: o['output-dir'],
    maxPwe: int(o['max-pwe'], 'max-pwe'),
    workers: int(o.workers, 'workers'),
    maxMutants: int(o['max-mutants'], 'max-mutants'),
    layers: list(o.layers) as Layer[] | undefined,
    plugins: o.plugin,
    reporters: o.reporter,
  };
  if (o.operators || o.exclude) c.operators = { include: list(o.operators), exclude: list(o.exclude) };
  if (o['operator-set'] !== undefined) c.operatorSet = o['operator-set'];
  if (o['all-tests']) c.testSelection = 'all';
  if (o['keep-sandboxes']) c.keepSandboxes = true;
  return c;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  if (opts.version || cmd === '--version') {
    console.log(VERSION);
    return EXIT.OK;
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || opts.h || opts.help) {
    console.log(HELP);
    return EXIT.OK;
  }
  const json = !!opts.json;
  const logger: Logger = opts.q || opts.quiet ? silentLogger : consoleLogger({ verbose: !!(opts.v || opts.verbose), stream: json ? 'stderr' : 'stdout' });
  const out = (data: unknown, text: string) => (json ? process.stdout.write(JSON.stringify(data, null, 2) + '\n') : console.log(text));
  const configSource = opts.c ?? opts.config;
  const loadCfg = () => loadConfigAsync(configSource, overridesFrom(opts));
  const loadPlugins = async () => {
    for (const p of opts.plugin || []) await registry.loadPluginFile(path.resolve(p));
    const file = configSource ? path.resolve(configSource) : findConfigFile();
    if (file) {
      const cfg = await loadCfg();
      await registry.loadPlugins(cfg.abs.plugins);
    }
  };

  switch (cmd) {
    case 'init': {
      const file = path.resolve('mlmt.config.json');
      if (fs.existsSync(file) && !opts.force) throw new UsageError(`${file} exists (use --force to overwrite)`);
      const pwConfig = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'].find((f) => fs.existsSync(f)) || 'playwright.config.ts';
      const testDir = ['tests', 'e2e', 'test', 'tests/e2e'].find((d) => fs.existsSync(d)) || 'tests';
      const cfg = {
        $schema: 'https://raw.githubusercontent.com/ast-fortiss-tum/multilayer-mt/main/docs/config.schema.json',
        app: path.basename(process.cwd()),
        playwrightConfig: pwConfig,
        testDir,
        maxPwe: 8,
        workers: 4,
        layers: ['dom', 'network', 'test'],
        reporters: ['json', 'html', 'console'],
      };
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      out({ file, config: cfg }, `created ${file}\nstart the application, then run: npx mlmt run`);
      return EXIT.OK;
    }

    case 'operators': {
      await loadPlugins();
      const layer = opts.layer as Layer | undefined;
      const set = opts.set as string | undefined;
      if (set && !['thesis', 'literature', 'plugin'].includes(set)) throw new UsageError('--set must be thesis, literature or plugin');
      const ops = registry
        .list(layer)
        .filter((o) => !set || (o.set ?? 'plugin') === set)
        .map(({ id, family, layer: l, category, intent, defaults, scope, set: st, refs, aliases }) => ({
          id, family, layer: l, category, intent, defaults, scope, set: st ?? 'plugin', refs: refs ?? [], aliases: aliases ?? [], builtin: registry.isBuiltin(id),
        }));
      const lines: string[] = [];
      for (const l of ['dom', 'network', 'test'] as Layer[]) {
        const ls = ops.filter((o) => o.layer === l);
        if (!ls.length) continue;
        lines.push(`\n${l.toUpperCase()} (${ls.length})`);
        for (const o of ls) lines.push(`  ${o.id.padEnd(30)} ${o.category.padEnd(24)} ${o.intent}${o.set === 'plugin' ? '  [plugin]' : o.set === 'literature' ? '  [lit]' : ''}`);
      }
      lines.push(`\nTotal: ${ops.length}`);
      out(ops, lines.join('\n'));
      return EXIT.OK;
    }

    case 'sites': {
      if (!pos[0]) throw new UsageError('usage: mlmt sites <test-file> [--operators a,b]');
      await loadPlugins();
      const sites = listTestMutationSites(fs.readFileSync(pos[0], 'utf8'), { fileName: pos[0], operators: list(opts.operators) });
      out(sites, sites.map((s) => `${s.operator.padEnd(26)} #${s.site}  line ${String(s.line).padEnd(4)} ${s.description}`).join('\n') || 'no sites');
      return EXIT.OK;
    }

    case 'mutate': {
      if (!pos[0] || !opts.operator) throw new UsageError('usage: mlmt mutate <test-file> --operator <id> [--site n] [-o out]');
      await loadPlugins();
      const src = mutateTestSource(fs.readFileSync(pos[0], 'utf8'), String(opts.operator), { fileName: pos[0], site: int(opts.site, 'site') ?? 0 });
      const file = opts.o ?? opts.out;
      if (file) fs.writeFileSync(file, src);
      if (json) out({ file: file ?? null, source: src }, '');
      else if (!file) process.stdout.write(src);
      return EXIT.OK;
    }

    case 'trace': {
      const engine = new MutationEngine(await loadCfg(), { logger });
      try {
        await engine.init();
        await engine.startServer();
        const trace = await engine.trace();
        out({ file: engine.paths.trace, tests: trace.tests.length, baseline: trace.baseline }, `trace written to ${engine.paths.trace}`);
      } finally {
        engine.cleanup();
        engine.stopServer();
      }
      return EXIT.OK;
    }

    case 'pwe': {
      const engine = new MutationEngine(await loadCfg(), { logger });
      const pages = engine.pwe(readJson<SuiteTrace>(engine.paths.trace));
      const lines: string[] = [];
      for (const p of pages) {
        lines.push(`\n${p.pageKey}  (${p.selected.length}/${p.candidates})`);
        for (const e of p.selected) {
          lines.push(`  ${String(e.rank).padStart(3)}. ${e.score.toFixed(3)}  I=${e.norm.interaction.toFixed(2)} V=${e.norm.visibility.toFixed(2)} S=${e.norm.semantic.toFixed(2)}  <${e.element.tag}> ${e.selector}`);
        }
      }
      out(pages, lines.join('\n'));
      return EXIT.OK;
    }

    case 'generate': {
      const engine = new MutationEngine(await loadCfg(), { logger });
      await engine.init();
      const trace = readJson<SuiteTrace>(engine.paths.trace);
      const mutants = engine.generate(trace, engine.pwe(trace));
      out(mutants, `written ${engine.paths.mutants} (${mutants.length} mutants)`);
      return EXIT.OK;
    }

    case 'run': {
      const cfg = await loadCfg();
      const threshold = opts.threshold !== undefined ? Number(opts.threshold) : undefined;
      if (threshold !== undefined && (isNaN(threshold) || threshold < 0 || threshold > 100)) throw new UsageError('--threshold must be between 0 and 100');
      const engine = new MutationEngine(cfg, { logger });
      const ac = new AbortController();
      const onSig = () => {
        logger.warn('interrupted, stopping running mutants...');
        ac.abort();
      };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
      let files: string[] = [];
      engine.on('report', (_r, f) => (files = f));
      const report = await engine.run({ reuseTrace: !!opts['reuse-trace'], signal: ac.signal });
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      const score = report.totals.mutationScore === null ? null : report.totals.mutationScore * 100;
      const passed = threshold === undefined || (score !== null && score >= threshold);
      if (json) out({ summary: { totals: report.totals, perLayer: report.perLayer, gapCategories: report.gapCategories, wallTimeMs: report.wallTimeMs }, files, threshold: threshold ?? null, passed }, '');
      else {
        if (!cfg.reporters.includes('console')) console.log('\n' + textSummary(report));
        if (files.length) console.log('\n' + files.join('\n'));
        if (threshold !== undefined) console.log(`\nthreshold ${threshold}%: ${passed ? 'passed' : 'FAILED'} (score ${score === null ? 'n/a' : score.toFixed(1) + '%'})`);
      }
      return passed ? EXIT.OK : EXIT.THRESHOLD;
    }

    case 'report': {
      if (!pos[0]) throw new UsageError('usage: mlmt report <report.json> [-o out.html]');
      const report = readJson<RunReport>(pos[0]);
      const file = opts.o ?? opts.out ?? pos[0].replace(/\.json$/, '') + '.html';
      fs.writeFileSync(file, htmlReport(report));
      out({ file, totals: report.totals }, `${textSummary(report)}\n\nHTML: ${file}`);
      return EXIT.OK;
    }

    case 'aggregate': {
      if (!pos.length) throw new UsageError('usage: mlmt aggregate <report.json> ... [-o out.md]');
      const reports = pos.map((p) => readJson<RunReport>(path.resolve(p)));
      const md = aggregate(reports);
      const file = opts.o ?? opts.out;
      if (file) fs.writeFileSync(file, md);
      out({ file: file ?? null, markdown: md }, md);
      return EXIT.OK;
    }

    default:
      throw new UsageError(`unknown command: ${cmd} (see mlmt --help)`);
  }
}

/** Exit after stdout and stderr are flushed (piped output is asynchronous; a bare process.exit truncates it). */
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => exitAfterFlush(code),
    (e) => {
      if (e instanceof UsageError || e instanceof ConfigError) {
        console.error(`mlmt: ${e.message}`);
        return exitAfterFlush(EXIT.USAGE);
      }
      if (e instanceof AbortError) {
        console.error('mlmt: aborted');
        return exitAfterFlush(EXIT.ABORTED);
      }
      console.error('[mlmt] ERROR', e instanceof Error ? e.stack || e.message : e);
      exitAfterFlush(EXIT.ERROR);
    },
  );
}

export { main };
