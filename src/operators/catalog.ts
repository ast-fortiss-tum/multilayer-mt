import type { Layer, OperatorInfo, DomScope } from '../types';

/**
 * The 51-operator catalog of MultilayerMT (thesis Table 4.2 and Sec. 4.2.1).
 * Defaults are the parameter defaults stated in the thesis.
 */

function op(
  id: string,
  layer: Layer,
  category: string,
  intent: string,
  defaults: Record<string, unknown> = {},
  scope?: DomScope,
): OperatorInfo {
  return { id, family: id.split('.')[0], layer, category, intent, defaults, scope, set: 'thesis', refs: ['Gozutok25'] };
}

const D = 'dom' as const;
const N = 'network' as const;
const T = 'test' as const;

export const DOM_OPERATORS: OperatorInfo[] = [
  // Attribute Mutations (5)
  op('AAM.required.add', D, 'Attribute Mutations', 'Enforce missing form validation', {}, 'element'),
  op('AAM.placeholder.remove', D, 'Attribute Mutations', 'Remove UI guidance text', {}, 'element'),
  op('AAM.inputType.swap', D, 'Attribute Mutations', 'Remove semantic browser validation', { toType: 'text' }, 'element'),
  op('AAM.ariaLabel.remove', D, 'Attribute Mutations', 'Remove accessibility metadata', {}, 'element'),
  op('AMM.href.null', D, 'Attribute Mutations', 'Break navigation links', { replacement: '#' }, 'element'),
  // Content Mutations (4)
  op('CDM.text.delete', D, 'Content Mutations', 'Remove user-visible content', {}, 'element'),
  op('CDM.text.shuffle', D, 'Content Mutations', 'Break text order assumptions', {}, 'element'),
  op('CDM.text.leet', D, 'Content Mutations', 'Introduce controlled textual noise', { probability: 0.18 }, 'element'),
  op('CDM.input.prependWhitespace', D, 'Content Mutations', 'Expose normalization assumptions', { padding: 1 }, 'element'),
  // Event Mutations (4)
  op('EHDM.click.remove', D, 'Event Mutations', 'Remove click handlers', {}, 'element'),
  op('EVD.click.stopPropagation', D, 'Event Mutations', 'Break event bubbling and delegation', { phase: 'target' }, 'element'),
  op('EVD.click.delay', D, 'Event Mutations', 'Reveal timing assumptions', { minMs: 300, maxMs: 800 }, 'element'),
  op('EVD.submit.delay', D, 'Event Mutations', 'Delay form submission', { minMs: 300, maxMs: 800 }, 'element'),
  // Style Mutations (4)
  op('SVM.visibility.hide', D, 'Style Mutations', 'Hide an element while preserving layout space', {}, 'element'),
  op('SVM.display.none', D, 'Style Mutations', 'Simulate missing UI elements by removing them from layout', {}, 'element'),
  op('SVM.opacity.dim', D, 'Style Mutations', 'Reduce visibility while keeping the element interactable', { opacity: 0.2 }, 'element'),
  op('SVM.force.scroll', D, 'Style Mutations', 'Introduce scrolling constraints', { maxHeightPx: 240 }, 'element'),
  // Tree Mutations (4)
  op('TIM.insert.ghostDiv', D, 'Tree Mutations', 'Introduce benign DOM noise', {}, 'element'),
  op('TIM.node.removeSafe', D, 'Tree Mutations', 'Simulate missing non-critical structural nodes', {
    selectors: ['footer', 'aside', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '.banner'],
  }, 'page'),
  op('TIM.wrap.div', D, 'Tree Mutations', 'Expose brittle parent-child CSS selectors', {}, 'element'),
  op('TIM.form.reorderFields', D, 'Tree Mutations', 'Expose tests assuming a fixed form field order', {}, 'element'),
  // Validation Mutations (3)
  op('FVM.required.toggle', D, 'Validation Mutations', 'Check required constraints are validated', {}, 'element'),
  op('PVM.pattern.break', D, 'Validation Mutations', 'Weaken or invalidate pattern-based validation', { strategy: 'auto' }, 'element'),
  op('FVM.minmax.remove', D, 'Validation Mutations', 'Remove range and length constraints', {}, 'element'),
  // Accessibility Mutations (4)
  op('ATD.alt.delete', D, 'Accessibility Mutations', 'Model missing alternative text for images', {}, 'element'),
  op('ARM.role.modify', D, 'Accessibility Mutations', 'Model incorrect ARIA roles', {
    mapping: {
      button: 'link', link: 'button', checkbox: 'radio', radio: 'checkbox', textbox: 'searchbox',
      searchbox: 'textbox', tab: 'button', menuitem: 'option', option: 'menuitem', navigation: 'region',
      dialog: 'region', heading: 'paragraph', listitem: 'none', combobox: 'textbox', img: 'presentation',
    },
  }, 'element'),
  op('LUM.label.unlink', D, 'Accessibility Mutations', 'Break label-to-control association', { suffix: '__broken' }, 'element'),
  op('ARM.describedby.remove', D, 'Accessibility Mutations', 'Remove help-text associations', {}, 'element'),
  // Resource Mutations (4)
  op('BSM.img.break', D, 'Resource Mutations', 'Model broken image resources', { suffix: '_404' }, 'element'),
  op('SFM.script.fail', D, 'Resource Mutations', 'Model missing or failing external scripts', { suffix: '.404.js' }, 'page'),
  op('RLB.router.break', D, 'Resource Mutations', 'Model broken SPA routing links', { brokenRoute: '/404-not-found' }, 'element'),
  op('SFM.stylesheet.fail', D, 'Resource Mutations', 'Model missing or failing external stylesheets', { suffix: '.404.css' }, 'page'),
];

