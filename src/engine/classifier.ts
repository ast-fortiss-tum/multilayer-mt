import type { Counts, GapCategory, Layer, MutantDescriptor, MutantResult, MutantStatus, TestOutcome } from '../types';
import type { RunOutcome } from './executor';
import { testKey } from './executor';

/**
 * Result Classifier (thesis Sec. 4.2, Fig. 4.4 and Fig. 5.1).
 *
 *   pre-check applicable?      no  -> SKIPPED
 *   infrastructure error?      yes -> ERROR   (crash, no report, run timeout -> TIMEOUT)
 *   at least one test failed?  yes -> KILLED
 *   all tests passed                -> SURVIVED (test gap)
 *
 * DOM and network mutations are injected at runtime, so their pre-check is
 * evaluated in the browser: a mutation that was never applied during the run
 * (target element / request never matched) is SKIPPED.
 * Only tests that passed in the baseline run can kill a mutant.
 */
export function classify(
  mutant: MutantDescriptor,
  run: RunOutcome,
  baselinePassed: Set<string>,
  applications: number,
): { status: MutantStatus; reason: string } {
  if (run.timedOut) return { status: 'TIMEOUT', reason: 'mutant execution exceeded mutantTimeoutMs' };
  if (!run.reportFound) return { status: 'ERROR', reason: `no test report (exit ${run.exitCode}): ${run.stderr.slice(-500)}` };
  if (!run.tests.length) {
    return { status: 'ERROR', reason: run.errors[0] ? `no tests executed: ${run.errors[0]}` : 'no tests executed' };
  }
  if (mutant.layer !== 'test' && applications === 0) {
    return { status: 'SKIPPED', reason: 'mutation not applicable at runtime (target never matched)' };
  }
  const failed = run.tests.filter((t) => isFailure(t) && (baselinePassed.size === 0 || baselinePassed.has(testKey(t))));
  if (failed.length) return { status: 'KILLED', reason: `${failed.length} test(s) failed: ${failed.map((f) => f.title).slice(0, 3).join('; ')}` };
  if (run.errors.length) return { status: 'KILLED', reason: `unhandled error: ${run.errors[0].slice(0, 300)}` };
  return { status: 'SURVIVED', reason: 'all tests passed' };
}

export function isFailure(t: TestOutcome): boolean {
  return t.status === 'unexpected' || t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted';
}

const TIMING = /^(EVD\.click\.delay|EVD\.submit\.delay|NLF|NLR|NOR|NOD|TWR|TWA)\b/;
const ERROR_HANDLING = /^(NSO|NLT|NPF|NPR|NPT|NPE|NPA|SFM|BSM|RLB)\b/;

/** Test gap category of a survived mutant (thesis Table 5.6). */
export function gapCategory(operator: string): GapCategory {
  if (TIMING.test(operator)) return 'Timing Dependencies';
  if (ERROR_HANDLING.test(operator)) return 'Missing Error Handling';
  return 'Weak Assertions';
}

export function emptyCounts(): Counts {
  return { generated: 0, executed: 0, skipped: 0, killed: 0, survived: 0, timeout: 0, error: 0, mutationScore: null, applicability: null };
}

/** Metrics of thesis Sec. 5.2 / Table 5.1. */
export function countResults(results: MutantResult[]): Counts {
  const c = emptyCounts();
  for (const r of results) {
    c.generated++;
    if (r.status === 'KILLED') c.killed++;
    else if (r.status === 'SURVIVED') c.survived++;
    else if (r.status === 'SKIPPED') c.skipped++;
    else if (r.status === 'TIMEOUT') c.timeout++;
    else c.error++;
  }
  c.executed = c.killed + c.survived;
  c.mutationScore = c.executed ? c.killed / c.executed : null;
  c.applicability = c.generated ? c.executed / c.generated : null;
  return c;
}

export function countBy<K extends string>(results: MutantResult[], key: (r: MutantResult) => K): Record<K, Counts> {
  const groups = {} as Record<K, MutantResult[]>;
  for (const r of results) (groups[key(r)] ||= []).push(r);
  const out = {} as Record<K, Counts>;
  for (const k of Object.keys(groups) as K[]) out[k] = countResults(groups[k]);
  return out;
}

export function perLayer(results: MutantResult[]): Record<Layer, Counts> {
  const by = countBy(results, (r) => r.mutant.layer);
  return { dom: by.dom || emptyCounts(), network: by.network || emptyCounts(), test: by.test || emptyCounts() };
}
