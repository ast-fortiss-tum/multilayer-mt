/**
 * Browser-side trace recorder (thesis Sec. 4.5 step 1 and Fig. 4.2).
 *
 * Records the interactions performed by the test (click, fill/type, focus,
 * hover) and periodic snapshots of the page elements with the facts needed to
 * compute the PWE visibility and semantic scores.
 *
 * Serialised with `toString()`: must be self-contained.
 */
export interface RecorderSpec {
  pageKeyQuery: 'all' | 'none' | string[];
  maxElements: number;
}

export function mlmtRecorder(spec: RecorderSpec): void {
  const w = window as any;
  if (w.__mlmtRecorderInstalled || window.top !== window) return;
  w.__mlmtRecorderInstalled = true;

  function pageKeyOf(href: string, mode: 'all' | 'none' | string[]): string {
    const u = new URL(href);
    let entries = Array.from(u.searchParams.entries());
    if (mode === 'none') entries = [];
    else if (Array.isArray(mode)) entries = entries.filter(([k]) => mode.includes(k));
    entries.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
    const q = entries.length ? '?' + entries.map(([k, v]) => k + '=' + v).join('&') : '';
    return u.origin + u.pathname + q;
  }
  const pageKey = () => pageKeyOf(location.href, spec.pageKeyQuery);

  function send(kind: string, payload: unknown): void {
    try {
      const fn = w.__mlmtRecord;
      if (typeof fn === 'function') fn({ kind, payload });
    } catch {
      /* ignore */
    }
  }

  const esc = (s: string) => ((window as any).CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  function unique(sel: string): boolean {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }
  /** Stable, unique CSS selector for an element. */
  function selectorOf(el: Element): string {
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) {
        const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const t = cur.tagName.toLowerCase();
      if (cur !== el && cur.id && unique('#' + esc(cur.id))) {
        parts.unshift('#' + esc(cur.id));
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        parts.unshift(t);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(cur) + 1})` : t);
      const candidate = parts.join(' > ');
      if (parent === document.body) {
        parts.unshift('body');
        break;
      }
      if (unique(candidate) && parts.length >= 2) break;
      cur = parent;
    }
    return parts.join(' > ');
  }

  const ATTRS = [
    'id', 'name', 'type', 'role', 'placeholder', 'aria-label', 'aria-labelledby', 'aria-describedby', 'href',
    'src', 'alt', 'required', 'pattern', 'min', 'max', 'minlength', 'maxlength', 'for', 'routerlink',
    'ng-reflect-router-link', 'to', 'data-route', 'data-href', 'class', 'onclick', 'value',
  ];
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

  function describe(el: Element): any {
    const attrs: Record<string, string> = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = v.slice(0, 200);
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const form = el.tagName === 'FORM' ? el : el.closest('form');
    const id = el.getAttribute('id');
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      attrs,
      text: text.slice(0, 120),
      visibility: {
        inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0 && r.height > 0,
        displayed: cs.display !== 'none',
        opaque: parseFloat(cs.opacity || '1') > 0.1,
        nonZeroSize: r.width > 0 && r.height > 0,
      },
      facts: {
        textNodeWords: text ? text.split(' ').length : 0,
        childElementCount: el.childElementCount,
        inForm: !!form,
        formSelector: form ? selectorOf(form) : null,
        formControlCount: form
          ? form.querySelectorAll('input:not([type=hidden]):not([type=submit]), select, textarea').length
          : 0,
        hasImgDescendant: el.tagName === 'IMG' || !!el.querySelector('img'),
        hasImgWithAlt: (el.tagName === 'IMG' && el.hasAttribute('alt')) || !!el.querySelector('img[alt]'),
        associatedLabel:
          el.tagName === 'LABEL' ||
          (!!id && Array.from(document.querySelectorAll('label[for]')).some((l) => l.getAttribute('for') === id)),
        implicitRole: implicitRole(el),
      },
    };
  }

  const SKIP = new Set(['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'BR', 'TITLE', 'BASE']);
  function snapshot(): void {
    if (!document.body) return;
    const out: any[] = [];
    const all = document.body.querySelectorAll('*');
    for (let i = 0; i < all.length && out.length < spec.maxElements; i++) {
      const el = all[i];
      if (SKIP.has(el.tagName)) continue;
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') continue;
      if (el.hasAttribute('data-mlmt-mutated')) continue;
      try {
        out.push(describe(el));
      } catch {
        /* ignore */
      }
    }
    send('snapshot', { pageKey: pageKey(), elements: out });
    // record linked resources (for SFM.* operators)
    const resources: any[] = [];
    document.querySelectorAll('script[src]').forEach((s) => resources.push({ kind: 'script', url: (s as HTMLScriptElement).src }));
    document
      .querySelectorAll('link[rel~="stylesheet"][href]')
      .forEach((l) => resources.push({ kind: 'stylesheet', url: (l as HTMLLinkElement).href }));
    if (resources.length) send('resources', { pageKey: pageKey(), resources });
  }

  let snapTimer: any = null;
  function scheduleSnapshot(delay = 150): void {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapTimer = null;
      snapshot();
    }, delay);
  }

  function interaction(kind: string, target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    // attribute interaction to the nearest semantically interactive ancestor
    const el =
      target.closest('button, a, input, select, textarea, label, [role=button], [role=link], [onclick]') || target;
    let d: any;
    try {
      d = describe(el);
    } catch {
      return;
    }
    send('interaction', { kind, pageKey: pageKey(), selector: d.selector, element: d });
    scheduleSnapshot();
  }

  // A fill/type produces a burst of input events: count one "fill" per burst.
  const lastInput = new WeakMap<Element, number>();
  // A click also produces mouseover/focus: suppress the implied hover/focus.
  let lastClickAt = 0;
  document.addEventListener('click', (e) => { lastClickAt = Date.now(); interaction('click', e.target); }, true);
  document.addEventListener('mousedown', () => { lastClickAt = Date.now(); }, true);
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target as Element;
      const now = Date.now();
      const prev = lastInput.get(t) || 0;
      lastInput.set(t, now);
      if (now - prev > 500) interaction('fill', t);
    },
    true,
  );
  document.addEventListener('change', (e) => {
    const t = e.target as Element;
    if (t && t.tagName === 'SELECT') interaction('fill', t);
  }, true);
  document.addEventListener('focusin', (e) => {
    if (Date.now() - lastClickAt > 300) interaction('focus', e.target);
  }, true);
  let hoverTimer: any = null;
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (hoverTimer) clearTimeout(hoverTimer);
    // a hover is a mouseover that is not followed by a click within 300ms
    hoverTimer = setTimeout(() => {
      if (Date.now() - lastClickAt > 300) interaction('hover', t);
    }, 300);
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scheduleSnapshot(0), { once: true });
  else scheduleSnapshot(0);
  window.addEventListener('load', () => scheduleSnapshot(100));
  // dynamic pages: re-snapshot after DOM changes (debounced)
  const start = () => {
    const obs = new MutationObserver(() => scheduleSnapshot(400));
    obs.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) start();
}
