/**
 * Literature DOM element operators (batch A): MAEWU (Yandrapally21), FragGen
 * (Yandrapally22), webMuJava (Praphamontripong10/17), responsive-layout
 * operators (Walsh20) and GUI-level operators (Oliveira15).
 *
 * Every `apply` below runs in the page (serialised with `toString()`), so it is
 * fully self-contained: helpers are repeated inline where needed. Structural
 * operators that can shift positional (`:nth-of-type`) selectors onto another
 * element after mutating (remove, move, swap, tag/widget replacement) apply
 * once per document (window flag `__mlmtOnce_<id>`), otherwise the mutator's
 * MutationObserver would cascade the mutation onto the shifted siblings.
 *
 * Applicability (`applicable`) runs at generation time on the recorded element.
 */
import type { OperatorDef } from '../registry';
import type { ElementInfo } from '../../types';
import { domOp } from './util';

/* ------------------------------------------------------------- node-side */

const CLICK_ROLES = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'];
const CLICK_INPUT_TYPES = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'];
const FORM_CONTROLS = ['input', 'textarea', 'select', 'option'];
const NO_TEXT_TAGS = [
  ...FORM_CONTROLS,
  'img', 'br', 'hr', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr', 'meta', 'link',
  'iframe', 'canvas', 'video', 'audio', 'svg', 'object', 'picture', 'script', 'style', 'template',
];
const TEXT_LIKE_INPUTS = ['', 'text', 'email', 'search', 'tel', 'url', 'password', 'number'];
const RENAME_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'b', 'strong', 'i', 'em'];
const SUFFIX_TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'b', 'i', 'span', 'a', 'button', 'label', 'li', 'td'];

function clickable(el: ElementInfo): boolean {
  if (el.tag === 'a' || el.tag === 'button' || el.tag === 'summary') return true;
  if (el.tag === 'input' && CLICK_INPUT_TYPES.includes((el.attrs.type || '').toLowerCase())) return true;
  if ('onclick' in el.attrs) return true;
  return CLICK_ROLES.includes((el.attrs.role || '').toLowerCase());
}
/** undefined (old traces) ⇒ unknown ⇒ allow */
const leaf = (el: ElementInfo) => el.facts.isLeaf !== false;
const displayed = (el: ElementInfo) => el.visibility.displayed;
const structural = (el: ElementInfo) => !['html', 'body', 'head'].includes(el.tag);
const inForm = (el: ElementInfo) => el.tag === 'form' || el.facts.inForm;

function attrCandidates(tag: string): string[] {
  const c = ['id', 'class', 'name'];
  if (tag === 'button' || tag === 'input') c.push('type', 'formaction', 'formmethod');
  if (tag === 'form') c.push('action', 'method');
  if (tag === 'a') c.push('href');
  return c;
}
/** Present candidate attributes whose removal changes something (static view). */
function deletable(el: ElementInfo): string[] {
  return attrCandidates(el.tag).filter((a) => {
    const v = el.attrs[a];
    if (v === undefined) return false;
    const lv = v.trim().toLowerCase();
    if (a === 'class') return lv !== '';
    if (a === 'type' && el.tag === 'input') return lv !== 'text' && lv !== '';
    if (a === 'type' && el.tag === 'button') return lv !== 'submit' && lv !== '';
    if (a === 'method') return lv !== 'get' && lv !== '';
    return true;
  });
}

/* ------------------------------------------------------------- operators */

