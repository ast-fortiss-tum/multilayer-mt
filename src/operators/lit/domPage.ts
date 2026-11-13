/**
 * Page-scope literature operators (Batch C): browser-API patches installed at
 * document start (Mutandis, AjaxMutator, JSPreventer, MUTEC), history and
 * navigation faults (webMuJava FOB/FOR), CSSOM rule mutation (Walsh20),
 * page-level accessibility faults (Ma11y), and environment operators applied
 * from the test-runner process (viewport, CDP CPU/network throttling, script
 * delay through routing).
 *
 * Browser-side `apply` functions are serialised with toString(). Shared
 * browser helpers (the `mlmt*` function declarations below) are composed into
 * each `apply` by `browser()`, which builds one self-contained function whose
 * source contains the helper declarations followed by the operator body.
 *
 * "nth" parameters select deterministically: the nth distinct key (URL, id,
 * selector, attribute name) or the nth eligible call seen in the page.
 */
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { DomApplyHelpers, DomNodeContext, OperatorDef } from '../registry';
import type { ElementInfo } from '../../types';
import { domOp } from './util';

type Params = Record<string, any>;
type Main = (el: Element, params: Params, h: DomApplyHelpers) => string | null;

/** Compose browser helpers and an operator body into one self-contained function. */
function browser(main: Main, ...libs: Function[]): Main {
  const src = libs.map((f) => f.toString()).join('\n') + '\nreturn (' + main.toString() + ')(el, params, helpers);';
  return new Function('el', 'params', 'helpers', src) as Main;
}

/* ===================================================== browser-side helpers */
/* Not exported (exports compile to `exports.x` references). Self-contained.  */

/** Rate-limited reporter (the runtime keeps at most 200 details anyway). */
function mlmtRep(h: DomApplyHelpers, max?: number): (d: string) => void {
  let n = 0;
  const cap = max || 20;
  return (d: string) => {
    if (n++ < cap) h.report(d);
  };
}

/** nth selection: nth distinct key, or nth eligible call. */
function mlmtNth(params: Record<string, any>): { n: number; distinct: (key: unknown) => boolean; call: () => boolean } {
  const n = Math.max(1, Math.floor(Number(params.nth ?? 1)) || 1);
  const seen = new Map<unknown, number>();
  let calls = 0;
  return {
    n,
    distinct: (key: unknown) => {
      if (!seen.has(key)) seen.set(key, seen.size + 1);
      return seen.get(key) === n;
    },
    call: () => ++calls === n,
  };
}

function mlmtShort(v: unknown): string {
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function mlmtDesc(t: any): string {
  if (t === window) return 'window';
  if (t === document) return 'document';
  if (t && t.nodeType === 1) return '<' + String(t.tagName).toLowerCase() + (t.id ? '#' + t.id : '') + '>';
  return t && t.constructor ? String(t.constructor.name) : String(t);
}

/** Becomes true at DOMContentLoaded. */
function mlmtAfterDcl(): () => boolean {
  let loaded = document.readyState !== 'loading';
  if (!loaded) document.addEventListener('DOMContentLoaded', () => (loaded = true), { once: true });
  return () => loaded;
}

/**
 * Call `cb(jQuery)` when jQuery is assigned to window.jQuery / window.$ (or is
 * already there). `cb` may return a replacement (e.g. a Proxy) exposed instead.
 */
function mlmtOnJQuery(cb: (jq: any) => any): void {
  const w = window as any;
  const done = new WeakMap<object, any>();
  const wrap = (v: any) => {
    if (typeof v !== 'function' || !v.fn || !v.fn.jquery) return v;
    if (!done.has(v)) {
      let r: any;
      try {
        r = cb(v);
      } catch {
        r = undefined;
      }
      done.set(v, r || v);
      if (r && r !== v) done.set(r, r);
    }
    return done.get(v);
  };
  for (const name of ['jQuery', '$']) {
    let val = wrap(w[name]);
    try {
      Object.defineProperty(w, name, {
        configurable: true,
        enumerable: true,
        get: () => val,
        set: (v) => {
          val = wrap(v);
        },
      });
    } catch {
      try {
        w[name] = val;
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Hook XHR open and fetch: `hook(method, absUrl)` may return a new method
 * and/or URL (or null to leave the request alone).
 */
function mlmtHookRequests(hook: (method: string, url: string, api: string) => { method?: string; url?: string } | null): void {
  const XP = XMLHttpRequest.prototype;
  const open = XP.open;
  XP.open = function (this: XMLHttpRequest) {
    const args = Array.from(arguments) as any[];
    try {
      const abs = new URL(String(args[1]), location.href).href;
      const r = hook(String(args[0]).toUpperCase(), abs, 'XHR');
      if (r && r.method) args[0] = r.method;
      if (r && r.url) args[1] = r.url;
    } catch {
      /* leave the request alone */
    }
    return (open as any).apply(this, args);
  } as any;
  const f0 = window.fetch;
  if (typeof f0 !== 'function') return;
  window.fetch = function (this: any, input: any, init?: any) {
    let r: { method?: string; url?: string } | null = null;
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    let method = 'GET';
    let url = '';
    try {
      method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
      url = new URL(isReq ? input.url : String(input), location.href).href;
      r = hook(method, url, 'fetch');
    } catch {
      r = null;
    }
    if (!r || (!r.method && !r.url)) return f0.apply(this, arguments as any);
    const nm = r.method || method;
    const nu = r.url || url;
    if (nm === method) {
      return f0.call(this, isReq ? new Request(nu, input) : nu, init);
    }
    const base: any = isReq
      ? { headers: input.headers, credentials: input.credentials, cache: input.cache, redirect: input.redirect, referrer: input.referrer, signal: input.signal }
      : {};
    const init2: any = Object.assign(base, init || {}, { method: nm });
    if (nm === 'GET' || nm === 'HEAD') delete init2.body;
    return f0.call(this, nu, init2);
  } as any;
}

/** All rules (flattened, incl. nested/grouping rules) of same-origin stylesheets. */
function mlmtCssRules(): CSSRule[] {
  const out: CSSRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      out.push(r);
      const inner = (r as any).cssRules as CSSRuleList | undefined;
      if (inner && inner.length) walk(inner);
    }
  };
  for (const s of Array.from(document.styleSheets)) {
    const owner = s.ownerNode as Element | null;
    if (owner && owner.nodeType === 1 && owner.hasAttribute('data-mlmt-mutated')) continue;
    try {
      if (s.href && new URL(s.href).origin !== location.origin) continue;
      walk(s.cssRules);
    } catch {
      /* cross-origin or not loaded */
    }
  }
  return out;
}

/**
 * Run a stylesheet mutation once per document: now, or (when stylesheets are
 * still loading) again at window load, reporting through helpers.report.
 */
function mlmtOnceStyles(h: DomApplyHelpers, flag: string, run: () => string | null): string | null {
  const w = window as any;
  if (w[flag]) return null;
  const attempt = () => {
    if (w[flag]) return null;
    const d = run();
    if (d) w[flag] = 1;
    return d;
  };
  const d = attempt();
  if (d) return d;
  if (!w[flag + 'Hook'] && document.readyState !== 'complete') {
    w[flag + 'Hook'] = 1;
    window.addEventListener('load', () => {
      const d2 = attempt();
      if (d2) h.report(d2);
    });
  }
  return null;
}

/* ================================================== API-patching operators */

const parseIntRadix = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  const orig = window.parseInt;
  const patched = function (s: any, r?: any) {
    const m = orig(s);
    if (r !== undefined) {
      const o = orig(s, r);
      if (!(Number.isNaN(m) && Number.isNaN(o)) && m !== o) rep(`parseInt(${JSON.stringify(mlmtShort(s))}, ${r}) = ${m} instead of ${o}`);
    }
    return m;
  };
  (window as any).parseInt = patched;
  try {
    (Number as any).parseInt = patched;
  } catch {
    /* ignore */
  }
  return null;
}, mlmtRep, mlmtShort);

const replaceGlobal = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  const replace = String.prototype.replace;
  const match = String.prototype.match;
  String.prototype.replace = function (this: any, pattern: any, replacement: any) {
    if (pattern instanceof RegExp && pattern.global) {
      const s = String(this);
      let count = 0;
      try {
        pattern.lastIndex = 0;
        count = (match.call(s, pattern) || []).length;
      } catch {
        count = 0;
      }
      if (count >= 2) {
        const single = new RegExp(pattern.source, pattern.flags.split('g').join(''));
        rep(`${String(pattern)} replaced 1 of ${count} matches in ${JSON.stringify(mlmtShort(s))}`);
        return replace.call(s, single, replacement);
      }
    }
    return (replace as any).apply(this, arguments);
  } as any;
  return null;
}, mlmtRep, mlmtShort);

