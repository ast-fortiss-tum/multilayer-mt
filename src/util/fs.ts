import * as fs from 'fs';
import * as path from 'path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const IGNORED = new Set(['node_modules', '.git', '.mlmt', '.mutants', 'test-results', 'playwright-report']);

/** Recursively list files below `dir` (paths relative to `dir`). */
export function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const SOURCE_EXT = /\.(c|m)?(j|t)sx?$/;
export const TEST_FILE = /\.(spec|test)\.(c|m)?(j|t)sx?$/;
