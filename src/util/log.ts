/** Logger used by the engine. The library is silent by default; the CLI logs to the console. */
export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  debug(...a: unknown[]): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export function consoleLogger(opts: { verbose?: boolean; stream?: 'stdout' | 'stderr' } = {}): Logger {
  // in --json mode everything human-readable goes to stderr
  const out = opts.stream === 'stderr' ? console.error : console.log;
  return {
    info: (...a) => out('[mlmt]', ...a),
    warn: (...a) => console.error('[mlmt] WARN', ...a),
    error: (...a) => console.error('[mlmt] ERROR', ...a),
    debug: (...a) => {
      if (opts.verbose) out('[mlmt:debug]', ...a);
    },
  };
}
