#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, MlmtConfig } from './config';
import { MutationEngine } from './engine/engine';
import { ALL_OPERATORS } from './operators/catalog';
import { aggregate, htmlReport, textSummary } from './report/report';
import type { Layer, RunReport, SuiteTrace } from './types';
import { readJson } from './util/fs';
import { log, setVerbose } from './util/log';

const HELP = `MultilayerMT - multi-layer runtime mutation testing for Playwright E2E suites

Usage: mlmt <command> [options]

Commands:
  operators                 List the 51 mutation operators
  trace                     Baseline + trace run (writes <outputDir>/trace.json)
  pwe                       Compute and print the PWE ranking from the trace
  generate                  Generate mutant descriptors (no execution)
  run                       Full pipeline: trace, PWE, generate, execute, report
  report <report.json>      Re-render the HTML report of a run
  aggregate <a.json> ...    Aggregate several run reports (Markdown tables of Ch. 5)

Options:
  -c, --config <file>       MultilayerMT config (JSON)
  --max-pwe <n>             Top-N PWEs per page (e.g. 4, 8, 16)
  --workers <n>             Parallel mutant executions
  --layers <list>           Comma-separated subset of dom,network,test
  --operators <list>        Comma-separated operator ids / family prefixes to include
  --max-mutants <n>         Execute a seeded random sample of n mutants
  --reuse-trace             Reuse an existing trace.json
  --all-tests               Run the whole suite for every mutant (default: covering tests)
  --keep-sandboxes          Keep .mutants/ directories for inspection
  -o, --out <file>          Output file (aggregate)
  -v, --verbose
`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      const key = a.replace(/^-+/, '');
      const [k, inline] = key.split('=');
      const flags = ['reuse-trace', 'all-tests', 'keep-sandboxes', 'v', 'verbose', 'h', 'help'];
      if (inline !== undefined) opts[k] = inline;
      else if (flags.includes(k)) opts[k] = true;
      else opts[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

function overridesFrom(opts: Record<string, string | boolean>): Partial<MlmtConfig> {
  const o: Partial<MlmtConfig> = {};
  if (opts['max-pwe']) o.maxPwe = Number(opts['max-pwe']);
  if (opts.workers) o.workers = Number(opts.workers);
  if (opts.layers) o.layers = String(opts.layers).split(',').map((s) => s.trim()) as Layer[];
  if (opts.operators) o.operators = { include: String(opts.operators).split(',').map((s) => s.trim()) };
  if (opts['max-mutants']) o.maxMutants = Number(opts['max-mutants']);
  if (opts['all-tests']) o.testSelection = 'all';
  if (opts['keep-sandboxes']) o.keepSandboxes = true;
  return o;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  if (opts.v || opts.verbose) setVerbose(true);
  if (!cmd || cmd === 'help' || opts.h || opts.help) {
    console.log(HELP);
    return 0;
  }
  const configFile = (opts.c || opts.config) as string | undefined;

  switch (cmd) {
    case 'operators': {
      const byLayer = (l: Layer) => ALL_OPERATORS.filter((o) => o.layer === l);
      for (const l of ['dom', 'network', 'test'] as Layer[]) {
        console.log(`\n${l.toUpperCase()} (${byLayer(l).length})`);
        for (const o of byLayer(l)) console.log(`  ${o.id.padEnd(30)} ${o.category.padEnd(24)} ${o.intent}`);
      }
      console.log(`\nTotal: ${ALL_OPERATORS.length}`);
      return 0;
    }
    case 'trace': {
      const engine = new MutationEngine(loadConfig(configFile, overridesFrom(opts)));
      try {
        await engine.startServer();
        await engine.trace();
      } finally {
        engine.cleanup();
        engine.stopServer();
      }
      return 0;
    }
    case 'pwe': {
      const engine = new MutationEngine(loadConfig(configFile, overridesFrom(opts)));
      const trace = readJson<SuiteTrace>(engine.paths.trace);
      for (const p of engine.pwe(trace)) {
        console.log(`\n${p.pageKey}  (${p.selected.length}/${p.candidates})`);
        for (const e of p.selected) {
          console.log(`  ${String(e.rank).padStart(3)}. ${e.score.toFixed(3)}  I=${e.norm.interaction.toFixed(2)} V=${e.norm.visibility.toFixed(2)} S=${e.norm.semantic.toFixed(2)}  <${e.element.tag}> ${e.selector}`);
        }
      }
      return 0;
    }
    case 'generate': {
      const engine = new MutationEngine(loadConfig(configFile, overridesFrom(opts)));
      const trace = readJson<SuiteTrace>(engine.paths.trace);
      const mutants = engine.generate(trace, engine.pwe(trace));
      console.log(`written ${engine.paths.mutants} (${mutants.length} mutants)`);
      return 0;
    }
    case 'run': {
      const engine = new MutationEngine(loadConfig(configFile, overridesFrom(opts)));
      const report = await engine.run({ reuseTrace: !!opts['reuse-trace'] });
      fs.writeFileSync(engine.paths.html, htmlReport(report));
      console.log('\n' + textSummary(report));
      console.log(`\nJSON: ${engine.paths.report}\nHTML: ${engine.paths.html}`);
      return 0;
    }
    case 'report': {
      if (!pos[0]) throw new Error('usage: mlmt report <report.json>');
      const report = readJson<RunReport>(pos[0]);
      const out = (opts.o || opts.out || pos[0].replace(/\.json$/, '.html')) as string;
      fs.writeFileSync(out, htmlReport(report));
      console.log(textSummary(report));
      console.log(`\nHTML: ${out}`);
      return 0;
    }
    case 'aggregate': {
      if (!pos.length) throw new Error('usage: mlmt aggregate <report.json> ...');
      const md = aggregate(pos.map((p) => readJson<RunReport>(path.resolve(p))));
      const out = (opts.o || opts.out) as string | undefined;
      if (out) fs.writeFileSync(out, md);
      console.log(md);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error(e instanceof Error ? e.stack || e.message : e);
    process.exit(1);
  },
);