const timerImmediate = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const st = window.setTimeout;
  (window as any).setTimeout = function (this: any, f: any, t: any) {
    const delay = Number(t) || 0;
    if (typeof f === 'function' && delay > 0 && nth.call()) {
      rep(`setTimeout #${nth.n} (${delay} ms) callback called synchronously`);
      const extra = Array.prototype.slice.call(arguments, 2);
      f.apply(window, extra);
      return st.call(window, function () {}, 0);
    }
    return (st as any).apply(window, arguments);
  };
  return null;
}, mlmtRep, mlmtNth);

const timerNoArgs = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  for (const name of ['setTimeout', 'setInterval']) {
    const orig = (window as any)[name];
    (window as any)[name] = function () {
      const args = Array.from(arguments) as any[];
      const f = args[0];
      if (typeof f === 'function' && args.length > 2) {
        const n = args.length - 2;
        args.length = 2;
        args[0] = function (this: any) {
          rep(`${name} callback invoked without its ${n} extra argument(s)`);
          return f.call(this);
        };
      }
      return orig.apply(window, args);
    };
  }
  return null;
}, mlmtRep);

const domInsertSwap = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const loaded = mlmtAfterDcl();
  const NP = Node.prototype as any;
  const ib = NP.insertBefore;
  const rc = NP.replaceChild;
  NP.insertBefore = function (this: Node, a: any, b: any) {
    if (loaded() && a && b && a !== b && a.parentNode === this && b.parentNode === this && nth.call()) {
      rep(`insertBefore(${mlmtDesc(a)}, ${mlmtDesc(b)}) executed with swapped arguments`);
      return ib.call(this, b, a);
    }
    return ib.apply(this, arguments);
  };
  NP.replaceChild = function (this: Node, a: any, b: any) {
    if (loaded() && a && b && a !== b && a.parentNode === this && !(b.contains && b.contains(this)) && nth.call()) {
      rep(`replaceChild(${mlmtDesc(a)}, ${mlmtDesc(b)}) executed with swapped arguments`);
      return rc.call(this, b, a);
    }
    return rc.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtAfterDcl, mlmtDesc);

const getByIdNull = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const DP = Document.prototype as any;
  const orig = DP.getElementById;
  DP.getElementById = function (this: Document, id: any) {
    const r = orig.apply(this, arguments);
    if (nth.distinct(String(id))) {
      if (r) rep(`getElementById(${JSON.stringify(mlmtShort(id))}) returned null`);
      return null;
    }
    return r;
  };
  return null;
}, mlmtRep, mlmtNth, mlmtShort);

const attrName = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const EP = Element.prototype as any;
  const set = EP.setAttribute;
  const get = EP.getAttribute;
  const rem = EP.removeAttribute;
  const has = EP.hasAttribute;
  const pick = (name: any): string | null => {
    const n = String(name).toLowerCase();
    if (n.indexOf('data-mlmt') === 0) return null;
    return nth.distinct(n) ? n + '-mut' : null;
  };
  EP.setAttribute = function (this: Element, name: any, value: any) {
    const m = pick(name);
    if (m) {
      rep(`setAttribute(${JSON.stringify(String(name))}) on ${mlmtDesc(this)} set "${m}" instead`);
      return set.call(this, m, value);
    }
    return set.apply(this, arguments);
  };
  EP.getAttribute = function (this: Element, name: any) {
    const m = pick(name);
    if (m) {
      const o = get.call(this, name);
      const v = get.call(this, m);
      if (o !== v) rep(`getAttribute(${JSON.stringify(String(name))}) on ${mlmtDesc(this)} read "${m}" instead`);
      return v;
    }
    return get.apply(this, arguments);
  };
  EP.removeAttribute = function (this: Element, name: any) {
    const m = pick(name);
    if (m) {
      if (has.call(this, name)) rep(`removeAttribute(${JSON.stringify(String(name))}) on ${mlmtDesc(this)} removed "${m}" instead`);
      return rem.call(this, m);
    }
    return rem.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtDesc);

const attrValue = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const EP = Element.prototype as any;
  const set = EP.setAttribute;
  const usePrevious = params.source === 'previous';
  let lastName: string | null = null;
  let lastValue: string | null = null;
  EP.setAttribute = function (this: Element, name: any, value: any) {
    const n = String(name).toLowerCase();
    const v = String(value);
    if (n.indexOf('data-mlmt') !== 0 && nth.distinct(n)) {
      const nv = usePrevious && lastValue !== null && lastName !== n && lastValue !== v ? lastValue : v + 'Mut';
      rep(`setAttribute(${JSON.stringify(n)}, ${JSON.stringify(mlmtShort(v))}) on ${mlmtDesc(this)} set ${JSON.stringify(mlmtShort(nv))}`);
      return set.call(this, name, nv);
    }
    if (n.indexOf('data-mlmt') !== 0) {
      lastName = n;
      lastValue = v;
    }
    return set.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtShort, mlmtDesc);

const innerHtmlText = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = Math.max(0, Math.floor(Number(params.nth ?? 0)) || 0);
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (!d || !d.set) return null;
  const set = d.set;
  let count = 0;
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true,
    enumerable: d.enumerable,
    get: d.get,
    set(this: Element, v: any) {
      if (typeof v === 'string' && /<[a-zA-Z!\/]/.test(v) && (nth === 0 || ++count === nth)) {
        rep(`innerHTML of ${mlmtDesc(this)} assigned as text: ${JSON.stringify(mlmtShort(v))}`);
        this.textContent = v;
        return;
      }
      set.call(this, v);
    },
  });
  return null;
}, mlmtRep, mlmtShort, mlmtDesc);

