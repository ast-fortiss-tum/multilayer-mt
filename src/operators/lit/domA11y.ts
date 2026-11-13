/**
 * Batch B: accessibility faults from Ma11y (Tafreshipour et al., ISSTA'24;
 * operators named after the WCAG failure techniques F<n> they inject) and
 * presentation-fault seeding from WebSee (Mahajan et al., ICST'15/'16).
 *
 * Every `apply` runs in the page: it is serialised with toString(), so it
 * must not reference anything outside its own body (module-level functions
 * below are used whole as `apply` and are self-contained as well).
 */
import type { OperatorDef } from '../registry';
import type { ElementInfo } from '../../types';
import { domOp } from './util';

const T = 'Tafreshipour24';
const M = 'Mahajan15';

/* ------------------------------------------------- generation-time predicates */
const FORM_CONTROLS = ['input', 'select', 'textarea'];
const NON_TEXT_INPUT = ['hidden', 'submit', 'button', 'reset', 'image'];
const allow = (b: boolean | undefined) => b !== false; // undefined fact = unknown => allow

function isFormControl(el: ElementInfo): boolean {
  return FORM_CONTROLS.includes(el.tag) && !(el.tag === 'input' && (el.attrs.type || '').toLowerCase() === 'hidden');
}
function isFocusable(el: ElementInfo): boolean {
  return (
    (el.tag === 'a' && 'href' in el.attrs) ||
    el.tag === 'button' ||
    isFormControl(el) ||
    'tabindex' in el.attrs
  ) && !('disabled' in el.attrs);
}
function isClickable(el: ElementInfo): boolean {
  const type = (el.attrs.type || '').toLowerCase();
  return (
    'onclick' in el.attrs ||
    (el.tag === 'a' && 'href' in el.attrs) ||
    el.tag === 'button' ||
    (el.tag === 'input' && ['submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(type)) ||
    el.attrs.role === 'button' ||
    el.attrs.role === 'link'
  );
}
const visible = (el: ElementInfo) => el.visibility.displayed && el.visibility.nonZeroSize;

/* ------------------------------------------------------ WebSee (Mahajan15) */

/**
 * Seeds ONE presentation fault: picks a CSS property (rand) and a value
 * (rand) from `params.properties` and sets it inline with !important. Values
 * `+50%`/`-50%` are relative to the computed value (or the rendered size when
 * the property is not numeric), `+50px`/`-50px` add to it. Candidates that do
 * not change the rendering are reverted and the next one is tried; nothing is
 * reported if no candidate has an effect.
 */
function vpsStyleApply(el: Element, p: Record<string, any>, h: { rand: () => number }): string | null {
  const e = el as HTMLElement;
  if (!e.style) return null;
  const props: Record<string, string[]> = p.properties || {};
  const LONG: Record<string, string[]> = {
    padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
    'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
    'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
    'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  };
  // properties whose computed value can change without any visible effect
  // (e.g. `top` on a static element): they must also move or resize the box
  const LAYOUT_ONLY = ['position', 'top', 'left', 'vertical-align', 'float', 'margin', 'width', 'height', 'max-height', 'min-height', 'padding', 'line-height'];
  const shuffle = <X>(a: X[]): X[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(h.rand() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  };
  const read = (prop: string) => {
    const cs = getComputedStyle(e);
    return (LONG[prop] || [prop]).map((l) => cs.getPropertyValue(l)).join('|');
  };
  const box = () => {
    const r = e.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(',');
  };
  const effective = (prop: string): boolean => {
    const cs = getComputedStyle(e);
    if (prop === 'color') return !!(e.textContent || '').trim();
    if (prop === 'border-color')
      return ['top', 'right', 'bottom', 'left'].some((s) => cs.getPropertyValue(`border-${s}-style`) !== 'none' && parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0);
    if (prop === 'outline-color') return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    return true;
  };
  const resolve = (prop: string, v: string): string => {
    const m = /^([+-])(\d+(?:\.\d+)?)(%|px)$/.exec(String(v));
    if (!m) return String(v);
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    let base = parseFloat(cs.getPropertyValue((LONG[prop] || [prop])[0]));
    if (isNaN(base)) base = /height|top|vertical|line/.test(prop) ? (prop === 'line-height' ? parseFloat(cs.fontSize) * 1.2 : r.height) : /width|left/.test(prop) ? r.width : 0;
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    const out = m[3] === '%' ? base * (1 + n / 100) : base + n;
    return `${Math.round(out * 100) / 100}px`;
  };
  for (const prop of shuffle(Object.keys(props))) {
    if (!effective(prop)) continue;
    for (const raw of shuffle((props[prop] || []).slice())) {
      const value = resolve(prop, raw);
      const style = e.getAttribute('style');
      const before = read(prop);
      const beforeBox = box();
      e.style.setProperty(prop, value, 'important');
      const changed = read(prop) !== before && (!LAYOUT_ONLY.includes(prop) || box() !== beforeBox);
      if (changed) return `${prop}:${value}`;
      if (style === null) e.removeAttribute('style');
      else e.setAttribute('style', style);
    }
  }
  return null;
}

/**
 * Seeds ONE fault in a presentational HTML attribute (width/height of
 * img/table/td/th/iframe, size of text inputs, align). Same selection and
 * no-effect rules as the CSS variant; values `+50%`/`-50%` are relative to
 * the rendered size (or the current `size`).
 */
function vpsAttrApply(el: Element, p: Record<string, any>, h: { rand: () => number }): string | null {
  const tag = el.tagName.toLowerCase();
  const byTag: Record<string, string[]> = p.attributes || {};
  const values: Record<string, string[]> = p.values || {};
  let attrs = (byTag[tag] || []).slice();
  if (tag === 'input') {
    const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (!['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t)) attrs = attrs.filter((a) => a !== 'size');
  }
  const shuffle = <X>(a: X[]): X[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(h.rand() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  };
  const snap = () => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(',') + '|' +
      ['text-align', 'float', 'vertical-align', 'margin-left', 'margin-right'].map((x) => cs.getPropertyValue(x)).join(',');
  };
  for (const a of shuffle(attrs)) {
    for (const raw of shuffle((values[a] || []).slice())) {
      let v = String(raw);
      const m = /^([+-])(\d+)%$/.exec(v);
      if (m) {
        const r = el.getBoundingClientRect();
        const base = a === 'size' ? (el as HTMLInputElement).size || 20 : a === 'height' ? r.height : r.width;
        v = String(Math.max(1, Math.round(base * (1 + (Number(m[2]) * (m[1] === '-' ? -1 : 1)) / 100))));
      }
      const prev = el.getAttribute(a);
      if (prev === v) continue;
      const before = snap();
      el.setAttribute(a, v);
      if (snap() !== before) return `${a}="${v}"${prev === null ? '' : ` (was "${prev}")`}`;
      if (prev === null) el.removeAttribute(a);
      else el.setAttribute(a, prev);
    }
  }
  return null;
}

const SIZE_VALUES = ['+50%', '-50%', '0', '1px', '500px'];
const COLOR_VALUES = ['red', 'green', 'blue', 'transparent', '#fff', '#000'];
const BORDER_STYLES = ['dotted', 'dashed', 'double', 'none', 'solid'];

const VPS_OPERATORS: OperatorDef[] = [
  domOp({
    id: 'VPS.color.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong colour (text, background, border or outline) breaks the intended appearance of the element.',
    refs: [M],
    aliases: ['WebSee:color', 'WebSee:background-color', 'WebSee:border-color', 'WebSee:outline-color'],
    defaults: {
      /** candidate CSS properties -> candidate values (one pair is applied, chosen with rand) */
      properties: { color: COLOR_VALUES, 'background-color': COLOR_VALUES, 'border-color': COLOR_VALUES, 'outline-color': COLOR_VALUES },
    },
    applicable: visible,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.size.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong box dimension (size, padding, border width, height limits) distorts the layout of the element.',
    refs: [M],
    aliases: ['WebSee:width', 'WebSee:height', 'WebSee:padding', 'WebSee:border-width', 'WebSee:max-height', 'WebSee:min-height'],
    defaults: {
      /** `+50%`/`-50%` are relative to the computed value (or rendered size) */
      properties: {
        width: SIZE_VALUES, height: SIZE_VALUES, padding: SIZE_VALUES, 'border-width': SIZE_VALUES, 'max-height': SIZE_VALUES, 'min-height': SIZE_VALUES,
      },
    },
    applicable: visible,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.position.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong positioning property (margin, position scheme, offsets, line height, alignment, float) displaces the element.',
    refs: [M],
    aliases: ['WebSee:margin', 'WebSee:position', 'WebSee:line-height', 'WebSee:vertical-align', 'WebSee:top', 'WebSee:left', 'WebSee:float'],
    defaults: {
      /** `+50px`/`-50px` are added to the computed offset (auto = 0) */
      properties: {
        margin: ['0', '25px', '50px', '-25px'],
        position: ['static', 'relative', 'absolute', 'fixed'],
        'line-height': ['0.5', '3', '+50%', '-50%'],
        'vertical-align': ['top', 'middle', 'bottom', 'baseline', 'sub', 'super'],
        top: ['+50px', '-50px'],
        left: ['+50px', '-50px'],
        float: ['left', 'right', 'none'],
      },
    },
    applicable: visible,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.visibility.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong display/overflow/visibility value changes how the element is laid out or clipped (never fully hidden: see SVM).',
    refs: [M],
    aliases: ['WebSee:display', 'WebSee:overflow', 'WebSee:visibility'],
    defaults: {
      properties: { display: ['inline', 'block', 'inline-block', 'flex'], overflow: ['hidden', 'scroll'], visibility: ['collapse'] },
    },
    applicable: visible,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.text.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong text-rendering property (font, direction, wrapping, alignment, spacing, decoration, case) alters how the text is displayed.',
    refs: [M],
    aliases: ['WebSee:font-size', 'WebSee:direction', 'WebSee:font-family', 'WebSee:white-space', 'WebSee:text-align', 'WebSee:letter-spacing',
      'WebSee:text-decoration', 'WebSee:word-spacing', 'WebSee:text-indent', 'WebSee:font-weight', 'WebSee:text-transform', 'WebSee:font-variant'],
    defaults: {
      properties: {
        'font-size': ['+50%', '-50%', '8px', '32px'],
        direction: ['rtl'],
        'font-family': ['monospace', 'serif'],
        'white-space': ['nowrap', 'pre'],
        'text-align': ['left', 'center', 'right', 'justify'],
        'letter-spacing': ['3px', '-1px'],
        'text-decoration': ['underline', 'line-through', 'none'],
        'word-spacing': ['10px', '-3px'],
        'text-indent': ['50px', '-50px'],
        'font-weight': ['bold', 'normal', '100'],
        'text-transform': ['uppercase', 'lowercase', 'capitalize'],
        'font-variant': ['small-caps'],
      },
    },
    applicable: (el) => visible(el) && !!el.text,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.decoration.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong border or outline style changes the decoration of the element.',
    refs: [M],
    aliases: ['WebSee:outline-style', 'WebSee:border-style'],
    defaults: { properties: { 'outline-style': BORDER_STYLES, 'border-style': BORDER_STYLES } },
    applicable: visible,
    apply: vpsStyleApply,
  }),
  domOp({
    id: 'VPS.htmlattr.change',
    category: 'Presentation Faults',
    scope: 'element',
    intent: 'A wrong presentational HTML attribute (width, height, size, align) distorts the element.',
    refs: [M],
    aliases: ['WebSee:width-attr', 'WebSee:height-attr', 'WebSee:size', 'WebSee:align'],
    defaults: {
      /** tag -> candidate attributes */
      attributes: {
        img: ['width', 'height', 'align'], table: ['width', 'height', 'align'], td: ['width', 'height', 'align'],
        th: ['width', 'height', 'align'], iframe: ['width', 'height', 'align'], input: ['size'],
      },
      /** attribute -> candidate values; `+50%`/`-50%` relative to the rendered size (size: current size) */
      values: { width: ['+50%', '-50%', '1', '500'], height: ['+50%', '-50%', '1', '500'], size: ['+50%', '-50%', '1', '100'], align: ['left', 'center', 'right'] },
    },
    applicable: (el, p) => {
      if (!visible(el)) return false;
      const by = (p.attributes || {}) as Record<string, string[]>;
      if (!by[el.tag] || !by[el.tag].length) return false;
      if (el.tag === 'input') return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes((el.attrs.type || '').toLowerCase());
      return true;
    },
    apply: vpsAttrApply,
  }),
];

/* ------------------------------------------------------ Ma11y (Tafreshipour24) */

const MA11Y_OPERATORS: OperatorDef[] = [
  domOp({
    id: 'A11.img.toDiv',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'An informative image is rendered as a CSS background of a <div>, so it has no text alternative (WCAG F3).',
    refs: [T],
    aliases: ['Ma11y:RID', 'Ma11y:F3'],
    defaults: {
      /** copy the image's other attributes (id, class, ...) to the <div> so non-a11y locators still resolve */
      keepAttributes: true,
      /** put the alt text inside the <div> as visible text (the Ma11y tool does; the plan does not) */
      altAsText: false,
    },
    applicable: (el) => el.tag === 'img' && !!(el.attrs.alt || '').trim() && allow(!el.facts.inLink),
    apply: (el, p, h) => {
      if (el.tagName !== 'IMG' || el.closest('a') || !(el.getAttribute('alt') || '').trim()) return null;
      const img = el as HTMLImageElement;
      const SKIP = ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'style', 'data-mlmt-mutated'];
      const replace = (): string | null => {
        if (!img.isConnected || img.offsetWidth <= 0 || img.offsetHeight <= 0) return null;
        const div = document.createElement('div');
        if (p.keepAttributes !== false) {
          for (const a of Array.from(img.attributes)) if (!SKIP.includes(a.name)) div.setAttribute(a.name, a.value);
        }
        if (p.altAsText) div.textContent = img.getAttribute('alt');
        const src = img.currentSrc || img.src;
        div.style.cssText =
          (img.getAttribute('style') || '') +
          `;display:inline-block;width:${img.offsetWidth}px;height:${img.offsetHeight}px;background-image:url(${JSON.stringify(src)});` +
          'background-repeat:no-repeat;background-position:top left;background-color:transparent;background-size:contain;';
        div.setAttribute('data-mlmt-mutated', 'A11.img.toDiv');
        img.replaceWith(div);
        return `<img alt="${img.getAttribute('alt')}"> -> <div> with background-image`;
      };
      if (img.complete && img.offsetWidth > 0) return replace();
      // not rendered yet: the size is only known once the image has loaded
      img.addEventListener('load', () => {
        const d = replace();
        if (d) h.report(d);
      }, { once: true });
      return null;
    },
  }),
  domOp({
    id: 'A11.alt.random',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'The text alternative of an image is meaningless (WCAG F30).',
    refs: [T],
    aliases: ['Ma11y:CIA', 'Ma11y:F30'],
    defaults: { /** length of the random alt text */ length: 6 },
    applicable: (el) => el.tag === 'img' && !!(el.attrs.alt || '').trim(),
    apply: (el, p, h) => {
      const old = el.getAttribute('alt');
      if (el.tagName !== 'IMG' || !(old || '').trim()) return null;
      const C = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      do {
        s = '';
        for (let i = 0; i < Math.max(1, Number(p.length) || 6); i++) s += C[Math.floor(h.rand() * C.length)];
      } while (s === old);
      el.setAttribute('alt', s);
      return `alt "${old}" -> "${s}"`;
    },
  }),
  domOp({
    id: 'A11.img.unlabel',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'An image has no text alternative at all: alt, aria-label and title are removed (WCAG F65).',
    refs: [T],
    aliases: ['Ma11y:RIA', 'Ma11y:F65'],
    applicable: (el) => el.tag === 'img' && ('alt' in el.attrs || 'aria-label' in el.attrs || 'title' in el.attrs),
    apply: (el) => {
      if (el.tagName !== 'IMG') return null;
      const gone = ['alt', 'aria-label', 'title'].filter((a) => el.hasAttribute(a));
      if (!gone.length) return null;
      gone.forEach((a) => el.removeAttribute(a));
      return `removed ${gone.join(', ')}`;
    },
  }),
  domOp({
    id: 'A11.heading.toP',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'A heading is only visually styled as one: a bold, large <p> without heading semantics (WCAG F2).',
    refs: [T],
    aliases: ['Ma11y:RHP', 'Ma11y:F2'],
    applicable: (el) => /^h[1-6]$/.test(el.tag) && allow(el.facts.isLeaf) && !!el.text,
    apply: (el) => {
      if (!/^H[1-6]$/.test(el.tagName) || el.children.length || !(el.textContent || '').trim() || !el.parentNode) return null;
      const para = document.createElement('p');
      for (const a of Array.from(el.attributes)) if (a.name !== 'data-mlmt-mutated') para.setAttribute(a.name, a.value);
      while (el.firstChild) para.appendChild(el.firstChild);
      para.style.setProperty('font-size', '1.5em');
      para.style.setProperty('font-weight', 'bold');
      para.style.setProperty('margin-block-start', '0.67em');
      para.style.setProperty('margin-block-end', '0.67em');
      para.setAttribute('data-mlmt-mutated', 'A11.heading.toP');
      el.parentNode.replaceChild(para, el);
      return `<${el.tagName.toLowerCase()}> -> styled <p>`;
    },
  }),
  domOp({
    id: 'A11.text.spaced',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'White space is used to space the letters of a word, so it is no longer read as a word (WCAG F32).',
    refs: [T],
    aliases: ['Ma11y:ASB', 'Ma11y:F32'],
    applicable: (el) =>
      allow(el.facts.isLeaf) && el.text.replace(/\s/g, '').length >= 2 &&
      !['input', 'select', 'textarea', 'img', 'option', 'script', 'style', 'svg', 'canvas', 'iframe', 'video', 'audio'].includes(el.tag),
    apply: (el) => {
      if (el.children.length || ['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName)) return null;
      const t = (el.textContent || '').trim();
      const spaced = Array.from(t).join(' ');
      if (t.replace(/\s/g, '').length < 2 || spaced === el.textContent) return null;
      el.textContent = spaced;
      return `"${t.slice(0, 40)}" -> "${spaced.slice(0, 60)}"`;
    },
  }),
  domOp({
    id: 'A11.link.toSpan',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'A link is a scripted <span> styled as a link: not focusable, no link role, no keyboard activation (WCAG F42).',
    refs: [T],
    aliases: ['Ma11y:RAS', 'Ma11y:F42'],
    applicable: (el) => el.tag === 'a' && 'href' in el.attrs,
    apply: (el) => {
      const href = el.getAttribute('href');
      if (el.tagName !== 'A' || href === null || !el.parentNode) return null;
      const span = document.createElement('span');
      for (const a of Array.from(el.attributes)) if (a.name !== 'href' && a.name !== 'data-mlmt-mutated') span.setAttribute(a.name, a.value);
      while (el.firstChild) span.appendChild(el.firstChild);
      span.style.setProperty('text-decoration', 'underline');
      span.style.setProperty('cursor', 'pointer');
      span.style.setProperty('color', 'blue');
      const url = (el as HTMLAnchorElement).href;
      const target = el.getAttribute('target');
      // as onclick="window.location.href=..." in the tool, but CSP-proof; a
      // handler that cancels the click also cancels the navigation, as on <a>
      span.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        if (target && target !== '_self') window.open(url, target);
        else window.location.href = url;
      });
      span.setAttribute('data-mlmt-mutated', 'A11.link.toSpan');
      el.parentNode.replaceChild(span, el);
      return `<a href="${href}"> -> <span onclick>`;
    },
  }),
  domOp({
    id: 'A11.th.toTd',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Table headers are plain data cells, so the table has no header relationships (WCAG F91).',
    refs: [T],
    aliases: ['Ma11y:RHD', 'Ma11y:F91'],
    applicable: (el) => el.tag === 'table' || el.tag === 'th',
    apply: (el, _p, h) => {
      const table = el.tagName === 'TABLE' ? el : el.closest('table');
      if (!table) return null;
      const convert = (): number => {
        const ths = Array.from(table.querySelectorAll('th'));
        for (const th of ths) {
          const td = document.createElement('td');
          for (const a of Array.from(th.attributes)) if (a.name !== 'scope' && a.name !== 'abbr') td.setAttribute(a.name, a.value);
          while (th.firstChild) td.appendChild(th.firstChild);
          td.setAttribute('data-mlmt-mutated', 'A11.th.toTd');
          th.replaceWith(td);
        }
        return ths.length;
      };
      const n = convert();
      // headers rendered later (client-side tables) are converted as well
      const obs = new MutationObserver(() => {
        if (!table.querySelector('th')) return;
        const k = convert();
        if (k) h.report(`${k} <th> -> <td> (late)`);
      });
      obs.observe(table, { childList: true, subtree: true });
      return n ? `${n} <th> -> <td>` : null;
    },
  }),
  domOp({
    id: 'A11.link.undecorate',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'A link is distinguished from surrounding text by colour only: no underline, default cursor, also on hover and focus (WCAG F73).',
    refs: [T],
    aliases: ['Ma11y:RAD', 'Ma11y:F73'],
    applicable: (el) => el.tag === 'a' && 'href' in el.attrs,
    apply: (el) => {
      const e = el as HTMLElement;
      if (el.tagName !== 'A' || !el.hasAttribute('href')) return null;
      const cs = getComputedStyle(e);
      if (cs.textDecorationLine === 'none' && cs.cursor === 'default') return null;
      // inline !important also wins over :hover/:focus rules of the page
      e.style.setProperty('text-decoration', 'none', 'important');
      e.style.setProperty('cursor', 'default', 'important');
      return 'text-decoration:none; cursor:default';
    },
  }),
  domOp({
    id: 'A11.input.smallFont',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'A form field uses a fixed small font size that does not scale (WCAG F80).',
    refs: [T],
    aliases: ['Ma11y:CIF', 'Ma11y:F80'],
    defaults: { /** forced font size */ fontSize: '8pt' },
    applicable: (el) => isFormControl(el),
    apply: (el, p) => {
      const e = el as HTMLElement;
      if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || (el as HTMLInputElement).type === 'hidden') return null;
      const size = String(p.fontSize || '8pt');
      const before = getComputedStyle(e).fontSize;
      const style = e.getAttribute('style');
      e.style.setProperty('font-size', size, 'important');
      if (getComputedStyle(e).fontSize !== before) return `font-size:${size}`;
      if (style === null) e.removeAttribute('style');
      else e.setAttribute('style', style);
      return null;
    },
  }),
  domOp({
    id: 'A11.text.vhFont',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Text is sized in viewport units, so it does not resize with the browser text size (WCAG F94).',
    refs: [T],
    aliases: ['Ma11y:CPF', 'Ma11y:F94'],
    defaults: { /** forced font size */ fontSize: '2vh' },
    applicable: (el) => !!el.text && !['img', 'svg', 'canvas', 'iframe', 'video', 'audio'].includes(el.tag),
    apply: (el, p) => {
      const e = el as HTMLElement;
      if (!e.style || !(e.textContent || '').trim()) return null;
      const size = String(p.fontSize || '2vh');
      const before = getComputedStyle(e).fontSize;
      const style = e.getAttribute('style');
      e.style.setProperty('font-size', size, 'important');
      if (getComputedStyle(e).fontSize !== before) return `font-size:${size}`;
      if (style === null) e.removeAttribute('style');
      else e.setAttribute('style', style);
      return null;
    },
  }),
  domOp({
    id: 'A11.link.noOutline',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'The visible focus indicator of a link or button is removed (WCAG F78).',
    refs: [T],
    aliases: ['Ma11y:ROA', 'Ma11y:F78'],
    applicable: (el) => el.tag === 'a' || el.tag === 'button',
    apply: (el) => {
      const e = el as HTMLElement;
      if (el.tagName !== 'A' && el.tagName !== 'BUTTON') return null;
      const id = '__mlmt_a11y_no_outline';
      if (!document.getElementById(id)) {
        const s = document.createElement('style');
        s.id = id;
        s.textContent = '.mlmt-a11y-no-outline,.mlmt-a11y-no-outline:focus,.mlmt-a11y-no-outline:focus-visible{outline:none !important;}';
        (document.head || document.documentElement).appendChild(s);
      }
      e.classList.add('mlmt-a11y-no-outline');
      e.style.setProperty('outline', 'none', 'important'); // also beats inline styles of the page
      return 'outline:none on focus';
    },
  }),
  domOp({
    id: 'A11.text.blink',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Content blinks indefinitely and cannot be stopped (WCAG F4).',
    refs: [T],
    aliases: ['Ma11y:MTB', 'Ma11y:F4'],
    defaults: { /** blink period */ duration: '1s' },
    applicable: (el) => el.visibility.displayed && !!el.text,
    apply: (el, p) => {
      const e = el as HTMLElement;
      if (!e.style || !(e.textContent || '').trim()) return null;
      const id = '__mlmt_a11y_blink';
      if (!document.getElementById(id)) {
        const s = document.createElement('style');
        s.id = id;
        s.textContent = '@keyframes mlmt-a11y-blink{50%{opacity:0;}}';
        (document.head || document.documentElement).appendChild(s);
      }
      e.style.setProperty('animation', `mlmt-a11y-blink ${String(p.duration || '1s')} linear infinite`, 'important');
      return 'blinking (opacity animation)';
    },
  }),
  domOp({
    id: 'A11.nav.reverseTab',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'The tab order of a group of links contradicts their visual order (WCAG F44).',
    refs: [T],
    aliases: ['Ma11y:CTO', 'Ma11y:F44'],
    applicable: (el) => ['ul', 'ol', 'nav', 'menu', 'div'].includes(el.tag) && el.facts.childElementCount >= 1,
    apply: (el, _p, h) => {
      const order = (): string | null => {
        const links = Array.from(el.querySelectorAll('a[href]'));
        if (links.length < 2) return null;
        links.forEach((a, i) => a.setAttribute('tabindex', String(links.length - i)));
        return `reversed tab order of ${links.length} links`;
      };
      const d = order();
      if (d) return d;
      // menus rendered later
      const obs = new MutationObserver(() => {
        const late = order();
        if (late) {
          obs.disconnect();
          h.report(late);
        }
      });
      obs.observe(el, { childList: true, subtree: true });
      return null;
    },
  }),
  domOp({
    id: 'A11.imgLink.unlabel',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'An image link has no accessible name: link labels removed and image alt emptied (WCAG F89).',
    refs: [T],
    aliases: ['Ma11y:RAI', 'Ma11y:F89'],
    applicable: (el) => el.tag === 'a' && el.facts.hasImgDescendant,
    apply: (el) => {
      if (el.tagName !== 'A') return null;
      const imgs = Array.from(el.querySelectorAll('img'));
      if (!imgs.length) return null;
      const gone = ['aria-label', 'aria-labelledby', 'title'].filter((a) => el.hasAttribute(a));
      const alts = imgs.filter((i) => i.getAttribute('alt') !== '');
      if (!gone.length && !alts.length) return null;
      gone.forEach((a) => el.removeAttribute(a));
      alts.forEach((i) => i.setAttribute('alt', ''));
      return `removed ${[...gone, alts.length ? `alt of ${alts.length} image(s)` : ''].filter(Boolean).join(', ')}`;
    },
  }),
  domOp({
    id: 'A11.click.toMousedown',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Functionality is bound to a mouse-only event, so keyboard activation does nothing (WCAG F54).',
    refs: [T],
    aliases: ['Ma11y:CDP', 'Ma11y:F54'],
    applicable: isClickable,
    apply: (el) => {
      const onclick = el.getAttribute('onclick');
      if (onclick !== null) {
        el.setAttribute('onmousedown', onclick);
        el.removeAttribute('onclick');
      }
      // keyboard (and programmatic) activation dispatches a click with detail 0
      window.addEventListener('click', (e) => {
        const t = e.target as Node | null;
        if (e.detail !== 0 || !t || !(el === t || el.contains(t))) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      }, true);
      return onclick !== null ? 'onclick -> onmousedown; keyboard clicks blocked' : 'keyboard clicks blocked';
    },
  }),
  domOp({
    id: 'A11.button.ariaMismatch',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'The accessible name of a control does not contain its visible label (WCAG F96).',
    refs: [T],
    aliases: ['Ma11y:CBL', 'Ma11y:F96'],
    defaults: { /** length of the random aria-label */ length: 6 },
    applicable: (el) =>
      el.tag === 'button' || el.tag === 'a' || el.attrs.role === 'button' ||
      (el.tag === 'input' && ['submit', 'button'].includes((el.attrs.type || '').toLowerCase())),
    apply: (el, p, h) => {
      const old = el.getAttribute('aria-label');
      const C = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      do {
        s = '';
        for (let i = 0; i < Math.max(1, Number(p.length) || 6); i++) s += C[Math.floor(h.rand() * C.length)];
      } while (s === old);
      el.setAttribute('aria-label', s);
      return `aria-label -> "${s}"`;
    },
  }),
  domOp({
    id: 'A11.focus.blur',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'An element loses focus as soon as it receives it, so it cannot be operated from the keyboard (WCAG F55).',
    refs: [T],
    aliases: ['Ma11y:RFA', 'Ma11y:F55'],
    applicable: isFocusable,
    apply: (el) => {
      const e = el as HTMLElement;
      if (typeof e.blur !== 'function') return null;
      e.addEventListener('focus', () => e.blur());
      if (document.activeElement === e) e.blur();
      return 'blurs on focus';
    },
  }),
  domOp({
    id: 'A11.click.openWindow',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Clicking text unexpectedly opens a new window (change of context; WCAG F22).',
    refs: [T],
    aliases: ['Ma11y:CCC', 'Ma11y:F22'],
    defaults: { /** URL of the opened window */ url: 'about:blank' },
    applicable: (el) => ['span', 'p', 'div'].includes(el.tag) && allow(el.facts.isLeaf) && !!el.text,
    apply: (el, p) => {
      if (!(el.textContent || '').trim()) return null;
      if (el.tagName === 'SPAN') {
        // as in the tool: the span loses its own styling
        el.removeAttribute('class');
        el.removeAttribute('style');
      }
      const url = String(p.url || 'about:blank');
      el.addEventListener('click', () => { window.open(url); });
      return `click opens ${url}`;
    },
  }),
  domOp({
    id: 'A11.blur.openWindow',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Leaving a field unexpectedly opens a new window (change of context on blur; WCAG F9).',
    refs: [T],
    aliases: ['Ma11y:CCB', 'Ma11y:F9'],
    defaults: { /** URL of the opened window */ url: 'about:blank' },
    applicable: isFocusable,
    apply: (el, p) => {
      const url = String(p.url || 'about:blank');
      el.addEventListener('blur', () => { window.open(url); });
      return `blur opens ${url}`;
    },
  }),
  domOp({
    id: 'A11.input.autoSubmit',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Changing a field automatically submits its form (change of context on input; WCAG F36).',
    refs: [T],
    aliases: ['Ma11y:CCI', 'Ma11y:F36'],
    applicable: (el) => el.tag === 'input' && el.facts.inForm && !NON_TEXT_INPUT.includes((el.attrs.type || '').toLowerCase()),
    apply: (el) => {
      const input = el as HTMLInputElement;
      if (el.tagName !== 'INPUT' || !input.form) return null;
      input.addEventListener('change', () => {
        const f = input.form;
        if (!f) return;
        try {
          if (typeof f.requestSubmit === 'function') f.requestSubmit();
          else f.submit();
        } catch {
          f.submit();
        }
      });
      return 'change submits the form';
    },
  }),
  domOp({
    id: 'A11.select.openWindow',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'Choosing an option unexpectedly opens a new window (change of context on selection; WCAG F37).',
    refs: [T],
    aliases: ['Ma11y:CCS', 'Ma11y:F37'],
    defaults: { /** URL of the opened window */ url: 'about:blank' },
    applicable: (el) => el.tag === 'select' || el.tag === 'option' || (el.tag === 'input' && (el.attrs.type || '').toLowerCase() === 'radio'),
    apply: (el, p) => {
      const url = String(p.url || 'about:blank');
      const target = el.tagName === 'OPTION' ? el.closest('select') : el;
      if (!target) return null;
      if (target.tagName === 'SELECT') {
        target.addEventListener('change', () => { window.open(url); });
        return `change opens ${url}`;
      }
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'radio') {
        target.addEventListener('click', () => { window.open(url); });
        return `click opens ${url}`;
      }
      return null;
    },
  }),
  domOp({
    id: 'A11.input.unname',
    category: 'Accessibility Faults',
    scope: 'element',
    intent: 'A form field has no label: its placeholder and every associated label are removed (WCAG F68).',
    refs: [T],
    aliases: ['Ma11y:RIN', 'Ma11y:F68'],
    // wrapping labels are not recorded in the trace: every labelable control is a candidate
    applicable: (el) => isFormControl(el) && !NON_TEXT_INPUT.includes((el.attrs.type || '').toLowerCase()),
    apply: (el) => {
      if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return null;
      const done: string[] = [];
      if (el.hasAttribute('placeholder')) {
        el.removeAttribute('placeholder');
        done.push('placeholder');
      }
      const labels = Array.from((el as HTMLInputElement).labels || []);
      let removed = 0;
      let stripped = 0;
      for (const l of labels) {
        if (!l.contains(el) && !l.querySelector('input, select, textarea, button')) {
          l.remove();
          removed++;
          continue;
        }
        // wrapping label: drop its text, keep the controls
        const walker = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) if ((n.nodeValue || '').trim() && !el.contains(n)) texts.push(n as Text);
        texts.forEach((t) => t.remove());
        if (texts.length) stripped++;
      }
      if (removed) done.push(`${removed} label(s)`);
      if (stripped) done.push(`text of ${stripped} wrapping label(s)`);
      return done.length ? `removed ${done.join(', ')}` : null;
    },
  }),
];

export const DOM_A11Y_VISUAL_OPERATORS: OperatorDef[] = [...MA11Y_OPERATORS, ...VPS_OPERATORS];
