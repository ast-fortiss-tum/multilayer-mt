let verbose = false;
export function setVerbose(v: boolean): void {
  verbose = v;
}
export const log = {
  info: (...a: unknown[]) => console.log('[mlmt]', ...a),
  warn: (...a: unknown[]) => console.warn('[mlmt] WARN', ...a),
  error: (...a: unknown[]) => console.error('[mlmt] ERROR', ...a),
  debug: (...a: unknown[]) => {
    if (verbose) console.log('[mlmt:debug]', ...a);
  },
};
