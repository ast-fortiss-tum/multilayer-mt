import type { ElementInfo, InteractionCounts, PweElement, PwePage, SuiteTrace } from '../types';

/**
 * Prioritized Web Elements (thesis Sec. 4.3, Table 4.3, Eq. 4.1).
 *
 *   PWE_Score = 0.4 x Interaction + 0.3 x Visibility + 0.3 x Semantic
 *
 * Each dimension is first computed in points (Sec. 4.3.1-4.3.3) and then
 * normalised to [0,1] (as in the MediaWiki case study, where I, V, S are in [0,1]):
 *   - Interaction: points / max interaction points on the same page
 *   - Visibility:  points / 25
 *   - Semantic:    points / 20
 */

export const INTERACTION_POINTS = { click: 10, fill: 15, focus: 5, hover: 3 } as const;
export const VISIBILITY_POINTS = { inViewport: 10, displayed: 5, opaque: 5, nonZeroSize: 5 } as const;
export const VISIBILITY_MAX = 25;
export const SEMANTIC_MAX = 20;
export const WEIGHTS = { interaction: 0.4, visibility: 0.3, semantic: 0.3 } as const;

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'searchbox', 'switch', 'tab', 'menuitem', 'option', 'slider', 'spinbutton',
]);
const FORM_TAGS = new Set(['form', 'fieldset', 'label']);
const SEMANTIC_CONTAINERS = new Set(['nav', 'header', 'footer', 'main', 'article']);
const GENERIC_CONTAINERS = new Set(['div', 'span', 'p']);

export function interactionPoints(c: InteractionCounts): number {
  return c.click * INTERACTION_POINTS.click + c.fill * INTERACTION_POINTS.fill + c.focus * INTERACTION_POINTS.focus + c.hover * INTERACTION_POINTS.hover;
}

export function visibilityPoints(el: ElementInfo): number {
  const v = el.visibility;
  return (
    (v.inViewport ? VISIBILITY_POINTS.inViewport : 0) +
    (v.displayed ? VISIBILITY_POINTS.displayed : 0) +
    (v.opaque ? VISIBILITY_POINTS.opaque : 0) +
    (v.nonZeroSize ? VISIBILITY_POINTS.nonZeroSize : 0)
  );
}

export function semanticPoints(el: ElementInfo): number {
  const tag = el.tag.toLowerCase();
  const role = (el.attrs.role || '').toLowerCase();
  if (INTERACTIVE_TAGS.has(tag) || INTERACTIVE_ROLES.has(role)) return 20;
  if (FORM_TAGS.has(tag) || role === 'form' || role === 'group') return 15;
  if (SEMANTIC_CONTAINERS.has(tag) || ['navigation', 'banner', 'contentinfo', 'main', 'article'].includes(role)) return 10;
  if (GENERIC_CONTAINERS.has(tag)) return 5;
  return 0;
}

export function pweScore(norm: { interaction: number; visibility: number; semantic: number }): number {
  return WEIGHTS.interaction * norm.interaction + WEIGHTS.visibility * norm.visibility + WEIGHTS.semantic * norm.semantic;
}

interface Acc {
  element: ElementInfo;
  counts: InteractionCounts;
  testFiles: Set<string>;
}

/** Merge per-test traces into per-page element tables. */
export function collectElements(trace: SuiteTrace): Map<string, { elements: Map<string, Acc>; testFiles: Set<string> }> {
  const pages = new Map<string, { elements: Map<string, Acc>; testFiles: Set<string> }>();
  const page = (k: string) => {
    let p = pages.get(k);
    if (!p) pages.set(k, (p = { elements: new Map(), testFiles: new Set() }));
    return p;
  };
  for (const t of trace.tests) {
    for (const [pageKey, els] of Object.entries(t.snapshots)) {
      const p = page(pageKey);
      p.testFiles.add(t.testFile);
      for (const el of Object.values(els)) {
        const prev = p.elements.get(el.selector);
        if (!prev) p.elements.set(el.selector, { element: el, counts: { click: 0, fill: 0, focus: 0, hover: 0 }, testFiles: new Set([t.testFile]) });
        else {
          prev.testFiles.add(t.testFile);
          const v = prev.element.visibility;
          prev.element = {
            ...el,
            visibility: {
              inViewport: v.inViewport || el.visibility.inViewport,
              displayed: v.displayed || el.visibility.displayed,
              opaque: v.opaque || el.visibility.opaque,
              nonZeroSize: v.nonZeroSize || el.visibility.nonZeroSize,
            },
          };
        }
      }
    }
    for (const it of t.interactions) {
      const p = page(it.pageKey);
      p.testFiles.add(t.testFile);
      const acc = p.elements.get(it.selector);
      if (!acc) continue; // element info is always sent with the interaction; defensive
      acc.counts[it.kind]++;
      acc.testFiles.add(t.testFile);
    }
  }
  return pages;
}

/** Build the PWE model: rank all candidate elements per page and keep the top `maxPwe`. */
export function buildPweModel(trace: SuiteTrace, maxPwe: number): PwePage[] {
  const out: PwePage[] = [];
  for (const [pageKey, { elements, testFiles }] of collectElements(trace)) {
    const accs = [...elements.values()];
    const rawI = accs.map((a) => interactionPoints(a.counts));
    const maxI = Math.max(0, ...rawI);
    const scored: PweElement[] = accs.map((a, i) => {
      const raw = { interaction: rawI[i], visibility: visibilityPoints(a.element), semantic: semanticPoints(a.element) };
      const norm = {
        interaction: maxI > 0 ? raw.interaction / maxI : 0,
        visibility: raw.visibility / VISIBILITY_MAX,
        semantic: raw.semantic / SEMANTIC_MAX,
      };
      return {
        pageKey,
        selector: a.element.selector,
        element: a.element,
        interactions: a.counts,
        raw,
        norm,
        score: Math.round(pweScore(norm) * 10000) / 10000,
        rank: 0,
        testFiles: [...a.testFiles].sort(),
      };
    });
    scored.sort(
      (a, b) => b.score - a.score || b.raw.interaction - a.raw.interaction || a.selector.localeCompare(b.selector),
    );
    scored.forEach((s, i) => (s.rank = i + 1));
    out.push({ pageKey, candidates: scored.length, selected: scored.slice(0, maxPwe), testFiles: [...testFiles].sort() });
  }
  return out.sort((a, b) => a.pageKey.localeCompare(b.pageKey));
}