const jqSelectorSwap = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const swap = (s: string) => {
    let out = '';
    let quote = '';
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (depth === 0 && (c === '#' || c === '.') && /[A-Za-z_\-]/.test(s[i + 1] || '')) {
        out += c === '#' ? '.' : '#';
        continue;
      }
      out += c;
    }
    return out;
  };
  mlmtOnJQuery((jq) => {
    return new Proxy(jq, {
      apply(target, thisArg, args) {
        const sel = args[0];
        if (typeof sel === 'string' && sel.trim()[0] !== '<') {
          const m = swap(sel);
          if (m !== sel && nth.distinct(sel)) {
            const a2 = args.slice();
            a2[0] = m;
            const res: any = Reflect.apply(target, thisArg, a2);
            try {
              const orig: any = Reflect.apply(target, thisArg, args);
              const same = orig.length === res.length && Array.prototype.every.call(orig, (e: any, i: number) => e === res[i]);
              if (!same) rep(`$(${JSON.stringify(sel)}) evaluated as $(${JSON.stringify(m)})`);
            } catch {
              /* ignore */
            }
            return res;
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  return null;
}, mlmtRep, mlmtNth, mlmtOnJQuery);

const jqNameChange = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  mlmtOnJQuery((jq) => {
    for (const m of ['addClass', 'removeClass', 'attr', 'removeAttr', 'prop', 'css']) {
      const orig = jq.fn[m];
      if (typeof orig !== 'function') continue;
      jq.fn[m] = function (this: any) {
        const args = Array.from(arguments) as any[];
        if (typeof args[0] === 'string' && nth.call()) {
          rep(`.${m}(${JSON.stringify(args[0])}) called with ${JSON.stringify(args[0] + '-mut')}`);
          args[0] = args[0] + '-mut';
        }
        return orig.apply(this, args);
      };
    }
    return undefined;
  });
  return null;
}, mlmtRep, mlmtNth, mlmtOnJQuery);

const xhrMethod = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  mlmtHookRequests((method, url, api) => {
    if (method !== 'GET' && method !== 'POST') return null;
    const u = new URL(url);
    if (!nth.distinct(u.origin + u.pathname)) return null;
    const nm = method === 'GET' ? 'POST' : 'GET';
    rep(`${api} ${method} ${mlmtShort(url)} sent as ${nm}`);
    return { method: nm };
  });
  return null;
}, mlmtRep, mlmtNth, mlmtShort, mlmtHookRequests);

const xhrUrl = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const seen: string[] = [];
  let target: string | null = null;
  mlmtHookRequests((method, url, api) => {
    const u = new URL(url);
    const key = u.origin + u.pathname;
    if (nth.distinct(key)) {
      if (target === null) {
        const prev = seen.filter((s) => new URL(s).origin + new URL(s).pathname !== key);
        if (prev.length) target = prev[prev.length - 1];
        else {
          const m = new URL(url);
          m.pathname = m.pathname.replace(/\/$/, '') + '_mut';
          target = m.href;
        }
      }
      rep(`${api} ${method} ${mlmtShort(url)} sent to ${mlmtShort(target)}`);
      return { url: target };
    }
    if (seen.indexOf(url) < 0) seen.push(url);
    return null;
  });
  return null;
}, mlmtRep, mlmtNth, mlmtShort, mlmtHookRequests);

const xhrSync = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  const XP = XMLHttpRequest.prototype as any;
  const open = XP.open;
  XP.open = function (this: XMLHttpRequest) {
    const args = Array.from(arguments) as any[];
    if (args.length < 3 || args[2]) {
      while (args.length < 3) args.push(undefined);
      args[2] = false;
      rep(`XHR ${String(args[0]).toUpperCase()} ${mlmtShort(args[1])} opened synchronously`);
    }
    return open.apply(this, args);
  };
  return null;
}, mlmtRep, mlmtShort);

/* ============================================================ AjaxMutator */

const eventType = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const from = String(params.from ?? 'click');
  const to = String(params.to ?? 'mouseover');
  const ET = EventTarget.prototype as any;
  const add = ET.addEventListener;
  const remove = ET.removeEventListener;
  const moved = new WeakMap<object, object[]>();
  ET.addEventListener = function (this: any, type: any, l: any) {
    if (type === from && l && nth.call()) {
      const args = Array.from(arguments);
      args[0] = to;
      const ts = moved.get(l) || [];
      ts.push(this);
      moved.set(l, ts);
      rep(`'${from}' listener #${nth.n} on ${mlmtDesc(this)} registered for '${to}'`);
      return add.apply(this, args);
    }
    return add.apply(this, arguments);
  };
  ET.removeEventListener = function (this: any, type: any, l: any) {
    if (type === from && l && (moved.get(l) || []).indexOf(this) >= 0) {
      const args = Array.from(arguments);
      args[0] = to;
      return remove.apply(this, args);
    }
    return remove.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtDesc);

const eventTarget = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const type0 = String(params.type ?? 'click');
  const ET = EventTarget.prototype as any;
  const add = ET.addEventListener;
  let prev: any = null;
  ET.addEventListener = function (this: any, type: any, l: any) {
    if (type === type0 && l) {
      if (prev && prev !== this && nth.call()) {
        rep(`'${type0}' listener for ${mlmtDesc(this)} attached to ${mlmtDesc(prev)}`);
        return add.apply(prev, arguments);
      }
      prev = this;
    }
    return add.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtDesc);

const eventCallback = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const type0 = String(params.type ?? 'click');
  const ET = EventTarget.prototype as any;
  const add = ET.addEventListener;
  let prev: any = null;
  ET.addEventListener = function (this: any, type: any, l: any) {
    if (type === type0 && l) {
      if (prev && prev !== l && nth.call()) {
        const args = Array.from(arguments);
        args[0] = type;
        args[1] = prev;
        rep(`'${type0}' listener on ${mlmtDesc(this)} replaced by the previously registered callback`);
        return add.apply(this, args);
      }
      prev = l;
    }
    return add.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtDesc);

const timerDuration = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const seen: number[] = [];
  for (const name of ['setTimeout', 'setInterval']) {
    const orig = (window as any)[name];
    (window as any)[name] = function () {
      const args = Array.from(arguments) as any[];
      if (typeof args[0] === 'function') {
        const t = Number(args[1]) || 0;
        if (nth.call()) {
          const other = seen.filter((x) => x !== t);
          const nt = other.length ? other[other.length - 1] : t * 2 + 100;
          args[1] = nt;
          rep(`${name} #${nth.n} delay ${t} ms → ${nt} ms`);
        } else seen.push(t);
      }
      return orig.apply(window, args);
    };
  }
  return null;
}, mlmtRep, mlmtNth);

const timerCallback = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  let prev: any = null;
  for (const name of ['setTimeout', 'setInterval']) {
    const orig = (window as any)[name];
    (window as any)[name] = function () {
      const args = Array.from(arguments) as any[];
      const f = args[0];
      if (typeof f === 'function') {
        if (nth.call()) {
          const useful = prev && prev !== f;
          args[0] = useful ? prev : function () {};
          rep(`${name} #${nth.n} callback replaced by ${useful ? 'the previously registered timer callback' : 'a no-op'}`);
        } else prev = f;
      }
      return orig.apply(window, args);
    };
  }
  return null;
}, mlmtRep, mlmtNth);

