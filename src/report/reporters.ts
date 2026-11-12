import * as fs from 'fs';
import * as path from 'path';
import type { ReporterFn, ReporterSpec, ResolvedConfig } from '../config';
import type { RunReport } from '../types';
import { ensureDir } from '../util/fs';
import type { Logger } from '../util/log';
import { aggregate, htmlReport, textSummary } from './report';

/** Built-in reporters. Each writes into `outputDir` and returns the files written. */
export const BUILTIN_REPORTERS: Record<string, (r: RunReport, outDir: string, logger: Logger, opts: Record<string, unknown>) => string[]> = {
  json: (r, out, _l, o) => {
    const f = path.join(out, String(o.file ?? `report-pwe${r.config.maxPwe}.json`));
    fs.writeFileSync(f, JSON.stringify(r, null, 2));
    return [f];
  },
  html: (r, out, _l, o) => {
    const f = path.join(out, String(o.file ?? `report-pwe${r.config.maxPwe}.html`));
    fs.writeFileSync(f, htmlReport(r));
    return [f];
  },
  markdown: (r, out, _l, o) => {
    const f = path.join(out, String(o.file ?? `report-pwe${r.config.maxPwe}.md`));
    fs.writeFileSync(f, aggregate([r]));
    return [f];
  },
  console: (r, _out, logger) => {
    logger.info('\n' + textSummary(r));
    return [];
  },
};

/** Run the configured reporters; returns the files written. */
export async function runReporters(report: RunReport, cfg: ResolvedConfig, logger: Logger, specs: ReporterSpec[] = cfg.reporters): Promise<string[]> {
  ensureDir(cfg.abs.outputDir);
  const files: string[] = [];
  for (const spec of specs) {
    let name: string | ReporterFn;
    let opts: Record<string, unknown> = {};
    if (Array.isArray(spec)) [name, opts] = spec;
    else name = spec as string | ReporterFn;
    if (typeof name === 'function') {
      await name(report, { outputDir: cfg.abs.outputDir, config: cfg });
    } else if (BUILTIN_REPORTERS[name]) {
      files.push(...BUILTIN_REPORTERS[name](report, cfg.abs.outputDir, logger, opts));
    } else {
      // custom reporter module: default export (report, ctx, options) => void
      const mod = require(path.resolve(cfg.abs.root, name));
      const fn = mod?.default ?? mod;
      if (typeof fn !== 'function') throw new Error(`reporter ${name} does not export a function`);
      await fn(report, { outputDir: cfg.abs.outputDir, config: cfg }, opts);
    }
  }
  return files;
}