export const NETWORK_OPERATORS: OperatorInfo[] = [
  // Payload Mutations (5)
  op('NPF.field.drop', N, 'Payload Mutations', 'Model missing fields in JSON responses', { fieldName: 'userId' }),
  op('NPR.field.rename', N, 'Payload Mutations', 'Model schema mismatches due to wrong field names', { oldName: 'username', newName: 'usrname' }),
  op('NPT.type.change', N, 'Payload Mutations', 'Model unexpected type changes in API responses', { fieldName: 'age', toType: 'auto' }),
  op('NPE.enum.invalid', N, 'Payload Mutations', 'Model invalid enum values', { fieldName: 'status', invalidValue: 'INVALID_STATUS' }),
  op('NPA.field.add', N, 'Payload Mutations', 'Model unexpected extra fields in API payloads', { fieldName: 'debug', fieldValue: true }),
  // Status Override (1)
  op('NSO.status.override', N, 'Status Override', 'Test inconsistent status and payload handling', { status: 500 }),
  // Latency Mutations (3)
  op('NLF.delay.fixed', N, 'Latency Mutations', 'Model slow network conditions', { delayMs: 2000 }),
  op('NLR.delay.jitter', N, 'Latency Mutations', 'Model unstable latency', { minMs: 100, maxMs: 1000 }),
  op('NLT.timeout.inject', N, 'Latency Mutations', 'Model request timeouts', {}),
  // Ordering Mutations (2)
  op('NOR.response.reorder', N, 'Ordering Mutations', 'Detect assumptions about array ordering', { strategy: 'reverse' }),
  op('NOD.response.duplicate', N, 'Ordering Mutations', 'Model stale or cached data being returned', {}),
];

export const TEST_OPERATORS: OperatorInfo[] = [
  // Timing Mutations (2)
  op('TWR.wait.remove', T, 'Timing Mutations', 'Expose hidden synchronization dependencies', {}),
  op('TWA.wait.add', T, 'Timing Mutations', 'Detect tests that tolerate unnecessary delays', { delayMs: 1000 }),
  // Oracle Mutations (4)
  op('AOL.assert.loosen', T, 'Oracle Mutations', 'Model weak assertions that still pass', {
    matcherMap: {
      toEqual: 'toContain', toStrictEqual: 'toEqual', toBe: 'toEqual', toHaveText: 'toContainText',
      toHaveURL: 'toBeTruthy', toHaveTitle: 'toBeTruthy', toHaveValue: 'toBeTruthy', toHaveCount: 'toBeTruthy',
    },
  }),
  op('AOT.assert.tighten', T, 'Oracle Mutations', 'Model overly strict assertions and brittleness', {
    matcherMap: {
      toContain: 'toEqual', toContainText: 'toHaveText', toEqual: 'toStrictEqual', toBeTruthy: 'toBe',
      toMatch: 'toBe', toBeGreaterThanOrEqual: 'toBeGreaterThan', toBeLessThanOrEqual: 'toBeLessThan',
    },
  }),
  op('AOV.visual.tolerance', T, 'Oracle Mutations', 'Model sensitivity of visual regression checks', { maxDiffPixels: 0, threshold: 0 }),
  op('AOF.assert.flip', T, 'Oracle Mutations', 'Check whether negative conditions are asserted', {}),
  // Selector Mutations (2)
  op('SOG.selector.generalize', T, 'Selector Mutations', 'Model overly generic selectors', {}),
  op('SOS.selector.specialize', T, 'Selector Mutations', 'Model brittle selectors tied to DOM structure', { index: 3 }),
];

export const ALL_OPERATORS: OperatorInfo[] = [...DOM_OPERATORS, ...NETWORK_OPERATORS, ...TEST_OPERATORS];

export const OPERATOR_BY_ID: Record<string, OperatorInfo> = Object.fromEntries(ALL_OPERATORS.map((o) => [o.id, o]));

export function getOperator(id: string): OperatorInfo {
  const o = OPERATOR_BY_ID[id];
  if (!o) throw new Error(`Unknown mutation operator: ${id}`);
  return o;
}

export function operatorsFor(layer: Layer): OperatorInfo[] {
  return ALL_OPERATORS.filter((o) => o.layer === layer);
}