const ajaxHandlerSwap = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  mlmtOnJQuery((jq) => {
    const orig = jq.ajax;
    if (typeof orig !== 'function') return undefined;
    jq.ajax = function (this: any, url: any, options: any) {
      const args = Array.from(arguments) as any[];
      const i = typeof url === 'object' && url ? 0 : options && typeof options === 'object' ? 1 : -1;
      if (i >= 0) {
        const o = Object.assign({}, args[i]);
        if (o.success || o.error) {
          const s = o.success;
          o.success = o.error;
          o.error = s;
          if (o.success === undefined) delete o.success;
          if (o.error === undefined) delete o.error;
          args[i] = o;
          rep(`$.ajax(${mlmtShort(o.url || (i === 1 ? url : ''))}) success and error callbacks swapped`);
        }
      }
      return orig.apply(this, args);
    };
    return undefined;
  });
  return null;
}, mlmtRep, mlmtShort, mlmtOnJQuery);

const ajaxSuccessSwap = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  mlmtOnJQuery((jq) => {
    const orig = jq.ajax;
    if (typeof orig !== 'function') return undefined;
    let prev: any = null;
    jq.ajax = function (this: any, url: any, options: any) {
      const args = Array.from(arguments) as any[];
      const i = typeof url === 'object' && url ? 0 : options && typeof options === 'object' ? 1 : -1;
      const s = i >= 0 ? args[i].success : undefined;
      if (typeof s === 'function') {
        if (prev && prev !== s && nth.call()) {
          args[i] = Object.assign({}, args[i], { success: prev });
          rep(`$.ajax(${mlmtShort(args[i].url || (i === 1 ? url : ''))}) success callback replaced by the previous call's`);
        } else prev = s;
      }
      return orig.apply(this, args);
    };
    return undefined;
  });
  return null;
}, mlmtRep, mlmtNth, mlmtShort, mlmtOnJQuery);

const selectNearby = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const wrap = (proto: any, name: string, keyOf: (a: any) => string) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (this: any, a: any) {
      const r = orig.apply(this, arguments);
      if (r && r.parentElement && nth.distinct(keyOf(a))) {
        rep(`${name}(${JSON.stringify(mlmtShort(a))}) returned ${mlmtDesc(r.parentElement)} instead of ${mlmtDesc(r)}`);
        return r.parentElement;
      }
      return r;
    };
  };
  wrap(Document.prototype, 'getElementById', (a) => '#id:' + String(a));
  wrap(Document.prototype, 'querySelector', (a) => String(a));
  wrap(Element.prototype, 'querySelector', (a) => String(a));
  wrap(DocumentFragment.prototype, 'querySelector', (a) => String(a));
  return null;
}, mlmtRep, mlmtNth, mlmtShort, mlmtDesc);

const appendWrong = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const nth = mlmtNth(params);
  const NP = Node.prototype as any;
  const orig = NP.appendChild;
  const clone = NP.cloneNode;
  let prev: any = null;
  NP.appendChild = function (this: Node, x: any) {
    if (prev && x && prev !== x && nth.call()) {
      const c = clone.call(prev, true);
      rep(`appendChild(${mlmtDesc(x)}) on ${mlmtDesc(this)} appended a clone of ${mlmtDesc(prev)}`);
      return orig.call(this, c);
    }
    if (x && x.nodeType !== 11) prev = x;
    return orig.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtNth, mlmtDesc);

const removeNoop = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  const loaded = mlmtAfterDcl();
  const NP = Node.prototype as any;
  const rc = NP.removeChild;
  NP.removeChild = function (this: Node, c: any) {
    if (loaded() && c && c.parentNode === this) {
      rep(`removeChild(${mlmtDesc(c)}) ignored`);
      return c;
    }
    return rc.apply(this, arguments);
  };
  const EP = Element.prototype as any;
  const er = EP.remove;
  EP.remove = function (this: Element) {
    if (loaded() && this.parentNode) {
      rep(`${mlmtDesc(this)}.remove() ignored`);
      return;
    }
    return er.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtAfterDcl, mlmtDesc);

const cloneShallow = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  const NP = Node.prototype as any;
  const orig = NP.cloneNode;
  NP.cloneNode = function (this: Node, deep: any) {
    if (deep && this.hasChildNodes()) {
      rep(`cloneNode(true) of ${mlmtDesc(this)} made shallow`);
      return orig.call(this, false);
    }
    return orig.apply(this, arguments);
  };
  return null;
}, mlmtRep, mlmtDesc);

const normalizeNoop = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  Node.prototype.normalize = function (this: Node) {
    const tw = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!(n as Text).data.length || (n.previousSibling && n.previousSibling.nodeType === 3)) {
        rep(`normalize() of ${mlmtDesc(this)} ignored`);
        return;
      }
    }
  };
  return null;
}, mlmtRep, mlmtDesc);

/* ============================================================ JSPreventer */

const ajaxDelay = browser((_el, params, h) => {
  const rep = mlmtRep(h);
  const delay = Math.max(0, Number(params.delayMs ?? 3000));
  const st = window.setTimeout;
  const XP = XMLHttpRequest.prototype as any;
  const TYPES = ['load', 'loadend', 'readystatechange'];
  const wrapped = new WeakMap<object, any>();
  const wrap = (type: string, l: any) => {
    if (!l || (typeof l !== 'function' && typeof l.handleEvent !== 'function')) return l;
    let w = wrapped.get(l);
    if (!w) {
      w = function (this: any, ev: Event) {
        const self = this;
        const call = () => (typeof l === 'function' ? l.call(self, ev) : l.handleEvent(ev));
        if (type === 'readystatechange' && self.readyState !== 4) return call();
        rep(`XHR '${type}' dispatch delayed ${delay} ms`);
        st.call(window, call, delay);
      };
      wrapped.set(l, w);
    }
    return w;
  };
  const ET = EventTarget.prototype as any;
  XP.addEventListener = function (this: any, type: any, l: any) {
    const args = Array.from(arguments);
    if (TYPES.indexOf(type) >= 0) args[1] = wrap(type, l);
    return ET.addEventListener.apply(this, args);
  };
  XP.removeEventListener = function (this: any, type: any, l: any) {
    const args = Array.from(arguments);
    if (TYPES.indexOf(type) >= 0 && l && wrapped.has(l)) args[1] = wrapped.get(l);
    return ET.removeEventListener.apply(this, args);
  };
  for (const type of TYPES) {
    const prop = 'on' + type;
    let d: PropertyDescriptor | undefined;
    for (let p = XP; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d || !d.set || !d.get) continue;
    const dset = d.set;
    const handlers = new WeakMap<object, any>();
    Object.defineProperty(XP, prop, {
      configurable: true,
      enumerable: true,
      get(this: any) {
        return handlers.has(this) ? handlers.get(this) : null;
      },
      set(this: any, f: any) {
        handlers.set(this, typeof f === 'function' ? f : null);
        dset.call(this, typeof f === 'function' ? wrap(type, f) : f);
      },
    });
  }
  const f0 = window.fetch;
  if (typeof f0 === 'function') {
    window.fetch = function (this: any) {
      const p = f0.apply(this, arguments as any);
      return new Promise((resolve, reject) => {
        p.then(
          (r) => {
            rep(`fetch resolution delayed ${delay} ms`);
            st.call(window, () => resolve(r), delay);
          },
          (e) => {
            rep(`fetch rejection delayed ${delay} ms`);
            st.call(window, () => reject(e), delay);
          },
        );
      });
    } as any;
  }
  return null;
}, mlmtRep);

