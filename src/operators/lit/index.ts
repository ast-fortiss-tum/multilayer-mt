/**
 * Literature operator library: mutation operators from the web mutation
 * testing literature beyond the 51 thesis operators. docs/OPERATORS.md lists
 * the source of every operator and the source operators not implemented.
 *
 * Modules here must only `import type` from ../registry (it imports this file).
 */
import type { OperatorDef } from '../registry';
import { DOM_ELEMENT_OPERATORS } from './domElement';
import { DOM_A11Y_VISUAL_OPERATORS } from './domA11y';
import { DOM_PAGE_OPERATORS } from './domPage';
import { NETWORK_LIT_OPERATORS } from './network';
import { TEST_LIT_OPERATORS } from './testScript';
import { JS_SOURCE_OPERATORS } from './jsSource';

export const LITERATURE_OPERATORS: OperatorDef[] = [
  ...DOM_ELEMENT_OPERATORS,
  ...DOM_A11Y_VISUAL_OPERATORS,
  ...DOM_PAGE_OPERATORS,
  ...NETWORK_LIT_OPERATORS,
  ...TEST_LIT_OPERATORS,
  ...JS_SOURCE_OPERATORS,
];