export const DOM_ELEMENT_OPERATORS: OperatorDef[] = [
  /* ===================================================== attributes (DAT) */
  domOp({
    id: 'DAT.attr.add',
    category: 'Attribute Mutations',
    intent: 'An attribute the element should not have (id, class, name, type, action, href, ...) is added with a value used elsewhere on the page.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:AAM'],
    scope: 'element',
    defaults: { fallbackSuffix: '_mut' },
    applicable: (el) => attrCandidates(el.tag).some((a) => !(a in el.attrs)),
    apply: function (el: Element, p: Record<string, any>, h) {
      const tag = el.tagName.toLowerCase();
      const cands = ['id', 'class', 'name'];
      if (tag === 'button' || tag === 'input') cands.push('type', 'formaction', 'formmethod');
      if (tag === 'form') cands.push('action', 'method');
      if (tag === 'a') cands.push('href');
      const missing = cands.filter((a) => !el.hasAttribute(a));
      if (!missing.length) return null;
      const a = missing[Math.floor(h.rand() * missing.length)];
      const e: any = el;
      const form: any = e.form || null;
      // value the attribute effectively has while missing (adding it must change it)
      const probe = (v: string): string => {
        const x: any = document.createElement(tag);
        if (a !== 'type' && el.hasAttribute('type')) x.setAttribute('type', el.getAttribute('type'));
        x.setAttribute(a, v);
        if (a === 'type') return String(x.type);
        if (a === 'method') return String(x.method);
        if (a === 'formmethod') return String(x.formMethod);
        if (a === 'action') return String(x.action);
        if (a === 'formaction') return String(x.formAction);
        if (a === 'href') return String(x.href);
        return v;
      };
      let current: string | null = null;
      if (a === 'type') current = String(e.type);
      else if (a === 'method') current = String(e.method);
      else if (a === 'action') current = String(e.action);
      else if (a === 'formmethod') current = form ? String(form.method) : 'get';
      else if (a === 'formaction') current = form ? String(form.action) : location.href;
      const pool: string[] = [];
      const seen: Record<string, boolean> = {};
      document.querySelectorAll('[' + a + ']').forEach((o) => {
        if (o === el) return;
        const raw = o.getAttribute(a) || '';
        const vals = a === 'class' ? raw.split(/\s+/) : [raw];
        for (const v of vals) {
          if (!v || seen[v]) continue;
          if (current !== null && probe(v) === current) continue;
          seen[v] = true;
          pool.push(v);
        }
      });
      let v: string;
      if (pool.length) v = pool[Math.floor(h.rand() * pool.length)];
      else if (a === 'type') v = tag === 'button' ? (e.type === 'button' ? 'reset' : 'button') : e.type === 'checkbox' ? 'radio' : 'checkbox';
      else if (a === 'method' || a === 'formmethod') v = current === 'post' ? 'get' : 'post';
      else v = a + String(p.fallbackSuffix ?? '_mut');
      el.setAttribute(a, v);
      return 'added ' + a + '="' + v + '"';
    },
  }),
  domOp({
    id: 'DAT.attr.delete',
    category: 'Attribute Mutations',
    intent: 'A meaningful attribute (id, class, name, type, action, method, href, ...) is missing from the element.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:ADM'],
    scope: 'element',
    defaults: {},
    applicable: (el) => deletable(el).length > 0,
    apply: function (el: Element, _p: Record<string, any>, h) {
      const tag = el.tagName.toLowerCase();
      const e: any = el;
      const cands = ['id', 'class', 'name'];
      if (tag === 'button' || tag === 'input') cands.push('type', 'formaction', 'formmethod');
      if (tag === 'form') cands.push('action', 'method');
      if (tag === 'a') cands.push('href');
      const present = cands.filter((a) => {
        if (!el.hasAttribute(a)) return false;
        const v = (el.getAttribute(a) || '').trim().toLowerCase();
        if (a === 'class') return v !== '';
        if (a === 'type') return e.type !== document.createElement(tag === 'input' ? 'input' : 'button').type;
        if (a === 'method') return e.method !== 'get';
        if (a === 'formmethod') return e.formMethod !== (e.form ? e.form.method : 'get');
        if (a === 'formaction') return e.formAction !== (e.form ? e.form.action : location.href);
        return true;
      });
      if (!present.length) return null;
      const a = present[Math.floor(h.rand() * present.length)];
      const old = el.getAttribute(a);
      el.removeAttribute(a);
      return 'removed ' + a + '="' + old + '"';
    },
  }),
  domOp({
    id: 'DAT.attr.modify',
    category: 'Attribute Mutations',
    intent: 'An attribute (id, class, name, type, action, method, href, ...) carries the value of another element of the page.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:AMM'],
    scope: 'element',
    defaults: { fallbackSuffix: '_mut' },
    applicable: (el) => attrCandidates(el.tag).some((a) => a in el.attrs),
    apply: function (el: Element, p: Record<string, any>, h) {
      const tag = el.tagName.toLowerCase();
      const e: any = el;
      const cands = ['id', 'class', 'name'];
      if (tag === 'button' || tag === 'input') cands.push('type', 'formaction', 'formmethod');
      if (tag === 'form') cands.push('action', 'method');
      if (tag === 'a') cands.push('href');
      const present = cands.filter((a) => el.hasAttribute(a));
      if (!present.length) return null;
      const a = present[Math.floor(h.rand() * present.length)];
      const old = el.getAttribute(a) || '';
      const props: Record<string, string> = { type: 'type', method: 'method', formmethod: 'formMethod', action: 'action', formaction: 'formAction', href: 'href' };
      const eff = (v: string): string => {
        if (!props[a]) return a === 'class' ? v.trim().split(/\s+/).sort().join(' ') : v;
        const x: any = document.createElement(tag);
        x.setAttribute(a, v);
        return String(x[props[a]]);
      };
      const cur = eff(old);
      const shared = ['id', 'class', 'name'];
      const sources = shared.includes(a) ? shared : [a];
      const pool: string[] = [];
      const seen: Record<string, boolean> = {};
      document.querySelectorAll(sources.map((s) => '[' + s + ']').join(',')).forEach((o) => {
        if (o === el) return;
        for (const s of sources) {
          const raw = o.getAttribute(s);
          if (raw === null) continue;
          const vals = s === 'class' ? raw.split(/\s+/) : [raw];
          for (const v of vals) {
            if (!v || seen[v] || eff(v) === cur) continue;
            seen[v] = true;
            pool.push(v);
          }
        }
      });
      let v: string;
      if (pool.length) v = pool[Math.floor(h.rand() * pool.length)];
      else if (a === 'type') {
        const opts = tag === 'button' ? ['submit', 'button', 'reset'] : ['text', 'password', 'checkbox', 'number', 'hidden'];
        const alt = opts.filter((o) => eff(o) !== cur);
        v = alt[Math.floor(h.rand() * alt.length)];
      } else if (a === 'method' || a === 'formmethod') v = cur === 'post' ? 'get' : 'post';
      else v = old + String(p.fallbackSuffix ?? '_mut');
      el.setAttribute(a, v);
      return a + ': "' + old + '" → "' + v + '"';
    },
  }),
  domOp({
    id: 'DAT.attr.suffix',
    category: 'Attribute Mutations',
    intent: 'The id, class or title of an element is slightly different (suffixed), as after a refactoring of the fragment.',
    refs: ['Yandrapally22'],
    aliases: ['FragGen:Attribute'],
    scope: 'element',
    defaults: { suffix: 'Mut' },
    applicable: (el) => ['id', 'class', 'title'].some((a) => (el.attrs[a] || '').trim() !== ''),
    apply: function (el: Element, p: Record<string, any>, h) {
      const present = ['id', 'class', 'title'].filter((a) => (el.getAttribute(a) || '').trim() !== '');
      if (!present.length) return null;
      const a = present[Math.floor(h.rand() * present.length)];
      const old = el.getAttribute(a) || '';
      const v = old.replace(/\s+$/, '') + String(p.suffix ?? 'Mut');
      el.setAttribute(a, v);
      return a + ': "' + old + '" → "' + v + '"';
    },
  }),

  /* ================================================== event handlers (DEH) */
  domOp({
    id: 'DEH.click.add',
    category: 'Event Mutations',
    intent: 'A non-interactive element is wired to a click handler that belongs to another element of the page.',
    refs: ['Yandrapally21', 'Oliveira15'],
    aliases: ['MAEWU:EHAM', 'Oliveira15:AAL'],
    scope: 'element',
    defaults: {},
    applicable: (el) => leaf(el) && !clickable(el) && !FORM_CONTROLS.includes(el.tag),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const tag = el.tagName.toLowerCase();
      if (el.childElementCount > 0 || el.hasAttribute('onclick') || ['a', 'button', 'input', 'select', 'textarea', 'option'].includes(tag)) return null;
      let target: HTMLElement | null = null;
      let busy = false;
      el.addEventListener('click', () => {
        if (busy) return;
        if (!target || !target.isConnected) {
          const c: HTMLElement[] = [];
          document.querySelectorAll('[onclick], button, a[href], input[type=button], input[type=submit], input[type=reset], input[type=image]').forEach((o) => {
            if (o !== el && !o.contains(el) && !el.contains(o)) c.push(o as HTMLElement);
          });
          if (!c.length) return;
          target = c[Math.floor(h.rand() * c.length)];
        }
        busy = true;
        try {
          target.click();
        } finally {
          busy = false;
        }
        h.report('click re-dispatched to <' + target.tagName.toLowerCase() + '>' + (target.id ? '#' + target.id : ''));
      });
      return null; // reported when the added handler fires
    },
  }),
  domOp({
    id: 'DEH.click.replace',
    category: 'Event Mutations',
    intent: "A clickable element runs another element's click handler instead of its own.",
    refs: ['Yandrapally21', 'Nishiura13'],
    aliases: ['MAEWU:EHMM', 'Nishiura13:EventCallbackRA'],
    scope: 'element',
    defaults: {},
    applicable: (el) => clickable(el),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const w = window as any;
      const ID = 'DEH.click.replace';
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const c: HTMLElement[] = [];
      document.querySelectorAll('[onclick], button, a[href], input[type=button], input[type=submit], input[type=reset], input[type=image]').forEach((o) => {
        if (o !== el && !o.contains(el) && !el.contains(o) && !o.hasAttribute('data-mlmt-mutated')) c.push(o as HTMLElement);
      });
      if (!c.length) return null;
      const target = c[Math.floor(h.rand() * c.length)];
      const clone = el.cloneNode(true) as HTMLElement;
      clone.removeAttribute('onclick');
      clone.querySelectorAll('[onclick]').forEach((x) => x.removeAttribute('onclick'));
      clone.setAttribute('data-mlmt-mutated', ID);
      let busy = false;
      clone.addEventListener('click', () => {
        if (busy || w['__mlmtBusy_' + ID]) return;
        busy = true;
        w['__mlmtBusy_' + ID] = true;
        try {
          if (target.isConnected) target.click();
        } finally {
          busy = false;
          w['__mlmtBusy_' + ID] = false;
        }
      });
      el.parentNode.replaceChild(clone, el);
      return 'click handler replaced by the one of <' + target.tagName.toLowerCase() + '>' + (target.id ? '#' + target.id : '');
    },
  }),

  /* ========================================================= tree (DTR) */
  domOp({
    id: 'DTR.node.duplicate',
    category: 'Tree Mutations',
    intent: 'An element (with its subtree) is rendered twice, ids included.',
    refs: ['Yandrapally21', 'Oliveira15'],
    aliases: ['MAEWU:TIM', 'Oliveira15:AIW'],
    scope: 'element',
    defaults: {},
    applicable: (el) => structural(el),
    apply: function (el: Element) {
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const clone = el.cloneNode(true) as Element;
      clone.setAttribute('data-mlmt-mutated', 'DTR.node.duplicate');
      el.parentNode.insertBefore(clone, el.nextSibling);
      return 'element duplicated';
    },
  }),
  domOp({
    id: 'DTR.children.delete',
    category: 'Tree Mutations',
    intent: 'The child elements of a container are missing (its own text stays).',
    refs: ['Yandrapally21', 'Yandrapally22'],
    aliases: ['MAEWU:TDM', 'FragGen:Subtree'],
    scope: 'element',
    defaults: {},
    applicable: (el) => el.facts.childElementCount >= 1 && structural(el),
    apply: function (el: Element) {
      const kids = Array.from(el.children);
      if (!kids.length) return null;
      for (const k of kids) k.remove();
      return 'removed ' + kids.length + ' child element(s)';
    },
  }),
  domOp({
    id: 'DTR.node.move',
    category: 'Tree Mutations',
    intent: 'An element is rendered in the wrong container of the page.',
    refs: ['Yandrapally21', 'Oliveira15'],
    aliases: ['MAEWU:TMM', 'Oliveira15:MLWP'],
    scope: 'element',
    defaults: { containers: 'div,span,td,li,section,main,article,aside,nav,header,footer,form,fieldset,p,ul,ol' },
    applicable: (el) => structural(el),
    apply: function (el: Element, p: Record<string, any>, h) {
      const w = window as any;
      const K = '__mlmtOnce_DTR.node.move';
      if (w[K] || !el.parentNode || el === document.body || el === document.documentElement) return null;
      const c: Element[] = [];
      document.body.querySelectorAll(String(p.containers || 'div,span,td,li,section,main')).forEach((o) => {
        if (o !== el.parentNode && !el.contains(o) && !o.hasAttribute('data-mlmt-mutated')) c.push(o);
      });
      if (!c.length) return null;
      const dest = c[Math.floor(h.rand() * c.length)];
      dest.appendChild(el);
      w[K] = true;
      return 'moved under <' + dest.tagName.toLowerCase() + '>' + (dest.id ? '#' + dest.id : '');
    },
  }),

  /* ====================================================== content (DCT) */
  domOp({
    id: 'DCT.text.insert',
    category: 'Content Mutations',
    intent: 'An element that should be empty shows text taken from elsewhere on the page.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:CIM'],
    scope: 'element',
    defaults: { fallback: 'dummy' },
    applicable: (el) => leaf(el) && el.text.trim() === '' && !NO_TEXT_TAGS.includes(el.tag),
    apply: function (el: Element, p: Record<string, any>, h) {
      const skip = ['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'TEXTAREA'];
      if (el.childElementCount > 0 || (el.textContent || '').trim() !== '') return null;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'IMG', 'BR', 'HR', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT'].includes(el.tagName)) return null;
      const pool: string[] = [];
      document.querySelectorAll('body *').forEach((o) => {
        if (o === el || o.childElementCount > 0 || skip.includes(o.tagName)) return;
        const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 80 && !pool.includes(t)) pool.push(t);
      });
      const v = pool.length ? pool[Math.floor(h.rand() * pool.length)] : String(p.fallback ?? 'dummy');
      el.textContent = v;
      return 'inserted text "' + v + '"';
    },
  }),
  domOp({
    id: 'DCT.text.replace',
    category: 'Content Mutations',
    intent: 'An element shows the text of another element of the page.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:CMM'],
    scope: 'element',
    defaults: { fallback: 'dummy' },
    applicable: (el) => leaf(el) && el.text.trim() !== '' && !FORM_CONTROLS.includes(el.tag),
    apply: function (el: Element, p: Record<string, any>, h) {
      const skip = ['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'TEXTAREA'];
      if (el.childElementCount > 0 || ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(el.tagName)) return null;
      const cur = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!cur) return null;
      const pool: string[] = [];
      document.querySelectorAll('body *').forEach((o) => {
        if (o === el || o.childElementCount > 0 || skip.includes(o.tagName)) return;
        const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t !== cur && t.length <= 80 && !pool.includes(t)) pool.push(t);
      });
      let v = pool.length ? pool[Math.floor(h.rand() * pool.length)] : String(p.fallback ?? 'dummy');
      if (v === cur) v = v + '_';
      el.textContent = v;
      return 'text "' + cur.slice(0, 40) + '" → "' + v.slice(0, 40) + '"';
    },
  }),
  domOp({
    id: 'DCT.text.suffix',
    category: 'Content Mutations',
    intent: 'The text of an element is slightly different (suffixed).',
    refs: ['Yandrapally22'],
    aliases: ['FragGen:Text'],
    scope: 'element',
    defaults: { suffix: 'Mut' },
    applicable: (el) => leaf(el) && el.text.trim() !== '' && SUFFIX_TEXT_TAGS.includes(el.tag),
    apply: function (el: Element, p: Record<string, any>) {
      if (el.childElementCount > 0) return null;
      const nodes: Text[] = [];
      el.childNodes.forEach((n) => {
        if (n.nodeType === 3 && (n as Text).data.trim()) nodes.push(n as Text);
      });
      if (!nodes.length) return null;
      const n = nodes[nodes.length - 1];
      const s = String(p.suffix ?? 'Mut');
      n.data = n.data.replace(/(\S)(\s*)$/, (_m, c, ws) => c + s + ws);
      return 'text suffixed with "' + s + '"';
    },
  }),
  domOp({
    id: 'DCT.text.grow',
    category: 'Content Mutations',
    intent: 'An element shows more text than designed (repeated), stressing the layout.',
    refs: ['Walsh20'],
    aliases: ['Walsh:TextualContent(+)'],
    scope: 'element',
    defaults: { copies: 2 },
    applicable: (el) => leaf(el) && el.text.trim() !== '' && !['input', 'select', 'option'].includes(el.tag),
    apply: function (el: Element, p: Record<string, any>) {
      if (el.childElementCount > 0) return null;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      const n = Math.max(2, Number(p.copies ?? 2));
      el.textContent = new Array(n).fill(t).join(' ');
      return 'text repeated ' + n + 'x';
    },
  }),
  domOp({
    id: 'DCT.text.shrink',
    category: 'Content Mutations',
    intent: 'An element shows truncated text.',
    refs: ['Walsh20'],
    aliases: ['Walsh:TextualContent(-)'],
    scope: 'element',
    defaults: { ratio: 0.5 },
    applicable: (el) => leaf(el) && el.text.trim().length >= 2 && !['input', 'select', 'option'].includes(el.tag),
    apply: function (el: Element, p: Record<string, any>) {
      if (el.childElementCount > 0) return null;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) return null;
      const v = t.slice(0, Math.max(1, Math.floor(t.length * Number(p.ratio ?? 0.5))));
      el.textContent = v;
      return 'text "' + t.slice(0, 40) + '" → "' + v.slice(0, 40) + '"';
    },
  }),

  /* ======================================================== style (DST) */
  domOp({
    id: 'DST.color.random',
    category: 'Style Mutations',
    intent: 'An element is rendered in the wrong (random) text colour.',
    refs: ['Yandrapally21', 'Oliveira15'],
    aliases: ['MAEWU:SCM', 'Oliveira15:MWA'],
    scope: 'element',
    defaults: {},
    applicable: (el) => displayed(el),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      const before = getComputedStyle(el).color;
      for (let i = 0; i < 5; i++) {
        let c = '#';
        for (let j = 0; j < 6; j++) c += '0123456789abcdef'[Math.floor(h.rand() * 16)];
        s.setProperty('color', c, 'important');
        if (getComputedStyle(el).color !== before) return 'color ' + before + ' → ' + c;
      }
      return null;
    },
  }),
  domOp({
    id: 'DST.position.random',
    category: 'Style Mutations',
    intent: 'An element is rendered at a wrong (random) absolute position.',
    refs: ['Yandrapally21'],
    aliases: ['MAEWU:SPM'],
    scope: 'element',
    defaults: { maxLeft: 799, maxTop: 599 },
    applicable: (el) => displayed(el),
    apply: function (el: Element, p: Record<string, any>, h) {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      const left = Math.floor(h.rand() * (Number(p.maxLeft ?? 799) + 1));
      const top = Math.floor(h.rand() * (Number(p.maxTop ?? 599) + 1));
      s.setProperty('position', 'absolute', 'important');
      s.setProperty('left', left + 'px', 'important');
      s.setProperty('top', top + 'px', 'important');
      return 'position:absolute; left:' + left + 'px; top:' + top + 'px';
    },
  }),
  domOp({
    id: 'DST.size.random',
    category: 'Style Mutations',
    intent: 'An element is rendered with a wrong (random) size.',
    refs: ['Yandrapally21', 'Oliveira15'],
    aliases: ['MAEWU:SSM', 'Oliveira15:MWS'],
    scope: 'element',
    defaults: { maxWidth: 799, maxHeight: 599 },
    applicable: (el) => displayed(el),
    apply: function (el: Element, p: Record<string, any>, h) {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      const wd = Math.floor(h.rand() * (Number(p.maxWidth ?? 799) + 1));
      const ht = Math.floor(h.rand() * (Number(p.maxHeight ?? 599) + 1));
      s.setProperty('display', 'block', 'important');
      s.setProperty('width', wd + 'px', 'important');
      s.setProperty('height', ht + 'px', 'important');
      return 'display:block; width:' + wd + 'px; height:' + ht + 'px';
    },
  }),

  /* ========================================================== tag (DTG) */
  domOp({
    id: 'DTG.tag.rename',
    category: 'Tag Mutations',
    intent: 'An element is rendered with a similar but different tag (h2 instead of h1, div instead of p, ...).',
    refs: ['Yandrapally22', 'Oliveira15'],
    aliases: ['FragGen:Tag', 'Oliveira15:MWT'],
    scope: 'element',
    defaults: {},
    applicable: (el) => RENAME_TAGS.includes(el.tag),
    apply: function (el: Element) {
      const w = window as any;
      const ID = 'DTG.tag.rename';
      const map: Record<string, string> = { h1: 'h2', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h6', h6: 'h5', p: 'div', div: 'p', span: 'div', b: 'strong', strong: 'b', i: 'em', em: 'i' };
      const tag = el.tagName.toLowerCase();
      if (w['__mlmtOnce_' + ID] || !map[tag] || !el.parentNode) return null;
      const n = document.createElement(map[tag]);
      for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
      while (el.firstChild) n.appendChild(el.firstChild);
      n.setAttribute('data-mlmt-mutated', ID);
      el.parentNode.replaceChild(n, el);
      w['__mlmtOnce_' + ID] = true;
      return '<' + tag + '> → <' + map[tag] + '>';
    },
  }),

  /* ===================================================== webMuJava (W*) */
  domOp({
    id: 'WLR.href.replace',
    category: 'Navigation Mutations',
    intent: 'A link points to another (same-origin) page of the application.',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WLR', 'Praphamontripong17:WLUR'],
    scope: 'element',
    defaults: {},
    applicable: (el) => el.tag === 'a' && el.attrs.href !== undefined && !/^\s*(#|javascript:)/i.test(el.attrs.href),
    apply: function (el: Element) {
      const a = el as HTMLAnchorElement;
      if (a.tagName !== 'A' || !a.hasAttribute('href') || /^\s*(#|javascript:)/i.test(a.getAttribute('href') || '')) return null;
      const count: Record<string, number> = {};
      const order: string[] = [];
      document.querySelectorAll('a[href]').forEach((o) => {
        const raw = o.getAttribute('href') || '';
        if (/^\s*(#|javascript:)/i.test(raw)) return;
        let u: URL;
        try {
          u = new URL((o as HTMLAnchorElement).href);
        } catch {
          return;
        }
        if (u.origin !== location.origin) return;
        if (!(u.href in count)) order.push(u.href);
        count[u.href] = (count[u.href] || 0) + 1;
      });
      const ranked = order.slice().sort((x, y) => count[y] - count[x]);
      const v = ranked.find((u) => u !== a.href);
      if (!v) return null;
      const old = a.getAttribute('href');
      a.setAttribute('href', v);
      return 'href "' + old + '" → "' + v + '"';
    },
  }),
  domOp({
    id: 'WLD.href.empty',
    category: 'Navigation Mutations',
    intent: 'A link has an empty target (it reloads the current page).',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WLD', 'Praphamontripong17:WLUD'],
    scope: 'element',
    defaults: {},
    applicable: (el) => el.tag === 'a' && el.attrs.href !== undefined && el.attrs.href !== '',
    apply: function (el: Element) {
      if (el.tagName !== 'A' || !el.hasAttribute('href') || el.getAttribute('href') === '') return null;
      const old = el.getAttribute('href');
      el.setAttribute('href', '');
      return 'href "' + old + '" → ""';
    },
  }),
  domOp({
    id: 'WFR.action.replace',
    formScoped: true,
    category: 'Form Mutations',
    intent: 'A form submits to another (same-origin) URL of the application.',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WFR', 'Praphamontripong17:WFUR'],
    scope: 'element',
    defaults: {},
    applicable: (el) => inForm(el),
    apply: function (el: Element) {
      const form = (el.tagName === 'FORM' ? el : el.closest('form')) as HTMLFormElement | null;
      if (!form || form.hasAttribute('data-mlmt-wfr')) return null;
      const count: Record<string, number> = {};
      const order: string[] = [];
      const add = (raw: string | null) => {
        if (raw === null || /^\s*(#|javascript:)/i.test(raw)) return;
        let u: URL;
        try {
          u = new URL(raw, document.baseURI);
        } catch {
          return;
        }
        if (u.origin !== location.origin) return;
        if (!(u.href in count)) order.push(u.href);
        count[u.href] = (count[u.href] || 0) + 1;
      };
      document.querySelectorAll('a[href], form[action]').forEach((o) => add(o.getAttribute(o.tagName === 'A' ? 'href' : 'action')));
      const cur = form.action;
      const ranked = order.slice().sort((x, y) => count[y] - count[x]);
      const v = ranked.find((u) => u !== cur);
      if (!v) return null;
      form.setAttribute('action', v);
      // submitters' formaction overrides the form's action: redirect them as well
      form.querySelectorAll('[formaction]').forEach((s) => s.setAttribute('formaction', v));
      form.setAttribute('data-mlmt-wfr', '1');
      return 'form action "' + cur + '" → "' + v + '"';
    },
  }),
  domOp({
    id: 'WTR.method.swap',
    formScoped: true,
    category: 'Form Mutations',
    intent: 'A form is submitted with the wrong HTTP method (GET instead of POST or vice versa).',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WTR', 'Praphamontripong17:WFTR'],
    scope: 'element',
    defaults: {},
    applicable: (el) => inForm(el),
    apply: function (el: Element) {
      const form = (el.tagName === 'FORM' ? el : el.closest('form')) as HTMLFormElement | null;
      if (!form || form.hasAttribute('data-mlmt-wtr')) return null;
      const cur = form.method === 'post' ? 'post' : 'get';
      const v = cur === 'post' ? 'get' : 'post';
      form.setAttribute('method', v);
      let subs = 0;
      form.querySelectorAll('[formmethod]').forEach((s) => {
        const m = (s.getAttribute('formmethod') || '').toLowerCase() === 'post' ? 'get' : 'post';
        s.setAttribute('formmethod', m);
        subs++;
      });
      form.setAttribute('data-mlmt-wtr', '1');
      return 'form method ' + cur.toUpperCase() + ' → ' + v.toUpperCase() + (subs ? ' (+' + subs + ' formmethod)' : '');
    },
  }),
  domOp({
    id: 'WHR.hidden.replace',
    formScoped: true,
    category: 'Form Mutations',
    intent: 'A hidden form field (token, id, state) carries a wrong value.',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WHR', 'Praphamontripong17:WHIR'],
    scope: 'element',
    defaults: { values: ['', ' ', '0', '-1', null] },
    applicable: (el) => (el.facts.formHiddenCount === undefined ? inForm(el) : el.facts.formHiddenCount > 0),
    apply: function (el: Element, p: Record<string, any>, h) {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form) return null;
      const hidden = Array.from(form.querySelectorAll('input[type=hidden]')).filter((x) => !x.hasAttribute('data-mlmt-whr')) as HTMLInputElement[];
      if (!hidden.length) return null;
      const inp = hidden[Math.floor(h.rand() * hidden.length)];
      const values: (string | null)[] = Array.isArray(p.values) ? p.values : ['', ' ', '0', '-1', null];
      const opts = values.filter((v) => (v === null ? '' : String(v)) !== inp.value);
      if (!opts.length) return null;
      const v = opts[Math.floor(h.rand() * opts.length)];
      const old = inp.value;
      if (v === null) {
        inp.removeAttribute('value');
        inp.value = '';
      } else inp.value = String(v);
      inp.setAttribute('data-mlmt-whr', '1');
      return 'hidden ' + (inp.name || inp.id || 'input') + ': "' + old + '" → ' + (v === null ? '(no value)' : '"' + v + '"');
    },
  }),
  domOp({
    id: 'WHD.hidden.delete',
    formScoped: true,
    category: 'Form Mutations',
    intent: 'A hidden form field is missing from the submitted form.',
    refs: ['Praphamontripong10', 'Praphamontripong17'],
    aliases: ['webMuJava:WHD', 'Praphamontripong17:WHID'],
    scope: 'element',
    defaults: {},
    applicable: (el) => (el.facts.formHiddenCount === undefined ? inForm(el) : el.facts.formHiddenCount > 0),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form || form.hasAttribute('data-mlmt-whd')) return null;
      const hidden = Array.from(form.querySelectorAll('input[type=hidden]')) as HTMLInputElement[];
      if (!hidden.length) return null;
      const inp = hidden[Math.floor(h.rand() * hidden.length)];
      inp.remove();
      form.setAttribute('data-mlmt-whd', '1');
      return 'removed hidden input ' + (inp.name || inp.id || '');
    },
  }),
  domOp({
    id: 'WOD.readonly.delete',
    formScoped: true,
    category: 'Form Mutations',
    intent: 'A read-only form field is missing from the form.',
    refs: ['Praphamontripong17'],
    aliases: ['Praphamontripong17:WOID'],
    scope: 'element',
    defaults: {},
    applicable: (el) => (el.facts.formReadonlyCount === undefined ? inForm(el) : el.facts.formReadonlyCount > 0),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form || form.hasAttribute('data-mlmt-wod')) return null;
      const ro = Array.from(form.querySelectorAll('input[readonly], textarea[readonly]'));
      if (!ro.length) return null;
      const inp = ro[Math.floor(h.rand() * ro.length)];
      inp.remove();
      form.setAttribute('data-mlmt-wod', '1');
      return 'removed read-only ' + inp.tagName.toLowerCase() + ' ' + (inp.getAttribute('name') || inp.id || '');
    },
  }),

  /* ===================================================== classes (Walsh) */
  domOp({
    id: 'WCL.class.add',
    category: 'Style Mutations',
    intent: 'An element receives a CSS class used elsewhere on the page (e.g. a layout or visibility utility class).',
    refs: ['Walsh20'],
    aliases: ['Walsh:ClassAddition'],
    scope: 'element',
    defaults: { prefer: '^(d-|col|row|container|hidden|invisible|sr-only|visually-hidden|float-|text-|m[trblxy]?-|p[trblxy]?-|w-|h-|flex|grid|btn|is-|has-|disabled|active|show|fade|collapse|pull-|offset-)' },
    applicable: () => true,
    apply: function (el: Element, p: Record<string, any>, h) {
      const own = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      const pool: string[] = [];
      document.querySelectorAll('[class]').forEach((o) => {
        if (o === el) return;
        for (const c of (o.getAttribute('class') || '').split(/\s+/)) if (c && !own.includes(c) && !pool.includes(c)) pool.push(c);
      });
      if (!pool.length) return null;
      let re: RegExp | null = null;
      try {
        re = p.prefer ? new RegExp(String(p.prefer)) : null;
      } catch {
        re = null;
      }
      const preferred = re ? pool.filter((c) => re!.test(c)) : [];
      const from = preferred.length ? preferred : pool;
      const c = from[Math.floor(h.rand() * from.length)];
      el.classList.add(c);
      return 'class "' + c + '" added';
    },
  }),
  domOp({
    id: 'WCL.class.delete',
    category: 'Style Mutations',
    intent: 'An element misses one of its CSS classes.',
    refs: ['Walsh20'],
    aliases: ['Walsh:ClassDeletion'],
    scope: 'element',
    defaults: {},
    applicable: (el) => (el.attrs.class || '').trim() !== '',
    apply: function (el: Element, _p: Record<string, any>, h) {
      const own = Array.from(el.classList);
      if (!own.length) return null;
      const c = own[Math.floor(h.rand() * own.length)];
      el.classList.remove(c);
      return 'class "' + c + '" removed';
    },
  }),
  domOp({
    id: 'WCL.class.modify',
    category: 'Style Mutations',
    intent: 'One CSS class of an element is replaced by another class used on the page.',
    refs: ['Walsh20'],
    aliases: ['Walsh:ClassModification'],
    scope: 'element',
    defaults: {},
    applicable: (el) => (el.attrs.class || '').trim() !== '',
    apply: function (el: Element, _p: Record<string, any>, h) {
      const own = Array.from(el.classList);
      if (!own.length) return null;
      const pool: string[] = [];
      document.querySelectorAll('[class]').forEach((o) => {
        if (o === el) return;
        for (const c of Array.from(o.classList)) if (!own.includes(c) && !pool.includes(c)) pool.push(c);
      });
      if (!pool.length) return null;
      const old = own[Math.floor(h.rand() * own.length)];
      const c = pool[Math.floor(h.rand() * pool.length)];
      el.classList.replace(old, c);
      return 'class "' + old + '" → "' + c + '"';
    },
  }),

  /* ===================================================== GUI (Oliveira15) */
  domOp({
    id: 'GUI.widget.remove',
    category: 'Widget Mutations',
    intent: 'A widget is missing from the page (removed from the DOM, not merely hidden).',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:REW'],
    scope: 'element',
    defaults: {},
    applicable: (el) => structural(el),
    apply: function (el: Element) {
      const w = window as any;
      const K = '__mlmtOnce_GUI.widget.remove';
      if (w[K] || !el.parentNode || el === document.body || el === document.documentElement) return null;
      el.remove();
      w[K] = true;
      return 'widget removed';
    },
  }),
  domOp({
    id: 'GUI.widget.similar',
    category: 'Widget Mutations',
    intent: 'A similar widget (same kind, slightly different text and id) appears next to the original.',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:ASW'],
    scope: 'element',
    defaults: { textSuffix: 'Mut', idSuffix: '_similar' },
    applicable: (el) => structural(el),
    apply: function (el: Element, p: Record<string, any>) {
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const ts = String(p.textSuffix ?? 'Mut');
      const is = String(p.idSuffix ?? '_similar');
      const clone = el.cloneNode(true) as Element;
      const all = [clone, ...Array.from(clone.querySelectorAll('[id], [name]'))];
      for (const x of all) {
        if (x.hasAttribute('id')) x.setAttribute('id', x.getAttribute('id') + is);
        if (x.hasAttribute('name')) x.setAttribute('name', x.getAttribute('name') + is);
      }
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.trim()) last = n as Text;
      if (last) last.data = last.data.replace(/(\S)(\s*)$/, (_m, c, ws) => c + ts + ws);
      else if (clone.tagName === 'INPUT' && clone.hasAttribute('value')) clone.setAttribute('value', clone.getAttribute('value') + ts);
      clone.setAttribute('data-mlmt-mutated', 'GUI.widget.similar');
      el.parentNode.insertBefore(clone, el.nextSibling);
      return 'similar widget inserted';
    },
  }),
  domOp({
    id: 'GUI.widget.different',
    category: 'Widget Mutations',
    intent: 'An unrelated widget appears before the original one.',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:ADW'],
    scope: 'element',
    defaults: { label: 'New widget' },
    applicable: (el) => structural(el),
    apply: function (el: Element, p: Record<string, any>) {
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(p.label ?? 'New widget');
      b.setAttribute('data-mlmt-mutated', 'GUI.widget.different');
      el.parentNode.insertBefore(b, el);
      return 'unrelated button inserted';
    },
  }),
  domOp({
    id: 'GUI.listener.double',
    category: 'Event Mutations',
    intent: 'A click on a widget is handled twice (e.g. double submission, toggling back).',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:AAL'],
    scope: 'element',
    defaults: {},
    applicable: (el) => clickable(el),
    apply: function (el: Element, _p: Record<string, any>, h) {
      const t = el as HTMLElement;
      if (typeof t.click !== 'function') return null;
      let busy = false;
      t.addEventListener('click', () => {
        if (busy) return;
        // after the original event has been fully dispatched (all listeners, default action)
        setTimeout(() => {
          if (!t.isConnected) return;
          busy = true;
          try {
            t.click();
          } finally {
            busy = false;
          }
          h.report('click delivered twice');
        }, 0);
      });
      return null; // reported when a click is actually duplicated
    },
  }),
  domOp({
    id: 'GUI.widget.swap',
    category: 'Widget Mutations',
    intent: 'A widget swaps position with a neighbouring widget.',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:MLWP'],
    scope: 'element',
    defaults: {},
    applicable: (el) => structural(el),
    apply: function (el: Element) {
      const w = window as any;
      const K = '__mlmtOnce_GUI.widget.swap';
      const parent = el.parentNode;
      if (w[K] || !parent || el === document.body || el === document.documentElement) return null;
      const ok = (x: Element | null) => !!x && !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT'].includes(x.tagName);
      let next = el.nextElementSibling;
      while (next && !ok(next)) next = next.nextElementSibling;
      if (next) {
        parent.insertBefore(next, el);
      } else {
        let prev = el.previousElementSibling;
        while (prev && !ok(prev)) prev = prev.previousElementSibling;
        if (!prev) return null;
        parent.insertBefore(el, prev);
        next = prev;
      }
      w[K] = true;
      return 'swapped with <' + next.tagName.toLowerCase() + '>';
    },
  }),
  domOp({
    id: 'GUI.widget.toEdge',
    category: 'Widget Mutations',
    intent: 'A widget is placed at the edge of the viewport, partially outside it.',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:MLWE'],
    scope: 'element',
    defaults: { visibleFraction: 0.4 },
    applicable: (el) => displayed(el),
    apply: function (el: Element, p: Record<string, any>) {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return null;
      const vis = Math.round(r.width * Number(p.visibleFraction ?? 0.4));
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('top', Math.max(0, Math.round(r.top)) + 'px', 'important');
      s.setProperty('left', 'calc(100vw - ' + vis + 'px)', 'important');
      s.setProperty('width', Math.round(r.width) + 'px', 'important');
      s.setProperty('margin', '0', 'important');
      return 'moved to the right edge (' + vis + 'px of ' + Math.round(r.width) + 'px visible)';
    },
  }),
  domOp({
    id: 'GUI.widget.overlap',
    category: 'Widget Mutations',
    intent: 'A widget is rendered on top of its preceding sibling, covering it.',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:MLWO'],
    scope: 'element',
    defaults: { zIndex: 1000 },
    applicable: (el) => displayed(el),
    apply: function (el: Element, p: Record<string, any>) {
      const s = (el as HTMLElement).style;
      if (!s) return null;
      let prev = el.previousElementSibling;
      while (prev && ['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT'].includes(prev.tagName)) prev = prev.previousElementSibling;
      if (!prev) return null;
      s.setProperty('position', 'absolute', 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('left', '0px', 'important');
      s.setProperty('top', '0px', 'important');
      const pr = prev.getBoundingClientRect();
      const r0 = el.getBoundingClientRect();
      s.setProperty('left', Math.round(pr.left - r0.left) + 'px', 'important');
      s.setProperty('top', Math.round(pr.top - r0.top) + 'px', 'important');
      s.setProperty('z-index', String(p.zIndex ?? 1000), 'important');
      return 'placed over previous <' + prev.tagName.toLowerCase() + '>';
    },
  }),
  domOp({
    id: 'GUI.widget.retype',
    category: 'Widget Mutations',
    intent: 'A widget is rendered as another kind of widget (button as text field, text field as textarea, link as button, ...).',
    refs: ['Oliveira15'],
    aliases: ['Oliveira15:MWT'],
    scope: 'element',
    defaults: {},
    applicable: (el) =>
      ['button', 'select', 'a'].includes(el.tag) ||
      (el.tag === 'input' && (TEXT_LIKE_INPUTS.includes((el.attrs.type || '').toLowerCase()) || ['checkbox', 'radio'].includes((el.attrs.type || '').toLowerCase()))),
    apply: function (el: Element) {
      const w = window as any;
      const ID = 'GUI.widget.retype';
      if (w['__mlmtOnce_' + ID] || !el.parentNode) return null;
      const tag = el.tagName;
      const copy = (to: Element, skip: string[]) => {
        for (const a of Array.from(el.attributes)) if (!skip.includes(a.name)) to.setAttribute(a.name, a.value);
      };
      let n: Element | null = null;
      let what = '';
      if (tag === 'INPUT') {
        const inp = el as HTMLInputElement;
        const t = inp.type;
        if (t === 'checkbox' || t === 'radio') {
          inp.type = t === 'checkbox' ? 'radio' : 'checkbox';
          w['__mlmtOnce_' + ID] = true;
          return t + ' → ' + inp.type;
        }
        if (!['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(t)) return null;
        const ta = document.createElement('textarea');
        copy(ta, ['type', 'value', 'pattern', 'min', 'max', 'step', 'list', 'size']);
        ta.value = inp.value;
        n = ta;
        what = 'input[' + t + '] → textarea';
      } else if (tag === 'BUTTON') {
        const i = document.createElement('input');
        copy(i, ['type', 'value', 'formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate']);
        i.type = 'text';
        i.value = (el.textContent || '').replace(/\s+/g, ' ').trim();
        i.setAttribute('value', i.value);
        n = i;
        what = 'button → input[text]';
      } else if (tag === 'SELECT') {
        const i = document.createElement('input');
        copy(i, ['multiple', 'size']);
        i.type = 'text';
        i.value = (el as HTMLSelectElement).value;
        i.setAttribute('value', i.value);
        n = i;
        what = 'select → input[text]';
      } else if (tag === 'A') {
        const b = document.createElement('button');
        copy(b, ['href', 'target', 'rel', 'download', 'hreflang', 'ping', 'referrerpolicy']);
        b.type = 'button';
        while (el.firstChild) b.appendChild(el.firstChild);
        n = b;
        what = 'a → button';
      }
      if (!n) return null;
      n.setAttribute('data-mlmt-mutated', ID);
      el.parentNode.replaceChild(n, el);
      w['__mlmtOnce_' + ID] = true;
      return what;
    },
  }),
];