/* ================================================================= MUTEC */

const escapeIdentity = browser((_el, _p, h) => {
  const rep = mlmtRep(h);
  for (const name of ['escape', 'encodeURIComponent', 'encodeURI']) {
    const orig = (window as any)[name];
    if (typeof orig !== 'function') continue;
    (window as any)[name] = function (s: any) {
      const out = String(s);
      let o: string | null = null;
      try {
        o = orig(s);
      } catch {
        o = null;
      }
      if (o !== out) rep(`${name}(${JSON.stringify(mlmtShort(out))}) returned its input unescaped`);
      return out;
    };
  }
  return null;
}, mlmtRep, mlmtShort);

/* ============================================================ navigation */

const backFail = browser((_el, params, h) => {
  const w = window as any;
  if (w.__mlmtFob) return null;
  w.__mlmtFob = 1;
  const dummy = new URL(String(params.dummyPath ?? '/mlmt-fob-404'), location.href);
  const go = () => {
    if (location.pathname === dummy.pathname) return;
    const cur = location.href;
    const st = history.state;
    history.replaceState({ __mlmtFob: 1 }, '', dummy.href);
    history.pushState(st, '', cur);
  };
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.__mlmtFob) {
      h.report(`back navigation led to ${dummy.pathname}`);
      location.reload();
    }
  });
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
  return null;
});

const reloadFail = browser((_el, params, h) => {
  const w = window as any;
  if (w.__mlmtFor) return null;
  w.__mlmtFor = 1;
  const dummy = new URL(String(params.dummyPath ?? '/mlmt-fob-404'), location.href);
  const go = () => {
    if (location.pathname === dummy.pathname) return;
    const from = location.href;
    history.replaceState(history.state, '', dummy.href);
    h.report(`URL ${from} replaced by ${dummy.pathname}: reload loads a wrong page`);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
  return null;
});

/* ==================================================== page accessibility */

const lowContrast = browser((_el, params) => {
  if (!document.body) return null;
  const s = document.createElement('style');
  s.setAttribute('data-mlmt-mutated', 'A11.page.lowContrast');
  const color = String(params.color ?? '#fff');
  s.textContent = `body, body * { color: ${color} !important; }`;
  (document.head || document.documentElement).appendChild(s);
  return `text color forced to ${color}`;
});

const pageTitle = browser((_el, _p, h) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 10; i++) t += chars[Math.floor(h.rand() * chars.length)];
  const before = document.title;
  document.title = t;
  new MutationObserver(() => {
    if (document.title !== t) document.title = t;
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  return `title ${JSON.stringify(before)} → ${JSON.stringify(t)}`;
});

const idsDuplicate = browser((_el, _p, h) => {
  const els = Array.from(document.querySelectorAll('body [id]')).filter((e) => e.id && !e.hasAttribute('data-mlmt-mutated'));
  if (els.length < 2) return null;
  const src = els[Math.floor(h.rand() * els.length)];
  const rest = els.filter((e) => e !== src && e.id !== src.id);
  if (!rest.length) return null;
  const dst = rest[Math.floor(h.rand() * rest.length)];
  const old = dst.id;
  dst.id = src.id;
  dst.setAttribute('data-mlmt-mutated', 'A11.ids.duplicate');
  return `id ${JSON.stringify(src.id)} duplicated on <${dst.tagName.toLowerCase()}> (was ${JSON.stringify(old)})`;
});

/* ============================================================ CSS rules */

function mlmtCssDecl(MODE: string, h: DomApplyHelpers): string | null {
      const PROPS = /^(width|height|top|left|font-size|line-height|(max|min)-(width|height)|(padding|margin)(-(top|right|bottom|left))?)$/;
      return mlmtOnceStyles(h, '__mlmtCssDecl', () => {
        const cands: { r: CSSStyleRule; p: string; num: number; unit: string }[] = [];
        for (const r of mlmtCssRules()) {
          if (!(r instanceof CSSStyleRule)) continue;
          let matches = false;
          try {
            matches = !!document.querySelector(r.selectorText);
          } catch {
            matches = false;
          }
          if (!matches) continue;
          for (let i = 0; i < r.style.length; i++) {
            const p = r.style[i];
            if (!PROPS.test(p)) continue;
            const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(r.style.getPropertyValue(p).trim());
            if (!m) continue;
            const num = Number(m[1]);
            const unit = m[2].toLowerCase();
            if (MODE === 'unit' ? num === 0 || ['px', '%', 'em', 'rem'].indexOf(unit) < 0 : !unit && num !== 0 && p !== 'line-height') continue;
            cands.push({ r, p, num, unit });
          }
        }
        while (cands.length) {
          const c = cands.splice(Math.floor(h.rand() * cands.length), 1)[0];
          const before = c.r.style.getPropertyValue(c.p).trim();
          let next: string;
          if (MODE === 'unit') {
            const to = c.unit === 'px' ? 'em' : 'px';
            next = c.num + to;
          } else {
            const k = 1 + Math.floor(h.rand() * 10);
            let n = c.num + (h.rand() < 0.5 ? -k : k);
            if (n < 0 && !/^(margin|top|left)/.test(c.p)) n = c.num + k;
            n = Math.round(n * 100) / 100;
            next = n + (c.unit || (c.p === 'line-height' ? '' : 'px'));
          }
          c.r.style.setProperty(c.p, next, c.r.style.getPropertyPriority(c.p));
          const after = c.r.style.getPropertyValue(c.p).trim();
          if (after !== before) return `${c.r.selectorText} { ${c.p}: ${before} → ${after} }`;
        }
        return null;
      });
}

function mlmtCssMedia(MODE: string, h: DomApplyHelpers): string | null {
    return mlmtOnceStyles(h, '__mlmtCssMedia', () => {
      const re = MODE === 'feature' ? /\b(min|max)-(width|height)\b/g : /(\d*\.?\d+)(px|em)\b/g;
      const cands: { r: CSSMediaRule; idx: number; m: RegExpExecArray }[] = [];
      for (const r of mlmtCssRules()) {
        if (!(r instanceof CSSMediaRule)) continue;
        const text = r.media.mediaText;
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) cands.push({ r, idx: m.index, m });
      }
      while (cands.length) {
        const c = cands.splice(Math.floor(h.rand() * cands.length), 1)[0];
        const text = c.r.media.mediaText;
        let rep: string;
        if (MODE === 'feature') rep = (c.m[1] === 'min' ? 'max' : 'min') + '-' + c.m[2];
        else {
          let n = Number(c.m[1]) + (h.rand() < 0.5 ? -2 : 2);
          if (n <= 0) n = Number(c.m[1]) + 2;
          rep = n + c.m[2];
        }
        const next = text.slice(0, c.idx) + rep + text.slice(c.idx + c.m[0].length);
        try {
          c.r.media.mediaText = next;
        } catch {
          continue;
        }
        if (c.r.media.mediaText !== text) return `@media ${text} → @media ${c.r.media.mediaText}`;
      }
      return null;
    });
}

