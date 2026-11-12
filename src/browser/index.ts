/**
 * Browser-side scripts (`multilayer-mt/browser`). Each function is
 * self-contained and meant to be injected with `addInitScript` / `evaluate`:
 *
 *   await page.addInitScript({ content: `(${mlmtRecorder})(${JSON.stringify(spec)})` });
 */
export { mlmtDomMutator } from './domMutator';
export type { DomMutationSpec, CustomDomApply } from './domMutator';
export { mlmtRecorder } from './recorder';
export type { RecorderSpec } from './recorder';
