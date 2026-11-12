/**
 * Browser-side implementation of the 32 DOM-layer operators (thesis Sec. 4.2.1).
 *
 * IMPORTANT: this function is serialised with `Function.prototype.toString()` and
 * injected with `context.addInitScript()`. It must be fully self-contained: no
 * imports, no references to module-level symbols.
 */
export interface DomMutationSpec {
  operator: string;
  pageKey: string;
  pageKeyQuery: 'all' | 'none' | string[];
  /** see util/pageKey.ts KeyNormalizer */
  pageKeyNormalize?: Array<[string, string]>;
  selector?: string;
  resourceUrl?: string;
  params: Record<string, any>;
  seed: number;
  /** element (default) or page */
  scope?: 'element' | 'page';
  /** name of the exposed binding that receives application reports */
  bindingName?: string;
}

/** Signature of a custom (plugin) DOM operator, see operators/registry.ts. */
export type CustomDomApply = (el: Element, params: Record<string, any>, helpers: { rand: () => number }) => string | null;

export function mlmtDomMutator(spec: DomMutationSpec, custom?: CustomDomApply | null): void {
  const w = window as any;
  const installKey = [spec.operator, spec.selector || '', spec.resourceUrl || '', spec.bindingName || ''].join('|');
  w.__mlmtMutators = w.__mlmtMutators || {};
  if (w.__mlmtMutators[installKey]) return;
  w.__mlmtMutators[installKey] = true;

  const MARK = 'data-mlmt-mutated';
  const P = spec.params || {};

  // ---------------------------------------------------------------- helpers
  function pageKeyOf(href: string, mode: 'all' | 'none' | string[]): string {
    const u = new URL(href);
    let entries = Array.from(u.searchParams.entries());
    if (mode === 'none') entries = [];
    else if (Array.isArray(mode)) entries = entries.filter(([k]) => mode.includes(k));
    entries.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
    const q = entries.length ? '?' + entries.map(([k, v]) => k + '=' + v).join('&') : '';
    let key = u.origin + u.pathname + q;
    for (const [p, r] of spec.pageKeyNormalize || []) key = key.replace(new RegExp(p, 'g'), r);
    return key;
  }

  if (window.top !== window) return; // only the main frame
  if (spec.pageKey !== '*' && pageKeyOf(location.href, spec.pageKeyQuery) !== spec.pageKey) return;

  let seed = spec.seed >>> 0 || 1;
  function rand(): number {
    // mulberry32
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randInt(min: number, max: number): number {
    return Math.floor(min + rand() * (max - min + 1));
  }

  let applications = 0;
  function report(detail: string): void {
    applications++;
    try {
      const fn = w[spec.bindingName || '__mlmtApplied'];
      if (typeof fn === 'function') fn({ operator: spec.operator, detail, applications });
    } catch {
      /* ignore */
    }
  }

  function textNodesOf(el: Element): Text[] {
    const out: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return (n.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) out.push(n as Text);
    return out;
  }

  function injectCss(css: string): void {
    const id = '__mlmt_style';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  const FORM_CONTROL = ['INPUT', 'SELECT', 'TEXTAREA'];
  const VOID = ['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR', 'TEXTAREA', 'SELECT'];
  const SEMANTIC_TYPES = ['email', 'number', 'tel', 'url', 'date', 'datetime-local', 'month', 'week', 'time', 'search', 'password', 'range', 'color'];
  function isFormControl(el: Element): boolean {
    return FORM_CONTROL.includes(el.tagName) && (el as HTMLInputElement).type !== 'hidden';
  }
  function implicitRole(el: Element): string | null {
    const tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'IMG') return 'img';
    if (tag === 'LI') return 'listitem';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      if (['text', 'email', 'tel', 'url', ''].includes(t)) return 'textbox';
    }
    return null;
  }
  function labelsFor(el: Element): HTMLLabelElement[] {
    if (el.tagName === 'LABEL') return [el as HTMLLabelElement];
    const id = el.getAttribute('id');
    if (!id) return [];
    return Array.from(document.querySelectorAll('label[for]')).filter(
      (l) => l.getAttribute('for') === id,
    ) as HTMLLabelElement[];
  }
  function suffixUrl(url: string, suffix: string, fallbackExt: string): string {
    // logo.png -> logo_404.png ; app.js -> app.404.js
    const m = url.match(/^([^?#]*?)(\.[a-zA-Z0-9]+)?([?#].*)?$/);
    if (!m) return url + suffix;
    const base = m[1];
    const ext = m[2] || '';
    const rest = m[3] || '';
    if (suffix.startsWith('.') && suffix.endsWith(fallbackExt)) return base + suffix + rest; // app.404.js
    return base + suffix + ext + rest;
  }
  function shuffleWords(s: string): string {
    const lead = s.match(/^\s*/)![0];
    const trail = s.match(/\s*$/)![0];
    const words = s.trim().split(/\s+/);
    if (words.length < 2) return s;
    const orig = words.join(' ');
    for (let attempt = 0; attempt < 5; attempt++) {
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
      }
      if (words.join(' ') !== orig) break;
    }
    if (words.join(' ') === orig) words.push(words.shift()!); // rotate
    return lead + words.join(' ') + trail;
  }
  function leet(s: string, p: number): string {
    const map: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', l: '1', A: '4', E: '3', I: '1', O: '0', S: '5', T: '7' };
    let out = '';
    let changed = false;
    for (const ch of s) {
      if (map[ch] && rand() < p) {
        out += map[ch];
        changed = true;
      } else out += ch;
    }
    if (!changed) {
      for (let i = 0; i < s.length; i++) {
        if (map[s[i]]) return s.slice(0, i) + map[s[i]] + s.slice(i + 1);
      }
    }
    return out;
  }

  // ------------------------------------------------- element-level operators
  /** Returns a description if the mutation was applied, null if not applicable. */
  type Apply = (el: Element) => string | null;
  const elementOps: Record<string, Apply> = {
    'AAM.required.add': (el) => {
      if (!isFormControl(el) || el.hasAttribute('required')) return null;
      el.setAttribute('required', '');
      return 'added required';
    },
    'AAM.placeholder.remove': (el) => {
      if (!el.hasAttribute('placeholder')) return null;
      el.removeAttribute('placeholder');
      return 'removed placeholder';
    },
    'AAM.inputType.swap': (el) => {
      if (el.tagName !== 'INPUT') return null;
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      const to = String(P.toType || 'text');
      if (!SEMANTIC_TYPES.includes(t) || t === to) return null;
      el.setAttribute('type', to);
      return `type=${t} -> ${to}`;
    },
    'AAM.ariaLabel.remove': (el) => {
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) return null;
      el.removeAttribute('aria-label');
      el.removeAttribute('aria-labelledby');
      return 'removed aria-label/aria-labelledby';
    },
    'AMM.href.null': (el) => {
      const a = el.closest('a[href]') || el.querySelector('a[href]');
      if (!a) return null;
      const rep = String(P.replacement ?? '#');
      if (a.getAttribute('href') === rep) return null;
      a.setAttribute('href', rep);
      return `href -> ${rep}`;
    },
    'CDM.text.delete': (el) => {
      if (isFormControl(el)) return null;
      const nodes = textNodesOf(el);
      if (!nodes.length) return null;
      nodes.forEach((n) => (n.nodeValue = ''));
      if (el.tagName === 'INPUT') (el as HTMLInputElement).value = '';
      return `cleared ${nodes.length} text node(s)`;
    },
    'CDM.text.shuffle': (el) => {
      if (isFormControl(el)) return null;
      const nodes = textNodesOf(el).filter((n) => (n.nodeValue || '').trim().split(/\s+/).length >= 2);
      if (!nodes.length) return null;
      nodes.forEach((n) => (n.nodeValue = shuffleWords(n.nodeValue || '')));
      return 'shuffled words';
    },
    'CDM.text.leet': (el) => {
      if (isFormControl(el)) return null;
      const nodes = textNodesOf(el).filter((n) => /[aeiostlAEIOST]/.test(n.nodeValue || ''));
      if (!nodes.length) return null;
      const p = Number(P.probability ?? 0.18);
      nodes.forEach((n) => (n.nodeValue = leet(n.nodeValue || '', p)));
      return 'leetspeak substitutions';
    },
    'CDM.input.prependWhitespace': (el) => {
      const isText =
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && ['text', 'email', 'search', 'tel', 'url', 'password', ''].includes((el as HTMLInputElement).type));
      if (!isText) return null;
      const input = el as HTMLInputElement;
      const pad = ' '.repeat(Math.max(1, Number(P.padding ?? 1)));
      const padValue = () => {
        const v = input.value;
        if (v && !(v.startsWith(pad) && v.endsWith(pad))) input.value = pad + v + pad;
      };
      input.addEventListener('change', padValue, true);
      input.addEventListener('blur', padValue, true);
      const form = input.form;
      if (form) form.addEventListener('submit', padValue, true);
      // apps that read the value on click (fetch-based forms)
      document.addEventListener('click', padValue, true);
      document.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') padValue(); }, true);
      padValue();
      return 'pads input value with whitespace';
    },
    'EHDM.click.remove': (el) => {
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const clone = el.cloneNode(true) as Element;
      clone.removeAttribute('onclick');
      clone.querySelectorAll('[onclick]').forEach((c) => c.removeAttribute('onclick'));
      clone.setAttribute(MARK, spec.operator);
      el.parentNode.replaceChild(clone, el);
      return 'replaced node with listener-free clone';
    },
    'EVD.click.stopPropagation': (el) => {
      // Non-capturing listener: the target's own handlers still run, but the
      // event no longer bubbles to ancestors (delegated handlers). A capturing
      // listener would also suppress the target's bubble-phase listeners.
      el.addEventListener('click', (e) => e.stopPropagation(), false);
      return 'click propagation stopped at target';
    },
    'EVD.click.delay': (el) => {
      const replayed = new WeakSet<Event>();
      const min = Number(P.minMs ?? 300);
      const max = Number(P.maxMs ?? 800);
      window.addEventListener(
        'click',
        (e) => {
          if (replayed.has(e)) return;
          const t = e.target as Node | null;
          if (!t || !(el === t || el.contains(t))) return;
          e.stopImmediatePropagation();
          e.preventDefault();
          const me = e as MouseEvent;
          const delay = randInt(min, max);
          setTimeout(() => {
            const ev = new MouseEvent('click', {
              bubbles: true, cancelable: true, composed: true, clientX: me.clientX, clientY: me.clientY,
              button: me.button, buttons: me.buttons, ctrlKey: me.ctrlKey, shiftKey: me.shiftKey,
              altKey: me.altKey, metaKey: me.metaKey, detail: me.detail, view: window,
            });
            replayed.add(ev);
            (t as Element).dispatchEvent(ev);
          }, delay);
        },
        true,
      );
      return 'click handling delayed';
    },
    'EVD.submit.delay': (el) => {
      const form = (el.tagName === 'FORM' ? el : el.closest('form') || el.querySelector('form')) as HTMLFormElement | null;
      if (!form || (form as any).__mlmtSubmitDelay) return null;
      (form as any).__mlmtSubmitDelay = true;
      let bypass = false;
      const min = Number(P.minMs ?? 300);
      const max = Number(P.maxMs ?? 800);
      form.addEventListener(
        'submit',
        (e) => {
          if (bypass) {
            bypass = false;
            return;
          }
          e.preventDefault();
          e.stopImmediatePropagation();
          const submitter = (e as SubmitEvent).submitter as HTMLElement | null;
          setTimeout(() => {
            bypass = true;
            try {
              if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter && (submitter as any).form === form ? (submitter as any) : undefined);
              else form.submit();
            } catch {
              form.submit();
            }
          }, randInt(min, max));
        },
        true,
      );
      return 'form submission delayed';
    },
    'TIM.insert.ghostDiv': (el) => {
      if (VOID.includes(el.tagName)) return null;
      const ghost = document.createElement('div');
      ghost.setAttribute(MARK, spec.operator);
      ghost.setAttribute('aria-hidden', 'true');
      ghost.className = 'mlmt-ghost';
      ghost.style.cssText = 'width:1px;height:1px;opacity:0.01;overflow:hidden;';
      el.insertBefore(ghost, el.firstChild);
      return 'inserted ghost <div> as first child';
    },
    'TIM.wrap.div': (el) => {
      if (!el.parentNode || el === document.body || el === document.documentElement) return null;
      const parent = el.parentElement;
      if (parent && parent.hasAttribute(MARK)) return null;
      const wrapper = document.createElement('div');
      wrapper.setAttribute(MARK, spec.operator);
      wrapper.className = 'mlmt-wrapper';
      el.parentNode.insertBefore(wrapper, el);
      wrapper.appendChild(el);
      return 'wrapped in <div>';
    },
    'TIM.form.reorderFields': (el) => {
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (!form) return null;
      const controls = Array.from(form.querySelectorAll('input, select, textarea')).filter(
        (c) => (c as HTMLInputElement).type !== 'hidden' && (c as HTMLInputElement).type !== 'submit',
      );
      if (controls.length < 2) return null;
      const [a, b] = controls;
      const marker = document.createComment('mlmt');
      b.parentNode!.insertBefore(marker, b);
      a.parentNode!.insertBefore(b, a);
      marker.parentNode!.replaceChild(a, marker);
      return 'swapped first two form controls';
    },
    'FVM.required.toggle': (el) => {
      if (!isFormControl(el)) return null;
      if (el.hasAttribute('required')) {
        el.removeAttribute('required');
        return 'required removed';
      }
      el.setAttribute('required', '');
      return 'required added';
    },
    'PVM.pattern.break': (el) => {
      const pat = el.getAttribute('pattern');
      if (pat === null) return null;
      const strategy = String(P.strategy || 'auto');
      let next = pat;
      if (strategy !== 'impossible') {
        next = pat.replace(/\{(\d+)(,(\d*))?\}/, (_m, n, comma, m2) => {
          const lo = Math.max(0, Number(n) - 1);
          if (!comma) return `{${lo}}`;
          return m2 ? `{${lo},${Math.max(lo, Number(m2) - 1)}}` : `{${lo},}`;
        });
        if (next === pat) next = pat.replace(/\+/, '*');
      }
      if (next === pat || strategy === 'impossible') next = '(?!)';
      el.setAttribute('pattern', next);
      return `pattern ${pat} -> ${next}`;
    },
    'FVM.minmax.remove': (el) => {
      const attrs = ['min', 'max', 'minlength', 'maxlength'].filter((a) => el.hasAttribute(a));
      if (!attrs.length) return null;
      attrs.forEach((a) => el.removeAttribute(a));
      return `removed ${attrs.join(',')}`;
    },
    'ATD.alt.delete': (el) => {
      const imgs = (el.tagName === 'IMG' ? [el] : Array.from(el.querySelectorAll('img'))).filter((i) => i.hasAttribute('alt'));
      if (!imgs.length) return null;
      imgs.forEach((i) => i.removeAttribute('alt'));
      return `removed alt from ${imgs.length} image(s)`;
    },
    'ARM.role.modify': (el) => {
      const mapping = (P.mapping || {}) as Record<string, string>;
      const role = el.getAttribute('role') || implicitRole(el);
      if (!role || !mapping[role]) return null;
      el.setAttribute('role', mapping[role]);
      return `role ${role} -> ${mapping[role]}`;
    },
    'LUM.label.unlink': (el) => {
      const labels = labelsFor(el);
      if (!labels.length) return null;
      const suffix = String(P.suffix ?? '__broken');
      labels.forEach((l) => l.setAttribute('for', (l.getAttribute('for') || '') + suffix));
      return 'label[for] unlinked';
    },
    'ARM.describedby.remove': (el) => {
      if (!el.hasAttribute('aria-describedby')) return null;
      el.removeAttribute('aria-describedby');
      return 'removed aria-describedby';
    },
    'BSM.img.break': (el) => {
      const imgs = (el.tagName === 'IMG' ? [el] : Array.from(el.querySelectorAll('img[src]'))).filter((i) => i.getAttribute('src'));
      if (!imgs.length) return null;
      const suffix = String(P.suffix ?? '_404');
      imgs.forEach((i) => i.setAttribute('src', suffixUrl(i.getAttribute('src')!, suffix, '')));
      return `broke ${imgs.length} image src`;
    },
    'RLB.router.break': (el) => {
      const ROUTE_ATTRS = ['routerlink', 'ng-reflect-router-link', 'to', 'data-route', 'data-href'];
      const node = [el, el.closest('a'), ...Array.from(el.querySelectorAll('a'))].find(
        (n) => n && ROUTE_ATTRS.some((a) => n.hasAttribute(a)),
      ) as Element | undefined;
      if (!node) return null;
      const broken = String(P.brokenRoute ?? '/404-not-found');
      ROUTE_ATTRS.forEach((a) => node.hasAttribute(a) && node.setAttribute(a, broken));
      if (node.hasAttribute('href')) node.setAttribute('href', broken);
      return `route -> ${broken}`;
    },
  };

  // ------------------------------------------------------ CSS-based operators
  const cssOps: Record<string, (sel: string) => string> = {
    'SVM.visibility.hide': (s) => `${s}{visibility:hidden !important;}`,
    'SVM.display.none': (s) => `${s}{display:none !important;}`,
    'SVM.opacity.dim': (s) => `${s}{opacity:${Number(P.opacity ?? 0.2)} !important;}`,
    'SVM.force.scroll': (s) => `${s}{max-height:${Number(P.maxHeightPx ?? 240)}px !important;overflow:auto !important;}`,
  };

  // --------------------------------------------------------- page operators
  let customPageDone = false;
  function applyPageOp(): void {
    if (custom && spec.scope === 'page') {
      if (customPageDone) return;
      const d = custom(document.documentElement, P, { rand });
      if (d) {
        customPageDone = true;
        report(d);
      }
      return;
    }
    if (spec.operator === 'TIM.node.removeSafe') {
      const sels: string[] = Array.isArray(P.selectors) ? P.selectors : ['footer', 'aside'];
      let removed = 0;
      for (const s of sels) {
        document.querySelectorAll(s).forEach((n) => {
          if (n.isConnected && n !== document.body) {
            n.remove();
            removed++;
          }
        });
      }
      if (removed) report(`removed ${removed} safe node(s)`);
      return;
    }
    if (spec.operator === 'SFM.script.fail' || spec.operator === 'SFM.stylesheet.fail') {
      const isScript = spec.operator === 'SFM.script.fail';
      const suffix = String(P.suffix ?? (isScript ? '.404.js' : '.404.css'));
      const nodes = isScript
        ? Array.from(document.querySelectorAll('script[src]'))
        : Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'));
      const attr = isScript ? 'src' : 'href';
      for (const n of nodes) {
        if (n.hasAttribute(MARK)) continue;
        const abs = (n as any)[attr] as string;
        if (spec.resourceUrl && abs !== spec.resourceUrl) continue;
        n.setAttribute(attr, suffixUrl(n.getAttribute(attr)!, suffix, isScript ? '.js' : '.css'));
        n.setAttribute(MARK, spec.operator);
        report(`${attr} invalidated: ${abs}`);
      }
    }
  }

  // ------------------------------------------------------------- scheduler
  const doneEls = new WeakSet<Element>();
  /**
   * While the document is still being parsed, an element is complete once a
   * node follows it (or one of its ancestors): the parser appends in document
   * order. Tests can act on elements before DOMContentLoaded, so mutations
   * must be in place by then, but never on half-parsed elements.
   */
  function parsed(el: Element): boolean {
    if (document.readyState !== 'loading') return true;
    for (let n: Node | null = el; n && n !== document.documentElement; n = n.parentNode) {
      if (n.nextSibling) return true;
    }
    return false;
  }
  function applyNow(): void {
    try {
      if (cssOps[spec.operator]) {
        if (!spec.selector) return;
        const matches = document.querySelectorAll(spec.selector);
        if (!matches.length) return;
        injectCss(cssOps[spec.operator](spec.selector));
        let fresh = 0;
        matches.forEach((m) => {
          if (!doneEls.has(m)) {
            doneEls.add(m);
            fresh++;
          }
        });
        if (fresh) report(`css rule injected for ${fresh} element(s)`);
        return;
      }
      const fn: Apply | undefined =
        elementOps[spec.operator] || (custom && spec.scope !== 'page' ? (el: Element) => custom(el, P, { rand }) : undefined);
      if (fn) {
        if (!spec.selector) return;
        document.querySelectorAll(spec.selector).forEach((el) => {
          if (doneEls.has(el) || el.hasAttribute(MARK) || !parsed(el)) return;
          doneEls.add(el);
          const d = fn(el);
          if (d) {
            if (el.isConnected) el.setAttribute(MARK, spec.operator);
            report(d);
          }
        });
        return;
      }
      // page-level operators restructure the document: wait until it is parsed
      if (document.readyState !== 'loading') applyPageOp();
    } catch (e) {
      // never break the page because of the mutator itself
    }
  }

  let scheduled = false;
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      applyNow();
    }, 0);
  }

  function start(): void {
    applyNow();
    // During parsing apply synchronously (observer callbacks run as microtasks,
    // before the test can act on newly parsed elements); afterwards batch.
    const obs = new MutationObserver(() => (document.readyState === 'loading' ? applyNow() : schedule()));
    obs.observe(document, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyNow, { once: true });
  }

  if (spec.operator === 'SFM.script.fail' || spec.operator === 'SFM.stylesheet.fail') {
    // must run as early as possible, before the parser fetches resources
    const obs = new MutationObserver(() => applyPageOp());
    obs.observe(document, { childList: true, subtree: true });
  }
  start();
}