const cssDeclValue = browser((_el, _p, h) => mlmtCssDecl('value', h), mlmtCssDecl, mlmtCssRules, mlmtOnceStyles);
const cssDeclUnit = browser((_el, _p, h) => mlmtCssDecl('unit', h), mlmtCssDecl, mlmtCssRules, mlmtOnceStyles);
const cssMediaFeature = browser((_el, _p, h) => mlmtCssMedia('feature', h), mlmtCssMedia, mlmtCssRules, mlmtOnceStyles);
const cssMediaBreakpoint = browser((_el, _p, h) => mlmtCssMedia('breakpoint', h), mlmtCssMedia, mlmtCssRules, mlmtOnceStyles);

/* ================================================== test-runner operators */

type Size = { width: number; height: number };

/**
 * Track the main-frame navigations of every page of the context and call
 * `update(page, url, committed)` for each: on the navigation request (early,
 * before the document is fetched) and on commit (`committed`, used for
 * reporting).
 */
function trackPages(ctx: DomNodeContext, onPage: (p: Page) => void, update: (p: Page, url: string, committed: boolean) => Promise<void>): void {
  const hook = (p: Page) => {
    onPage(p);
    p.on('request', (r) => {
      try {
        if (r.isNavigationRequest() && r.frame() === p.mainFrame()) update(p, r.url(), false).catch(() => undefined);
      } catch {
        /* frame detached */
      }
    });
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) update(p, f.url(), true).catch(() => undefined);
    });
    if (/^https?:/.test(p.url())) update(p, p.url(), true).catch(() => undefined);
  };
  ctx.context.pages().forEach(hook);
  ctx.context.on('page', hook);
}

function matchesKey(ctx: DomNodeContext, url: string): boolean {
  if (!/^https?:/.test(url)) return false;
  if (ctx.pageKey === '*') return true;
  try {
    return ctx.pageKeyOf(url) === ctx.pageKey;
  } catch {
    return false;
  }
}

/** Init script fixing the body width at `W` px whenever the viewport differs from it. */
function fixedWidthScript(W: number): string {
  return `(() => { try {
  if (window.top !== window || window.__mlmtFixedWidth) return;
  window.__mlmtFixedWidth = true;
  const W = ${Math.round(W)};
  const sheet = new CSSStyleSheet();
  let on = false;
  const sync = () => {
    const want = Math.abs(window.innerWidth - W) > 1;
    if (want === on) return;
    on = want;
    sheet.replaceSync(want ? 'body{width:' + W + 'px !important;max-width:none !important;min-width:0 !important;}' : '');
  };
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  sync();
  window.addEventListener('resize', sync);
} catch (e) {} })();`;
}

function viewportOp(target: (base: Size, params: Params) => Size, fixed: boolean): (ctx: DomNodeContext) => Promise<void> {
  return async (ctx) => {
    const bases = new WeakMap<Page, Size>();
    trackPages(
      ctx,
      (p) => {
        const b = p.viewportSize();
        if (!b) return;
        bases.set(p, b);
        if (fixed) p.addInitScript({ content: fixedWidthScript(b.width) }).catch(() => undefined);
      },
      async (p, url, committed) => {
        const base = bases.get(p);
        if (!base) return;
        const on = matchesKey(ctx, url);
        const want = on ? target(base, ctx.params) : base;
        const cur = p.viewportSize();
        if (!cur || cur.width !== want.width || cur.height !== want.height) await p.setViewportSize(want);
        // the page init script may have been registered after this document started
        if (fixed && on && committed) await p.evaluate(fixedWidthScript(base.width)).catch(() => undefined);
        if (on && committed && (want.width !== base.width || want.height !== base.height)) {
          ctx.applied(`viewport ${base.width}x${base.height} → ${want.width}x${want.height}${fixed ? ` (body width fixed at ${base.width}px)` : ''} on ${url}`);
        }
      },
    );
  };
}

const scale = (f: number, key: string) => (b: Size, p: Params): Size => {
  const k = Number(p[key] ?? f);
  return { width: Math.max(1, Math.round(b.width * k)), height: Math.max(1, Math.round(b.height * k)) };
};

function cdpOp(label: string, enable: (s: CDPSession, p: Params) => Promise<string>, disable: (s: CDPSession) => Promise<void>): (ctx: DomNodeContext) => Promise<void> {
  return async (ctx) => {
    const sessions = new WeakMap<Page, Promise<CDPSession | null>>();
    const state = new WeakMap<Page, boolean>();
    const session = (p: Page) => {
      let s = sessions.get(p);
      if (!s) {
        s = (ctx.context as BrowserContext).newCDPSession(p).catch(() => null);
        sessions.set(p, s);
      }
      return s;
    };
    trackPages(
      ctx,
      () => undefined,
      async (p, url, committed) => {
        const on = matchesKey(ctx, url);
        if (on === !!state.get(p)) {
          if (on && committed) ctx.applied(`${label} on ${url}`);
          return;
        }
        const s = await session(p);
        if (!s) return; // not Chromium: not applied
        try {
          if (on) {
            const d = await enable(s, ctx.params);
            state.set(p, true);
            if (committed) ctx.applied(`${d} on ${url}`);
          } else {
            await disable(s);
            state.set(p, false);
          }
        } catch {
          /* CDP method unavailable */
        }
      },
    );
  };
}

const cpuThrottle = cdpOp(
  'CPU throttled',
  async (s, p) => {
    const rate = Math.max(1, Number(p.rate ?? 6));
    await s.send('Emulation.setCPUThrottlingRate', { rate });
    return `CPU throttled ${rate}x`;
  },
  async (s) => {
    await s.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  },
);

const networkThrottle = cdpOp(
  'network throttled',
  async (s, p) => {
    const latency = Number(p.latencyMs ?? 400);
    const down = Number(p.downloadBytesPerSec ?? 51200);
    const up = Number(p.uploadBytesPerSec ?? 51200);
    await s.send('Network.enable');
    await s.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: down, uploadThroughput: up });
    return `network throttled (latency ${latency} ms, ${Math.round(down / 1024)} KB/s down)`;
  },
  async (s) => {
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  },
);

async function scriptDelay(ctx: DomNodeContext): Promise<void> {
  const url = ctx.resourceUrl;
  if (!url) return;
  const delay = Math.max(0, Number(ctx.params.delayMs ?? 3000));
  await ctx.context.route(
    (u) => u.href === url,
    async (route) => {
      const req = route.request();
      if (ctx.pageKey !== '*') {
        let key = '';
        try {
          const f = req.frame();
          key = ctx.pageKeyOf(f.page()?.url() || f.url());
        } catch {
          key = '';
        }
        if (key !== ctx.pageKey) return route.fallback();
      }
      await new Promise((r) => setTimeout(r, delay));
      ctx.applied(`script ${url} held ${delay} ms`);
      await route.fallback().catch(() => undefined);
    },
  );
}

/* ============================================================= operators */

const API = 'JavaScript API Mutations';
const EVT = 'Event Mutations';
const TIM = 'Timing Mutations';
const DOMAPI = 'DOM API Mutations';
const AJAX = 'Ajax Mutations';
const NAV = 'Navigation Mutations';
const A11Y = 'Accessibility Mutations';
const CSS = 'CSS Rule Mutations';
const VP = 'Viewport Mutations';
const ENV = 'Environment Mutations';

const init = { scope: 'page' as const, phase: 'init' as const };

export const DOM_PAGE_OPERATORS: OperatorDef[] = [
  // ---------------------------------------------------------- Mutandis
  domOp({ id: 'MDA.parseInt.radix', ...init, category: API, intent: 'parseInt calls ignore their radix argument', refs: ['Mirshokraie15'], aliases: ['Mutandis:removeRadix'], apply: parseIntRadix }),
  domOp({ id: 'MDA.replace.global', ...init, category: API, intent: 'String.replace with a global regular expression replaces only the first match', refs: ['Mirshokraie15'], aliases: ['Mutandis:removeGlobalFlag'], apply: replaceGlobal }),
  domOp({ id: 'MDA.timer.immediate', ...init, category: TIM, intent: 'A delayed setTimeout callback is executed immediately at registration', refs: ['Mirshokraie15'], aliases: ['Mutandis:setTimeoutCall'], defaults: { nth: 1 }, apply: timerImmediate }),
  domOp({ id: 'MDA.timer.noArgs', ...init, category: TIM, intent: 'Timer callbacks lose the extra arguments passed to setTimeout/setInterval', refs: ['Mirshokraie15'], aliases: ['Mutandis:setTimeoutArgs'], apply: timerNoArgs }),
  domOp({ id: 'MDA.dom.insertSwap', ...init, category: DOMAPI, intent: 'insertBefore/replaceChild called with swapped node arguments', refs: ['Mirshokraie15', 'Nishiura13'], aliases: ['Mutandis:DOM-1', 'Nishiura13:DOMReplacementSrcTarget'], defaults: { nth: 1 }, apply: domInsertSwap }),
  domOp({ id: 'MDA.dom.getByIdNull', ...init, category: DOMAPI, intent: 'A script looks up an element by a wrong id and gets null', refs: ['Mirshokraie15', 'Nishiura13'], aliases: ['Mutandis:DOM-2', 'Nishiura13:DOMIdTagValue'], defaults: { nth: 1 }, apply: getByIdNull }),
  domOp({ id: 'MDA.dom.attrName', ...init, category: DOMAPI, intent: 'A script reads or writes the wrong attribute name', refs: ['Mirshokraie15', 'Nishiura13'], aliases: ['Mutandis:DOM-3', 'Nishiura13:AttributeModificationTargetRA'], defaults: { nth: 1 }, apply: attrName }),
  domOp({ id: 'MDA.dom.attrValue', ...init, category: DOMAPI, intent: 'A script writes a wrong attribute value', refs: ['Nishiura13'], aliases: ['Nishiura13:AttributeModificationValueRA'], defaults: { nth: 1, source: 'suffix' }, apply: attrValue }),
  domOp({ id: 'MDA.dom.innerHtmlText', ...init, category: DOMAPI, intent: 'Markup assigned through innerHTML is inserted as plain text', refs: ['Mirshokraie15'], aliases: ['Mutandis:DOM-4'], defaults: { nth: 0 }, apply: innerHtmlText }),
  domOp({ id: 'MDA.jq.selectorSwap', ...init, category: DOMAPI, intent: 'A jQuery selector confuses id and class (# vs .)', refs: ['Mirshokraie15'], aliases: ['Mutandis:jQ-1'], defaults: { nth: 1 }, apply: jqSelectorSwap }),
  domOp({ id: 'MDA.jq.nameChange', ...init, category: DOMAPI, intent: 'A jQuery class/attribute/property/style call uses a wrong name', refs: ['Mirshokraie15'], aliases: ['Mutandis:jQ-3'], defaults: { nth: 1 }, apply: jqNameChange }),
  domOp({ id: 'MDA.xhr.method', ...init, category: AJAX, intent: 'An Ajax request is sent with the wrong HTTP method (GET/POST)', refs: ['Mirshokraie15', 'Nishiura13'], aliases: ['Mutandis:XHR-1', 'Nishiura13:RequestMethodRA'], defaults: { nth: 1 }, apply: xhrMethod }),
  domOp({ id: 'MDA.xhr.url', ...init, category: AJAX, intent: 'An Ajax request is sent to a wrong URL', refs: ['Mirshokraie15', 'Nishiura13', 'LinaresVasquez17'], aliases: ['Mutandis:XHR-1', 'Nishiura13:RequestUrlRA', 'MDroid+:InvalidURI'], defaults: { nth: 1 }, apply: xhrUrl }),
  domOp({ id: 'MDA.xhr.sync', ...init, category: AJAX, intent: 'Asynchronous XHR requests become synchronous', refs: ['Mirshokraie15'], aliases: ['Mutandis:XHR-1(async)'], apply: xhrSync }),
  // ---------------------------------------------------------- AjaxMutator
  domOp({ id: 'AJM.event.type', ...init, category: EVT, intent: 'An event handler is registered for the wrong event type', refs: ['Nishiura13', 'Tafreshipour24'], aliases: ['Nishiura13:EventTypeRA', 'Ma11y:CDP(partly)'], defaults: { nth: 1, from: 'click', to: 'mouseover' }, apply: eventType }),
  domOp({ id: 'AJM.event.target', ...init, category: EVT, intent: 'An event handler is attached to the wrong element', refs: ['Nishiura13'], aliases: ['Nishiura13:EventTargetRA'], defaults: { nth: 1, type: 'click' }, apply: eventTarget }),
  domOp({ id: 'AJM.event.callback', ...init, category: EVT, intent: 'An element is wired to the wrong event handler', refs: ['Nishiura13', 'Yandrapally21'], aliases: ['Nishiura13:EventCallbackRA', 'MAEWU:EHMM(source level)'], defaults: { nth: 1, type: 'click' }, apply: eventCallback }),
  domOp({ id: 'AJM.timer.duration', ...init, category: TIM, intent: 'A timer fires after a wrong delay', refs: ['Nishiura13'], aliases: ['Nishiura13:TimerEventDurationRA'], defaults: { nth: 1 }, apply: timerDuration }),
  domOp({ id: 'AJM.timer.callback', ...init, category: TIM, intent: 'A timer runs the wrong callback', refs: ['Nishiura13'], aliases: ['Nishiura13:TimerEventCallbackRA'], defaults: { nth: 1 }, apply: timerCallback }),
  domOp({ id: 'AJM.ajax.handlerSwap', ...init, category: AJAX, intent: 'Ajax success and error handlers are swapped', refs: ['Nishiura13'], aliases: ['Nishiura13:ReplacingAjaxCallback'], apply: ajaxHandlerSwap }),
  domOp({ id: 'AJM.ajax.successSwap', ...init, category: AJAX, intent: 'An Ajax request runs the success handler of another request', refs: ['Nishiura13'], aliases: ['Nishiura13:RequestOnSuccessHandlerRA'], defaults: { nth: 1 }, apply: ajaxSuccessSwap }),
  domOp({ id: 'AJM.dom.selectNearby', ...init, category: DOMAPI, intent: 'A DOM query returns a nearby (parent) element instead of the intended one', refs: ['Nishiura13'], aliases: ['Nishiura13:DOMSelectionSelectNearby'], defaults: { nth: 1 }, apply: selectNearby }),
  domOp({ id: 'AJM.dom.appendWrong', ...init, category: DOMAPI, intent: 'The wrong node is appended to the document', refs: ['Nishiura13'], aliases: ['Nishiura13:AppendedDOMRA'], defaults: { nth: 1 }, apply: appendWrong }),
  domOp({ id: 'AJM.dom.removeNoop', ...init, category: DOMAPI, intent: 'Scripted DOM removals have no effect', refs: ['Nishiura13'], aliases: ['Nishiura13:DOMRemovalToNoOp'], apply: removeNoop }),
  domOp({ id: 'AJM.dom.cloneShallow', ...init, category: DOMAPI, intent: 'Deep DOM cloning copies only the node, not its subtree', refs: ['Nishiura13'], aliases: ['Nishiura13:DOMCloningToNoOp(partial)'], apply: cloneShallow }),
  domOp({ id: 'AJM.dom.normalizeNoop', ...init, category: DOMAPI, intent: 'Text-node normalisation is skipped', refs: ['Nishiura13'], aliases: ['Nishiura13:DOMNormalizationToNoOp'], apply: normalizeNoop }),
  // ---------------------------------------------------------- JSPreventer
  domOp({ id: 'JSP.ajax.delay', ...init, category: TIM, intent: 'Ajax responses are processed late (asynchronous delay)', refs: ['Maezawa14'], aliases: ['JSPreventer:AsynchronousDelay'], defaults: { delayMs: 3000 }, apply: ajaxDelay }),
  domOp({ id: 'JSP.script.delay', scope: 'page', perResource: 'script', category: TIM, intent: 'A script loads late, delaying page initialisation (synchronous delay)', refs: ['Maezawa14', 'Adamsen18'], aliases: ['JSPreventer:SynchronousDelay', 'InitRacer:longDelay'], defaults: { delayMs: 3000 }, nodeApply: scriptDelay }),
  // ---------------------------------------------------------- MUTEC
  domOp({ id: 'SEC.escape.identity', ...init, category: API, intent: 'Output escaping/encoding functions do nothing', refs: ['Shahriar09'], aliases: ['MUTEC:RESC'], apply: escapeIdentity }),
  // ---------------------------------------------------------- webMuJava navigation
  domOp({ id: 'WNV.back.fail', ...init, category: NAV, intent: 'The browser back button leads to a wrong page', refs: ['Praphamontripong17'], aliases: ['Praphamontripong17:FOB'], defaults: { dummyPath: '/mlmt-fob-404' }, apply: backFail }),
  domOp({ id: 'WNV.reload.fail', ...init, category: NAV, intent: 'Reloading the page loads a wrong URL', refs: ['Praphamontripong17'], aliases: ['Praphamontripong17:FOR'], defaults: { dummyPath: '/mlmt-fob-404' }, apply: reloadFail }),
  // ---------------------------------------------------------- Ma11y page faults
  domOp({ id: 'A11.page.lowContrast', scope: 'page', category: A11Y, intent: 'Text has insufficient contrast with its background', refs: ['Tafreshipour24'], aliases: ['Ma11y:CFC (F24)'], defaults: { color: '#fff' }, apply: lowContrast }),
  domOp({ id: 'A11.page.title', scope: 'page', category: A11Y, intent: 'The page title does not describe the page', refs: ['Tafreshipour24'], aliases: ['Ma11y:CPT (F25)'], apply: pageTitle }),
  domOp({
    id: 'A11.ids.duplicate', scope: 'page', category: A11Y, intent: 'Two elements share the same id', refs: ['Tafreshipour24'], aliases: ['Ma11y:MDI (F77)'],
    pageApplicable: (els: ElementInfo[]) => new Set(els.map((e) => e.attrs?.id).filter((x) => !!x)).size >= 2,
    apply: idsDuplicate,
  }),
  // ---------------------------------------------------------- Walsh CSS
  domOp({ id: 'CSS.decl.value', scope: 'page', category: CSS, intent: 'A layout declaration of a stylesheet rule has a slightly wrong value', refs: ['Walsh20'], aliases: ['Walsh:DeclarationValue'], apply: cssDeclValue }),
  domOp({ id: 'CSS.decl.unit', scope: 'page', category: CSS, intent: 'A length in a stylesheet rule uses the wrong unit', refs: ['Walsh20'], aliases: ['Walsh:DeclarationUnit'], apply: cssDeclUnit }),
  domOp({ id: 'CSS.media.feature', scope: 'page', category: CSS, intent: 'A media query uses min- instead of max- (or vice versa)', refs: ['Walsh20'], aliases: ['Walsh:QueryExpression'], apply: cssMediaFeature }),
  domOp({ id: 'CSS.media.breakpoint', scope: 'page', category: CSS, intent: 'A media query breakpoint is off by a few units', refs: ['Walsh20'], aliases: ['Walsh:QueryBreakpoint'], apply: cssMediaBreakpoint }),
  // ---------------------------------------------------------- Oliveira viewport
  domOp({ id: 'GUI.viewport.expand', scope: 'page', category: VP, intent: 'The window is larger than expected and the layout reflows', refs: ['Oliveira15'], aliases: ['Oliveira15:EWWAR'], defaults: { factor: 1.5 }, nodeApply: viewportOp(scale(1.5, 'factor'), false) }),
  domOp({ id: 'GUI.viewport.reduce', scope: 'page', category: VP, intent: 'The window is smaller than expected and the layout reflows', refs: ['Oliveira15'], aliases: ['Oliveira15:RWWAR'], defaults: { factor: 0.6 }, nodeApply: viewportOp(scale(0.6, 'factor'), false) }),
  domOp({ id: 'GUI.viewport.expandFixed', scope: 'page', category: VP, intent: 'The window is enlarged without the layout adapting', refs: ['Oliveira15'], aliases: ['Oliveira15:EWWNAR'], defaults: { factor: 1.5 }, nodeApply: viewportOp(scale(1.5, 'factor'), true) }),
  domOp({ id: 'GUI.viewport.reduceFixed', scope: 'page', category: VP, intent: 'The window is reduced without the layout adapting, so content overflows', refs: ['Oliveira15'], aliases: ['Oliveira15:RWWNAR'], defaults: { factor: 0.6 }, nodeApply: viewportOp(scale(0.6, 'factor'), true) }),
  domOp({
    id: 'GUI.viewport.hide', scope: 'page', category: VP, intent: 'The window is so small that widgets fall outside it', refs: ['Oliveira15'], aliases: ['Oliveira15:RWHW'], defaults: { width: 360, height: 240 },
    nodeApply: viewportOp((_b, p) => ({ width: Number(p.width ?? 360), height: Number(p.height ?? 240) }), false),
  }),
  // ---------------------------------------------------------- environment
  domOp({ id: 'ENV.cpu.throttle', scope: 'page', category: ENV, intent: 'The client CPU is slow (exposes timing assumptions)', refs: ['Moran20', 'Silva20'], aliases: ['FlakyLoc:cpu', 'Shaker:cpu'], defaults: { rate: 6 }, nodeApply: cpuThrottle }),
  domOp({
    id: 'ENV.network.throttle', scope: 'page', category: ENV, intent: 'The network is slow (slow 3G)', refs: ['Moran20', 'Toxiproxy'], aliases: ['FlakyLoc:network', 'Toxiproxy:bandwidth'],
    defaults: { latencyMs: 400, downloadBytesPerSec: 51200, uploadBytesPerSec: 51200 }, nodeApply: networkThrottle,
  }),
];
