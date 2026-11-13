/**
 * Literature network operators (Batch D): HTTP status/header/body mutations
 * (HTTPMutator, Espinha14, Offutt04 data perturbation, RESTest, deMelo11,
 * Siblini05), connection faults and latency (Toxiproxy, Gremlin, Filibuster,
 * WireMock), response races (AjaxRacer), request-side mutations and cookie
 * handling (Praphamontripong17, Loise17).
 *
 * Every operator reports an application (`ctx.applied`) only when the
 * response/request it settles actually differs from the original one.
 */
import type { Request } from '@playwright/test';
import type { EndpointInfo, NetworkHandlerContext, NetworkOperatorDef, OperatorDef } from '../registry';
import { netOp } from './util';

type Ctx = NetworkHandlerContext;
type Json = unknown;
type Path = (string | number)[];
type JNode = { path: Path; value: Json };

/* ================================================================ helpers */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function strippedHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') continue;
    out[k] = v;
  }
  return out;
}

function headerKey(h: Record<string, string>, name: string): string | undefined {
  return Object.keys(h).find((k) => k.toLowerCase() === name);
}

const isJsonCt = (ct: string | undefined) => !!ct && /json/i.test(ct);
const isTextCt = (ct: string | undefined) => !!ct && /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded/i.test(ct);

const isJsonEp = (ep: EndpointInfo) => !!ep.json || isJsonCt(ep.contentType);
/** The recorded JSON shape has a field of type `t` (unknown shape ⇒ allow). */
function epHas(ep: EndpointInfo, t: string): boolean {
  if (!isJsonEp(ep)) return false;
  if (!ep.json) return true;
  if (t === 'array' && ep.json.hasArray) return true;
  return Object.values(ep.json.fields).some((s) => s.split('|').includes(t));
}
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const hasBodyMethod = (ep: EndpointInfo) => BODY_METHODS.includes(ep.method.toUpperCase());

function kindOf(v: Json): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/** All nodes of a JSON value (root first, document order). */
function nodes(v: Json, path: Path = [], out: JNode[] = []): JNode[] {
  out.push({ path, value: v });
  if (Array.isArray(v)) v.forEach((x, i) => nodes(x, [...path, i], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, Json>)) nodes(x, [...path, k], out);
  return out;
}

function parentOf(root: Json, path: Path): any {
  let cur: any = root;
  for (const k of path.slice(0, -1)) cur = cur[k as any];
  return cur;
}

/** Set the value at `path`; returns the (possibly new) root. */
function setAt(root: Json, path: Path, value: Json): Json {
  if (!path.length) return value;
  parentOf(root, path)[path[path.length - 1] as any] = value;
  return root;
}

function deleteAt(root: Json, path: Path): void {
  const parent = parentOf(root, path);
  const key = path[path.length - 1];
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key as string];
}

const pathKey = (p: Path) => JSON.stringify(p);
const pathStr = (p: Path) => (p.length ? p.map((k) => (typeof k === 'number' ? `[${k}]` : `.${k}`)).join('').replace(/^\./, '') : '<root>');
const isProp = (n: JNode) => n.path.length > 0 && typeof n.path[n.path.length - 1] === 'string';
const isLeaf = (n: JNode) => n.path.length > 0 && kindOf(n.value) !== 'object' && kindOf(n.value) !== 'array';

/**
 * Choose one candidate uniformly at the first application and keep it
 * (by key) for later requests of the run; if the kept candidate is absent
 * from a later message, choose again for that message only.
 */
function choose<T>(ctx: Ctx, cands: T[], key: (c: T) => string, slot = 'pick'): T | undefined {
  if (!cands.length) return undefined;
  const prev = ctx.state[slot];
  if (prev !== undefined) {
    const hit = cands.find((c) => key(c) === prev);
    if (hit) return hit;
  }
  const c = cands[Math.floor(ctx.rand() * cands.length)];
  if (prev === undefined) ctx.state[slot] = key(c);
  return c;
}

const pick = <T>(rand: () => number, xs: T[]): T => xs[Math.floor(rand() * xs.length)];

function randomString(rand: () => number, len: number, avoid?: string): string {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 5; attempt++) {
    let s = '';
    for (let i = 0; i < len; i++) s += abc[Math.floor(rand() * abc.length)];
    if (s !== avoid) return s;
  }
  return 'z'.repeat(len) === avoid ? 'y'.repeat(len) : 'z'.repeat(len);
}

/* ------------------------------------------------------- response helpers */

type Resp = { status: number; headers: Record<string, string>; body: Buffer };
type RespChange = { status?: number; headers?: Record<string, string>; body?: string | Buffer; detail: string } | null;

/**
 * Fetch the real response, let `fn` rewrite it; fulfil the original
 * response when `fn` returns null (no report).
 */
async function respOp(ctx: Ctx, fn: (r: Resp) => RespChange | Promise<RespChange>, maxRedirects?: number): Promise<void> {
  const response = await ctx.route.fetch(maxRedirects === undefined ? undefined : { maxRedirects });
  const r: Resp = { status: response.status(), headers: response.headers(), body: await response.body() };
  const ch = await fn(r);
  if (!ch) return ctx.route.fulfill({ status: r.status, headers: strippedHeaders(r.headers), body: r.body });
  ctx.applied(ch.detail);
  return ctx.route.fulfill({ status: ch.status ?? r.status, headers: strippedHeaders(ch.headers ?? r.headers), body: ch.body ?? r.body });
}

/** Number literals that JSON.stringify cannot write verbatim (precision loss). */
const RAW_NUM = '__mlmt_raw_number__:';

type JsonChange = { value: Json; detail: string } | null;
/** JSON response mutation: `fn` mutates (in place or by returning a new root) the parsed body. */
function jsonOp(fn: (json: Json, ctx: Ctx) => JsonChange) {
  return (ctx: Ctx) =>
    respOp(ctx, (r) => {
      if (!isJsonCt(r.headers['content-type'])) return null;
      let json: Json;
      try {
        json = JSON.parse(r.body.toString('utf8'));
      } catch {
        return null;
      }
      const res = fn(json, ctx);
      if (!res) return null;
      let body = JSON.stringify(res.value);
      if (body.includes(RAW_NUM)) body = body.replace(new RegExp(`"${RAW_NUM}(-?[0-9.eE+-]+)"`, 'g'), '$1');
      return { body, detail: res.detail };
    });
}

const NO_CHANGE = Symbol('no change');
/**
 * Leaf/node operator: choose one node satisfying `filter` (kept across the
 * run) and replace its value with `transform(value)`.
 */
function nodeOp(filter: (n: JNode) => boolean, transform: (v: any, ctx: Ctx) => Json | typeof NO_CHANGE, describe: (n: JNode, nv: Json) => string) {
  return jsonOp((json, ctx) => {
    const n = choose(ctx, nodes(json).filter(filter), (c) => pathKey(c.path));
    if (!n) return null;
    const nv = transform(n.value, ctx);
    if (nv === NO_CHANGE || JSON.stringify(nv) === JSON.stringify(n.value)) return null;
    return { value: setAt(json, n.path, nv), detail: describe(n, nv) };
  });
}

const show = (v: Json) => {
  const s = typeof v === 'string' && v.startsWith(RAW_NUM) ? v.slice(RAW_NUM.length) : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
};
const leafOp = (type: string, guard: (v: any) => boolean, transform: (v: any, ctx: Ctx) => Json | typeof NO_CHANGE) =>
  nodeOp(
    (n) => isLeaf(n) && kindOf(n.value) === type && guard(n.value),
    transform,
    (n, nv) => `${pathStr(n.path)}: ${show(n.value)} -> ${show(nv)}`,
  );
const numOp = (guard: (n: number) => boolean, f: (n: number, ctx: Ctx) => Json) => leafOp('number', guard, f);

/* ------------------------------------------------------- request helpers */

type ReqBody = { kind: 'json'; value: Json; text: string } | { kind: 'form'; value: URLSearchParams; text: string } | { kind: 'raw'; text: string };

function parseReqBody(req: Request): ReqBody | null {
  const text = req.postData();
  if (text == null || text === '') return null;
  const ct = req.headers()['content-type'] || '';
  if (/multipart/i.test(ct)) return { kind: 'raw', text };
  if (isJsonCt(ct) || /^\s*[[{]/.test(text)) {
    try {
      return { kind: 'json', value: JSON.parse(text), text };
    } catch {
      /* not JSON */
    }
  }
  if (/x-www-form-urlencoded/i.test(ct) || /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(text)) {
    return { kind: 'form', value: new URLSearchParams(text), text };
  }
  return { kind: 'raw', text };
}

type FieldChange = { postData: string; detail: string } | null;
interface FieldSpec {
  /** JSON property candidates. */
  json?: (n: JNode) => boolean;
  jsonValue?: (v: Json, ctx: Ctx) => Json;
  /** Form-field candidates (name, value). */
  form?: (value: string) => boolean;
  formValue?: (v: string, ctx: Ctx) => string | null;
  /** Unparseable (raw) body. */
  raw?: (text: string) => string | null;
}

/** Request-body field mutation, continued with the new postData. */
function reqFieldOp(spec: FieldSpec) {
  return async (ctx: Ctx) => {
    const b = parseReqBody(ctx.request);
    let ch: FieldChange = null;
    if (b?.kind === 'json' && spec.json) {
      const n = choose(ctx, nodes(b.value).filter((x) => isProp(x) && spec.json!(x)), (c) => pathKey(c.path));
      if (n) {
        if (spec.jsonValue) {
          const nv = spec.jsonValue(n.value, ctx);
          if (JSON.stringify(nv) !== JSON.stringify(n.value)) {
            ch = { postData: JSON.stringify(setAt(b.value, n.path, nv)), detail: `request ${pathStr(n.path)}: ${show(n.value)} -> ${show(nv)}` };
          }
        } else {
          deleteAt(b.value, n.path);
          ch = { postData: JSON.stringify(b.value), detail: `request field ${pathStr(n.path)} dropped` };
        }
      }
    } else if (b?.kind === 'form' && spec.form) {
      const names = [...new Set([...b.value.keys()])].filter((k) => b.value.getAll(k).some((v) => spec.form!(v)));
      const name = choose(ctx, names, (x) => x);
      if (name !== undefined) {
        const old = b.value.get(name) ?? '';
        if (spec.formValue) {
          const nv = spec.formValue(old, ctx);
          if (nv !== null && nv !== old) {
            b.value.set(name, nv);
            ch = { postData: b.value.toString(), detail: `request form field ${name}: ${show(old)} -> ${show(nv)}` };
          }
        } else {
          b.value.delete(name);
          ch = { postData: b.value.toString(), detail: `request form field ${name} dropped` };
        }
      }
    } else if (b?.kind === 'raw' && spec.raw) {
      const nv = spec.raw(b.text);
      if (nv !== null && nv !== b.text) ch = { postData: nv, detail: `request body ${show(b.text)} -> ${show(nv)}` };
    }
    if (!ch) return ctx.route.fallback();
    ctx.applied(ch.detail);
    return ctx.route.continue({ postData: ch.postData });
  };
}

/** Cookies the browser would send with `req` (Playwright's continue() cannot remove them). */
async function cookiesFor(req: Request): Promise<{ name: string; value: string }[]> {
  try {
    const page = req.frame().page();
    return await page.context().cookies(req.url());
  } catch {
    return [];
  }
}

const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'cookie', 'keep-alive', 'transfer-encoding']);

/**
 * Perform the request from the test-runner process (Node fetch) instead of
 * route.fetch(): route.fetch() shares the browser context's cookie jar, so it
 * would store Set-Cookie headers before any mutation and always send cookies.
 */
async function nodeFetch(req: Request, opts: { sendCookies: boolean }): Promise<{ status: number; headers: Record<string, string>; setCookies: string[]; body: Buffer }> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers())) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  if (opts.sendCookies) {
    const cs = await cookiesFor(req);
    if (cs.length) headers.cookie = cs.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  const method = req.method();
  const body = req.postDataBuffer();
  const res = await fetch(req.url(), {
    method,
    headers,
    body: body && !['GET', 'HEAD'].includes(method.toUpperCase()) ? new Uint8Array(body) : undefined,
    redirect: 'manual',
  });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie') out[k] = v;
  });
  const setCookies = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, headers: strippedHeaders(out), setCookies, body: Buffer.from(await res.arrayBuffer()) };
}

/** Fulfil from a Node-fetched response; multiple Set-Cookie values are separated by '\n' (Playwright convention). */
function fulfillNode(ctx: Ctx, r: { status: number; headers: Record<string, string>; body: Buffer }, setCookies: string[]) {
  const headers = { ...r.headers };
  if (setCookies.length) headers['set-cookie'] = setCookies.join('\n');
  return ctx.route.fulfill({ status: r.status, headers, body: r.body });
}

/** Set-Cookie rewriting (null = drop the cookie). */
function setCookieOp(rewrite: (sc: string) => string | null, what: string) {
  return async (ctx: Ctx) => {
    const r = await nodeFetch(ctx.request, { sendCookies: true });
    const out: string[] = [];
    let changed = 0;
    for (const sc of r.setCookies) {
      const nv = rewrite(sc);
      if (nv !== sc) changed++;
      if (nv !== null) out.push(nv);
    }
    if (changed) ctx.applied(`${what} on ${changed} Set-Cookie header(s)`);
    return fulfillNode(ctx, r, out);
  };
}

const stripCookieAttr = (attr: string) => (sc: string) => {
  const parts = sc.split(';');
  const kept = [parts[0], ...parts.slice(1).filter((p) => p.trim().split('=')[0].trim().toLowerCase() !== attr)];
  return kept.length === parts.length ? sc : kept.join(';');
};

/* ------------------------------------------------------- misc helpers */

/** Pretty-print JSON with indentation and extra blanks around separators (semantically equal). */
function reformat(v: Json, ind = ''): string {
  const next = ind + '    ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => next + reformat(x, next)).join(' ,\n')}\n${ind}]` : '[ ]';
  if (v && typeof v === 'object') {
    const es = Object.entries(v as Record<string, Json>);
    return es.length ? `{\n${es.map(([k, x]) => `${next}${JSON.stringify(k)} : ${reformat(x, next)}`).join(' ,\n')}\n${ind}}` : '{ }';
  }
  return JSON.stringify(v);
}

function statusOp(listKey: string) {
  return (ctx: Ctx) =>
    respOp(ctx, (r) => {
      const all = (ctx.params[listKey] as number[]).map(Number);
      const choices = all.filter((s) => s !== r.status);
      if (!choices.length) return null;
      if (ctx.state.status === undefined || ctx.state.status === r.status) ctx.state.status = pick(ctx.rand, choices);
      return { status: ctx.state.status, detail: `status ${r.status} -> ${ctx.state.status}` };
    });
}

function abortOp(code: string) {
  return async (ctx: Ctx) => {
    ctx.applied(`aborted (${code})`);
    return ctx.route.abort(code);
  };
}

function setMediaType(ct: string, media: string): string {
  const i = ct.indexOf(';');
  return i < 0 ? media : media + ct.slice(i);
}

const locationApplicable = (ep: EndpointInfo) =>
  (ep.status >= 300 && ep.status < 400) || ep.resourceType === 'document' || ep.method.toUpperCase() === 'POST';

function locationOp(mutate: (loc: string, r: Resp, ctx: Ctx) => { headers: Record<string, string>; detail: string }) {
  return (ctx: Ctx) =>
    respOp(
      ctx,
      (r) => {
        const k = headerKey(r.headers, 'location');
        if (r.status < 300 || r.status >= 400 || !k) return null;
        return mutate(r.headers[k], r, ctx);
      },
      0,
    );
}

/* ================================================================ operators */

const R = 'HTTPMutator';
const PAYLOAD = 'Payload Mutations';
const STATUS = 'Status Mutations';
const HEADER = 'Header Mutations';
const BODY = 'Body Mutations';
const FAULT = 'Connection Faults';
const LATENCY = 'Latency Mutations';
const ORDER = 'Ordering Mutations';
const REQUEST = 'Request Mutations';
const COOKIE = 'Cookie Mutations';

const json = (ep: EndpointInfo) => isJsonEp(ep);
const number = (ep: EndpointInfo) => epHas(ep, 'number');
const string = (ep: EndpointInfo) => epHas(ep, 'string');

export const NETWORK_LIT_OPERATORS: OperatorDef[] = [
  /* ------------------------------------------------------------ status */
  netOp({
    id: 'HTM.status.success', category: STATUS, refs: [R], aliases: ['HTTPMutator:R2XX'],
    intent: 'A failing or redirecting response is reported as successful (status 200) with its body unchanged.',
    defaults: { status: 200 },
    applicable: (ep) => ep.status >= 300,
    handle: (ctx) =>
      respOp(ctx, (r) => (r.status >= 300 ? { status: Number(ctx.params.status ?? 200), detail: `status ${r.status} -> ${ctx.params.status ?? 200}` } : null), 0),
  }),
  netOp({
    id: 'HTM.status.client', category: STATUS, refs: [R], aliases: ['HTTPMutator:R4XX'],
    intent: 'The server rejects the request with a client-error status (400/401/403/404/409).',
    defaults: { statuses: [400, 401, 403, 404, 409] },
    handle: statusOp('statuses'),
  }),
  netOp({
    id: 'HTM.status.server', category: STATUS, refs: [R], aliases: ['HTTPMutator:R5XX'],
    intent: 'The server fails with a server-error status (500-504) while the body is kept.',
    defaults: { statuses: [500, 501, 502, 503, 504] },
    handle: statusOp('statuses'),
  }),

  /* ------------------------------------------------------------ headers */
  netOp({
    id: 'HTM.contentType.change', category: HEADER, refs: [R], aliases: ['HTTPMutator:CTC'],
    intent: 'The response declares a wrong media type (JSON as text/plain, text/plain as JSON, HTML as text, other as octet-stream).',
    applicable: (ep) => !!ep.contentType,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        const k = headerKey(r.headers, 'content-type');
        if (!k) return null;
        const ct = r.headers[k];
        const media = ct.split(';')[0].trim().toLowerCase();
        const to = /json/.test(media) ? 'text/plain' : media === 'text/plain' ? 'application/json' : media === 'text/html' ? 'text/plain' : 'application/octet-stream';
        if (to === media) return null;
        return { headers: { ...r.headers, [k]: setMediaType(ct, to) }, detail: `content-type ${media} -> ${to}` };
      }),
  }),
  netOp({
    id: 'HTM.contentType.delete', category: HEADER, refs: [R], aliases: ['HTTPMutator:CTD'],
    intent: 'The response is sent without a Content-Type header.',
    applicable: (ep) => !!ep.contentType,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        const k = headerKey(r.headers, 'content-type');
        if (!k) return null;
        const headers = { ...r.headers };
        delete headers[k];
        return { headers, detail: `content-type ${r.headers[k]} removed` };
      }),
  }),
  netOp({
    id: 'HTM.charset.change', category: HEADER, refs: [R], aliases: ['HTTPMutator:CPC'],
    intent: 'The response declares a wrong character set (UTF-16) for its unchanged bytes.',
    defaults: { charset: 'UTF-16' },
    applicable: (ep) => isTextCt(ep.contentType) || !!ep.json,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        const k = headerKey(r.headers, 'content-type');
        const cs = String(ctx.params.charset ?? 'UTF-16');
        if (!k || !isTextCt(r.headers[k])) return null;
        const ct = r.headers[k];
        const m = /;\s*charset=("?)([^;"]*)\1/i.exec(ct);
        if (m && m[2].toLowerCase() === cs.toLowerCase()) return null;
        const nct = m ? ct.replace(m[0], `; charset=${cs}`) : `${ct}; charset=${cs}`;
        return { headers: { ...r.headers, [k]: nct }, detail: `content-type ${ct} -> ${nct}` };
      }),
  }),
  netOp({
    id: 'HTM.charset.delete', category: HEADER, refs: [R], aliases: ['HTTPMutator:CPD'],
    intent: 'The charset parameter is removed from the response content type.',
    applicable: (ep) => /charset=/i.test(ep.contentType),
    handle: (ctx) =>
      respOp(ctx, (r) => {
        const k = headerKey(r.headers, 'content-type');
        if (!k || !/;\s*charset=/i.test(r.headers[k])) return null;
        const nct = r.headers[k].replace(/\s*;\s*charset=("?)[^;"]*\1/gi, '');
        return { headers: { ...r.headers, [k]: nct }, detail: `content-type ${r.headers[k]} -> ${nct}` };
      }),
  }),
  netOp({
    id: 'HTM.location.change', category: HEADER, refs: [R, 'Praphamontripong10'], aliases: ['HTTPMutator:LHC', 'Praphamontripong10:WRR'],
    intent: 'A redirect points to a wrong location (an extra path segment is appended).',
    applicable: locationApplicable,
    handle: locationOp((loc, r, ctx) => {
      if (ctx.state.seg === undefined) ctx.state.seg = 1 + Math.floor(ctx.rand() * 999);
      const u = new URL(loc, ctx.request.url());
      u.pathname = u.pathname.replace(/\/$/, '') + '/' + ctx.state.seg;
      const k = headerKey(r.headers, 'location')!;
      return { headers: { ...r.headers, [k]: u.href }, detail: `location ${loc} -> ${u.href}` };
    }),
  }),
  netOp({
    id: 'HTM.location.delete', category: HEADER, refs: [R, 'Praphamontripong10'], aliases: ['HTTPMutator:LHD', 'Praphamontripong10:WRD'],
    intent: 'A redirect response lacks its Location header, so the redirect is not followed.',
    applicable: locationApplicable,
    handle: locationOp((loc, r) => {
      const headers = { ...r.headers };
      delete headers[headerKey(headers, 'location')!];
      return { headers, detail: `location ${loc} removed` };
    }),
  }),

  /* ------------------------------------------------------------ arrays */
  netOp({
    id: 'HTM.array.add', category: PAYLOAD, refs: [R, 'Offutt04'], aliases: ['HTTPMutator:AEA', 'Offutt04:DCP-α*α'],
    intent: 'An array in the response contains one extra element (copy of its last element).',
    applicable: (ep) => epHas(ep, 'array'),
    handle: nodeOp(
      (n) => Array.isArray(n.value),
      (a: Json[]) => [...a, a.length ? JSON.parse(JSON.stringify(a[a.length - 1])) : 0],
      (n, nv) => `${pathStr(n.path)}: ${(n.value as Json[]).length} -> ${(nv as Json[]).length} elements`,
    ),
  }),
  netOp({
    id: 'HTM.array.remove', category: PAYLOAD, refs: [R, 'Offutt04'], aliases: ['HTTPMutator:AER', 'Offutt04:DCP-α*−1'],
    intent: 'An array in the response misses one of its elements.',
    applicable: (ep) => epHas(ep, 'array'),
    handle: nodeOp(
      (n) => Array.isArray(n.value) && n.value.length > 0,
      (a: Json[], ctx) => {
        const i = Math.floor(ctx.rand() * a.length);
        return a.filter((_, j) => j !== i);
      },
      (n) => `${pathStr(n.path)}: one of ${(n.value as Json[]).length} elements removed`,
    ),
  }),
  netOp({
    id: 'HTM.array.exchange', category: PAYLOAD, refs: [R], aliases: ['HTTPMutator:AEE'],
    intent: 'One element of an array in the response is moved to another position.',
    applicable: (ep) => isJsonEp(ep) && (!ep.json || ep.json.maxArrayLength >= 2),
    handle: nodeOp(
      (n) => Array.isArray(n.value) && n.value.length >= 2 && new Set(n.value.map((x) => JSON.stringify(x))).size > 1,
      (a: Json[], ctx) => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const i = Math.floor(ctx.rand() * a.length);
          let j = Math.floor(ctx.rand() * (a.length - 1));
          if (j >= i) j++;
          const b = [...a];
          const [x] = b.splice(i, 1);
          b.splice(j, 0, x);
          if (JSON.stringify(b) !== JSON.stringify(a)) return b;
        }
        return NO_CHANGE;
      },
      (n) => `${pathStr(n.path)}: element moved`,
    ),
  }),
  netOp({
    id: 'HTM.array.empty', category: PAYLOAD, refs: [R], aliases: ['HTTPMutator:EAS'],
    intent: 'A non-empty array in the response is empty.',
    applicable: (ep) => epHas(ep, 'array'),
    handle: nodeOp((n) => Array.isArray(n.value) && n.value.length > 0, () => [], (n) => `${pathStr(n.path)}: emptied`),
  }),
  netOp({
    id: 'HTM.array.maxCardinality', category: PAYLOAD, refs: ['Offutt04'], aliases: ['Offutt04:DCP-α+'],
    intent: 'An array in the response has the maximum cardinality (elements repeated up to maxItems).',
    defaults: { maxItems: 50 },
    applicable: (ep) => epHas(ep, 'array'),
    handle: (ctx) =>
      nodeOp(
        (n) => Array.isArray(n.value) && n.value.length > 0 && n.value.length < Number(ctx.params.maxItems ?? 50),
        (a: Json[]) => Array.from({ length: Number(ctx.params.maxItems ?? 50) }, (_, i) => JSON.parse(JSON.stringify(a[i % a.length]))),
        (n, nv) => `${pathStr(n.path)}: ${(n.value as Json[]).length} -> ${(nv as Json[]).length} elements`,
      )(ctx),
  }),

  /* ------------------------------------------------------------ objects & leaves */
  netOp({
    id: 'HTM.object.remove', category: PAYLOAD, refs: [R, 'deMelo11'], aliases: ['HTTPMutator:OTPR', 'deMelo11:Incomplete'],
    intent: 'An object-valued property is missing from the response.',
    applicable: (ep) => epHas(ep, 'object'),
    handle: jsonOp((j, ctx) => {
      const n = choose(ctx, nodes(j).filter((x) => isProp(x) && kindOf(x.value) === 'object'), (c) => pathKey(c.path));
      if (!n) return null;
      deleteAt(j, n.path);
      return { value: j, detail: `object ${pathStr(n.path)} removed` };
    }),
  }),
  netOp({
    id: 'HTM.bool.reverse', category: PAYLOAD, refs: [R, 'Offutt04'], aliases: ['HTTPMutator:BPR', 'Offutt04:DVP-boolean'],
    intent: 'A boolean value in the response is negated.',
    applicable: (ep) => epHas(ep, 'boolean'),
    handle: leafOp('boolean', () => true, (v: boolean) => !v),
  }),
  netOp({
    id: 'HTM.value.null', category: PAYLOAD, refs: [R, 'deMelo11', 'Siblini05', 'RESTest'],
    aliases: ['HTTPMutator:NPS', 'deMelo11:Null', 'Siblini05:STEN', 'RESTest:sendNull'],
    intent: 'A value in the response is unexpectedly null.',
    applicable: json,
    handle: nodeOp((n) => isLeaf(n) && n.value !== null, () => null, (n) => `${pathStr(n.path)}: ${show(n.value)} -> null`),
  }),
  netOp({
    id: 'HTM.number.replace', category: PAYLOAD, refs: [R], aliases: ['HTTPMutator:NPR'],
    intent: 'A number in the response is replaced by another random number.',
    defaults: { min: -1000, max: 1000 },
    applicable: number,
    handle: numOp(() => true, (n, ctx) => {
      const min = Number(ctx.params.min ?? -1000);
      const max = Number(ctx.params.max ?? 1000);
      let v = n;
      for (let i = 0; i < 10 && v === n; i++) v = Math.floor(min + ctx.rand() * (max - min + 1));
      return v === n ? n + 1 : v;
    }),
  }),
  netOp({
    id: 'HTM.string.replace', category: PAYLOAD, refs: [R], aliases: ['HTTPMutator:SPR'],
    intent: 'A string in the response is replaced by a random string of the same length.',
    applicable: string,
    handle: leafOp('string', (s: string) => s.length > 0, (s: string, ctx) => randomString(ctx.rand, s.length, s)),
  }),
  netOp({
    id: 'HTM.string.specialChars', category: PAYLOAD, refs: [R], aliases: ['HTTPMutator:SCA'],
    intent: 'Special characters (/ \' " < & NUL emoji) are inserted into a string of the response.',
    defaults: { chars: "/'\"<&\u0000\u{1F600}" },
    applicable: string,
    handle: leafOp('string', () => true, (s: string, ctx) => {
      const at = Math.floor(ctx.rand() * (s.length + 1));
      return s.slice(0, at) + String(ctx.params.chars ?? "/'\"<&\u0000\u{1F600}") + s.slice(at);
    }),
  }),
  netOp({
    id: 'HTM.string.length', category: PAYLOAD, refs: [R, 'Offutt04', 'deMelo11'], aliases: ['HTTPMutator:SRE', 'Offutt04:DVP-string', 'deMelo11:Mod_Len'],
    intent: 'A string in the response is emptied, upper/lower-cased, extended tenfold or truncated.',
    defaults: { factor: 10 },
    applicable: string,
    handle: leafOp('string', (s: string) => s.length > 0, (s: string, ctx) => {
      const f = Number(ctx.params.factor ?? 10);
      const variants: [string, string][] = [
        ['empty', ''], ['upper', s.toUpperCase()], ['lower', s.toLowerCase()], ['extend', s.repeat(f)], ['truncate', s.slice(0, Math.floor(s.length / 2))],
      ];
      const ok = variants.filter(([, v]) => v !== s);
      const v = choose(ctx, ok, ([k]) => k, 'variant');
      return v ? v[1] : NO_CHANGE;
    }),
  }),

  /* ------------------------------------------------------------ whole body (Espinha14) */
  netOp({
    id: 'ESP.body.malformed', category: BODY, refs: ['Espinha14', 'RESTest', 'WireMock'],
    aliases: ['Espinha14:malformed', 'RESTest:notJson', 'WireMock:MALFORMED_RESPONSE_CHUNK'],
    intent: 'The response body is syntactically broken (its last character is missing).',
    applicable: (ep) => isTextCt(ep.contentType) || !!ep.json,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        if (!isTextCt(r.headers['content-type'])) return null;
        const text = r.body.toString('utf8');
        const nt = text.replace(/\S\s*$/, '');
        return nt === text ? null : { body: nt, detail: 'last character of the body dropped' };
      }),
  }),
  netOp({
    id: 'ESP.body.empty', category: BODY, refs: ['Espinha14'], aliases: ['Espinha14:emptyResponse'],
    intent: 'The response has the original status and headers but an empty body.',
    handle: (ctx) => respOp(ctx, (r) => (r.body.length ? { body: '', detail: `body emptied (${r.body.length} bytes)` } : null)),
  }),
  netOp({
    id: 'ESP.body.reformat', category: BODY, refs: ['Espinha14'], aliases: ['Espinha14:formattingDisruption'],
    intent: 'The JSON body is re-serialised with different whitespace (semantically equal).',
    applicable: json,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        if (!isJsonCt(r.headers['content-type'])) return null;
        const text = r.body.toString('utf8');
        let j: Json;
        try {
          j = JSON.parse(text);
        } catch {
          return null;
        }
        const nt = reformat(j);
        return nt === text ? null : { body: nt, detail: 'JSON body reformatted' };
      }),
  }),
  netOp({
    id: 'ESP.fields.removeMany', category: PAYLOAD, refs: ['Espinha14'], aliases: ['Espinha14:fieldRemoval'],
    intent: 'Several (k) properties are missing from the response at once.',
    defaults: { k: 3 },
    applicable: json,
    handle: jsonOp((j, ctx) => {
      const k = Number(ctx.params.k ?? 3);
      let cands = nodes(j).filter(isProp);
      if (!cands.length) return null;
      const chosen: JNode[] = [];
      const prev: string[] | undefined = ctx.state.paths;
      if (prev) for (const p of prev) { const c = cands.find((x) => pathKey(x.path) === p); if (c) chosen.push(c); }
      if (!chosen.length) {
        cands = [...cands];
        while (chosen.length < k && cands.length) chosen.push(cands.splice(Math.floor(ctx.rand() * cands.length), 1)[0]);
        if (!prev) ctx.state.paths = chosen.map((c) => pathKey(c.path));
      }
      // deepest (and, within an array, highest index) first; skip nodes inside removed ones
      chosen.sort((a, b) => b.path.length - a.path.length || String(b.path).localeCompare(String(a.path), undefined, { numeric: true }));
      const removed: Path[] = [];
      for (const c of chosen) {
        if (removed.some((r) => r.length < c.path.length && r.every((x, i) => x === c.path[i]))) continue;
        deleteAt(j, c.path);
        removed.push(c.path);
      }
      // a removed ancestor makes its descendants' removal implicit
      const shown = chosen.filter((c) => !chosen.some((o) => o !== c && o.path.length < c.path.length && o.path.every((x, i) => x === c.path[i])));
      return { value: j, detail: `${shown.length} field(s) removed: ${shown.map((c) => pathStr(c.path)).join(', ')}` };
    }),
  }),

  /* ------------------------------------------------------------ data perturbation (Offutt04, deMelo11) */
  netOp({
    id: 'DPT.number.divide', category: PAYLOAD, refs: ['Offutt04'], aliases: ['Offutt04:Divide'],
    intent: 'A number n in the response becomes 1/n.',
    applicable: number,
    handle: numOp((n) => n !== 0 && Math.abs(n) !== 1, (n) => 1 / n),
  }),
  netOp({
    id: 'DPT.number.square', category: PAYLOAD, refs: ['Offutt04'], aliases: ['Offutt04:Multiply'],
    intent: 'A number n in the response becomes n*n.',
    applicable: number,
    handle: numOp((n) => n !== 0 && n !== 1, (n) => n * n),
  }),
  netOp({
    id: 'DPT.number.negate', category: PAYLOAD, refs: ['Offutt04', 'RodriguezBaquero18'], aliases: ['Offutt04:Negative'],
    intent: 'A number n in the response becomes -n.',
    applicable: number,
    handle: numOp((n) => n !== 0, (n) => -n),
  }),
  netOp({
    id: 'DPT.number.abs', category: PAYLOAD, refs: ['Offutt04'], aliases: ['Offutt04:Absolute'],
    intent: 'A negative number in the response becomes its absolute value.',
    applicable: number,
    handle: numOp((n) => n < 0, (n) => Math.abs(n)),
  }),
  netOp({
    id: 'DPT.number.boundary', category: PAYLOAD, refs: ['Offutt04'], aliases: ['Offutt04:DVP-numeric'],
    intent: 'A number in the response is replaced by a boundary value (MAX_SAFE_INTEGER, MIN_SAFE_INTEGER or 0).',
    defaults: { values: [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0] },
    applicable: number,
    handle: numOp(() => true, (n, ctx) => {
      const vs = (ctx.params.values as number[]).map(Number).filter((v) => v !== n);
      return vs.length ? pick(ctx.rand, vs) : NO_CHANGE;
    }),
  }),
  netOp({
    id: 'DPT.number.beyondWidth', category: PAYLOAD, refs: ['RESTest'], aliases: ['RESTest:beyondItsWidth'],
    intent: 'A number in the response exceeds its type width (2^31 or 2^53+1, which loses precision).',
    defaults: { values: ['2147483648', '9007199254740993'] },
    applicable: number,
    handle: numOp(() => true, (n, ctx) => {
      const vs = (ctx.params.values as unknown[]).map(String).filter((v) => v !== String(n));
      return vs.length ? RAW_NUM + pick(ctx.rand, vs) : NO_CHANGE;
    }),
  }),
  netOp({
    id: 'DPT.fields.exchange', category: PAYLOAD, refs: ['Offutt04', 'Siblini05'], aliases: ['Offutt04:Exchange', 'Siblini05:STCE', 'Siblini05:STSE'],
    intent: 'The values of two sibling properties of the same type are swapped.',
    applicable: (ep) => isJsonEp(ep) && (!ep.json || (() => {
      const count: Record<string, number> = {};
      for (const t of Object.values(ep.json!.fields)) for (const x of t.split('|')) count[x] = (count[x] || 0) + 1;
      return Object.values(count).some((c) => c >= 2);
    })()),
    handle: jsonOp((j, ctx) => {
      const pairs: { obj: JNode; a: string; b: string }[] = [];
      for (const n of nodes(j)) {
        if (kindOf(n.value) !== 'object') continue;
        const es = Object.entries(n.value as Record<string, Json>);
        for (let x = 0; x < es.length; x++)
          for (let y = x + 1; y < es.length; y++)
            if (kindOf(es[x][1]) === kindOf(es[y][1]) && JSON.stringify(es[x][1]) !== JSON.stringify(es[y][1])) pairs.push({ obj: n, a: es[x][0], b: es[y][0] });
      }
      const p = choose(ctx, pairs, (c) => pathKey([...c.obj.path, c.a, c.b]));
      if (!p) return null;
      const o = p.obj.value as Record<string, Json>;
      [o[p.a], o[p.b]] = [o[p.b], o[p.a]];
      return { value: j, detail: `${pathStr([...p.obj.path, p.a])} <-> ${pathStr([...p.obj.path, p.b])}` };
    }),
  }),
  netOp({
    id: 'DPT.values.invert', category: PAYLOAD, refs: ['deMelo11'], aliases: ['deMelo11:ValueInversion'],
    intent: "The values of an object's properties appear in reverse order (keys kept).",
    applicable: json,
    handle: jsonOp((j, ctx) => {
      const objs = nodes(j).filter((n) => {
        if (kindOf(n.value) !== 'object') return false;
        const vs = Object.values(n.value as Record<string, Json>).map((v) => JSON.stringify(v));
        return vs.length >= 2 && vs.join('\u0001') !== [...vs].reverse().join('\u0001');
      });
      const n = choose(ctx, objs, (c) => pathKey(c.path));
      if (!n) return null;
      const o = n.value as Record<string, Json>;
      const keys = Object.keys(o);
      const vals = keys.map((k) => o[k]).reverse();
      keys.forEach((k, i) => (o[k] = vals[i]));
      return { value: j, detail: `values of ${pathStr(n.path)} inverted` };
    }),
  }),
  netOp({
    id: 'DPT.value.space', category: PAYLOAD, refs: ['deMelo11'], aliases: ['deMelo11:Space'],
    intent: 'A string in the response is a single blank.',
    applicable: string,
    handle: leafOp('string', (s: string) => s !== ' ', () => ' '),
  }),

  /* ------------------------------------------------------------ body shape */
  netOp({
    id: 'NBD.body.null', category: BODY, refs: ['LinaresVasquez17'], aliases: ['LinaresVasquez17:NullBackEndServiceReturn'],
    intent: 'The back-end service returns a null JSON body.',
    applicable: json,
    handle: jsonOp((j) => (j === null ? null : { value: null, detail: 'body -> null' })),
  }),
  netOp({
    id: 'NBD.body.wrongRoot', category: BODY, refs: ['RESTest'], aliases: ['RESTest:wrongRoot'],
    intent: 'The JSON root has the wrong type (an object wrapped in an array, an array wrapped in an object).',
    applicable: json,
    handle: jsonOp((j) => {
      if (Array.isArray(j)) return { value: { data: j }, detail: 'array root wrapped in {data: [...]}' };
      if (kindOf(j) === 'object') return { value: [j], detail: 'object root wrapped in [...]' };
      return null;
    }),
  }),
  netOp({
    id: 'NBD.body.truncate', category: BODY, refs: ['Toxiproxy'], aliases: ['Toxiproxy:limit_data'],
    intent: 'The response body is cut after a few bytes.',
    defaults: { bytes: 64 },
    applicable: (ep) => isTextCt(ep.contentType) || !!ep.json,
    handle: (ctx) =>
      respOp(ctx, (r) => {
        const n = Number(ctx.params.bytes ?? 64);
        if (!isTextCt(r.headers['content-type']) || r.body.length <= n) return null;
        return { body: r.body.subarray(0, n), detail: `body truncated ${r.body.length} -> ${n} bytes` };
      }),
  }),
  netOp({
    id: 'NBD.response.swap', category: BODY, refs: ['Siblini05'], aliases: ['Siblini05:SPM'],
    intent: 'The endpoint answers with the response of another JSON endpoint (mixed-up responses).',
    observeAll: true,
    applicable: json,
    handle: async (ctx) => {
      if (!ctx.matches(ctx.request)) {
        const req = ctx.request;
        req
          .response()
          .then(async (r) => {
            if (!r || !isJsonCt(r.headers()['content-type'])) return;
            const body = await r.body();
            ctx.state.other = { headers: r.headers(), body, url: req.url() };
          })
          .catch(() => undefined);
        return ctx.route.fallback();
      }
      const other = ctx.state.other as { headers: Record<string, string>; body: Buffer; url: string } | undefined;
      if (!other) return ctx.route.fallback();
      const r = await ctx.route.fetch(); // the server still processes the request
      ctx.applied(`response replaced by the one of ${other.url}`);
      return ctx.route.fulfill({ status: r.status(), headers: strippedHeaders(other.headers), body: other.body });
    },
  }),
  netOp({
    id: 'GQL.errors.inject', category: BODY, refs: ['HTTPMutator'], aliases: [],
    intent: 'A GraphQL-style response carries an error entry and a null data field.',
    defaults: { message: 'mlmt injected error' },
    applicable: (ep) => isJsonEp(ep) && (!ep.json || 'data' in ep.json.fields),
    handle: jsonOp((j, ctx) => {
      if (kindOf(j) !== 'object' || !('data' in (j as object))) return null;
      const o = j as Record<string, any>;
      const errs = Array.isArray(o.errors) ? o.errors : [];
      o.errors = [...errs, { message: String(ctx.params.message ?? 'mlmt injected error') }];
      let nulled = '';
      if (kindOf(o.data) === 'object') {
        const k = choose(ctx, Object.keys(o.data).filter((x) => o.data[x] !== null), (x) => x);
        if (k !== undefined) {
          o.data[k] = null;
          nulled = `, data.${k} -> null`;
        }
      }
      return { value: o, detail: `errors injected${nulled}` };
    }),
  }),

  /* ------------------------------------------------------------ connection faults */
  netOp({
    id: 'NCF.abort.reset', category: FAULT, refs: ['Toxiproxy', 'Heorhiadi16', 'WireMock'],
    aliases: ['Toxiproxy:reset_peer', 'Gremlin:Crash', 'WireMock:CONNECTION_RESET_BY_PEER'],
    intent: 'The connection is reset by the peer.',
    handle: abortOp('connectionreset'),
  }),
  netOp({
    id: 'NCF.abort.refused', category: FAULT, refs: ['Toxiproxy'], aliases: ['Toxiproxy:down'],
    intent: 'The server refuses the connection (service down).',
    handle: abortOp('connectionrefused'),
  }),
  netOp({
    id: 'NCF.abort.dns', category: FAULT, refs: ['Playwright'], aliases: ['Playwright:namenotresolved'],
    intent: 'The host name cannot be resolved.',
    handle: abortOp('namenotresolved'),
  }),
  netOp({
    id: 'NCF.abort.failed', category: FAULT, refs: ['Playwright'], aliases: ['Cypress:forceNetworkError', 'MSW:HttpResponse.error'],
    intent: 'The request fails with a generic network error.',
    handle: abortOp('failed'),
  }),
  netOp({
    id: 'NCF.abort.afterServer', category: FAULT, refs: ['Meiklejohn21'], aliases: ['Filibuster:ConnectionErrorAfterCall'],
    intent: 'The connection fails after the server has processed the request (side effect done, response lost).',
    handle: async (ctx) => {
      await ctx.route.fetch();
      ctx.applied('server reached, then aborted (connectionfailed)');
      return ctx.route.abort('connectionfailed');
    },
  }),
  netOp({
    id: 'NCF.abort.probabilistic', category: FAULT, refs: ['Heorhiadi16'], aliases: ['Gremlin:Crash(probabilistic)'],
    intent: 'Requests fail transiently with probability p.',
    defaults: { p: 0.5, errorCode: 'failed' },
    handle: async (ctx) => {
      if (ctx.rand() < Number(ctx.params.p ?? 0.5)) {
        const code = String(ctx.params.errorCode ?? 'failed');
        ctx.applied(`aborted (${code})`);
        return ctx.route.abort(code);
      }
      return ctx.route.fallback();
    },
  }),
  netOp({
    id: 'NCF.overload', category: FAULT, refs: ['Heorhiadi16'], aliases: ['Gremlin:Overload'],
    intent: 'An overloaded service rejects some requests (503) and slows down the others.',
    defaults: { p: 0.25, status: 503, delayMs: 100 },
    handle: async (ctx) => {
      if (ctx.rand() < Number(ctx.params.p ?? 0.25)) {
        const status = Number(ctx.params.status ?? 503);
        ctx.applied(`rejected with ${status}`);
        return ctx.route.fulfill({ status, contentType: 'text/plain', body: 'Service Unavailable (MultilayerMT)' });
      }
      const ms = Number(ctx.params.delayMs ?? 100);
      await sleep(ms);
      ctx.applied(`delayed ${ms}ms`);
      return ctx.route.fallback();
    },
  }),
  netOp({
    id: 'NCF.offline', category: FAULT, refs: ['Playwright'], aliases: ['Playwright:setOffline'],
    intent: 'The client goes offline after the first request of the endpoint.',
    observeAll: true,
    handle: async (ctx) => {
      if (ctx.state.offline) {
        ctx.applied(`offline: ${ctx.request.method()} ${ctx.request.url()} aborted`);
        return ctx.route.abort('internetdisconnected');
      }
      if (ctx.matches(ctx.request)) ctx.state.offline = true;
      return ctx.route.fallback();
    },
  }),

  /* ------------------------------------------------------------ latency */
  netOp({
    id: 'NLD.delay.lognormal', category: LATENCY, refs: ['WireMock'], aliases: ['WireMock:LogNormalDelay'],
    intent: 'Responses are delayed by a long-tailed (lognormal) latency.',
    defaults: { medianMs: 500, sigma: 0.6, capMs: 10000 },
    handle: async (ctx) => {
      const u1 = 1 - ctx.rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * ctx.rand());
      const ms = Math.round(Math.min(Number(ctx.params.capMs ?? 10000), Number(ctx.params.medianMs ?? 500) * Math.exp(Number(ctx.params.sigma ?? 0.6) * z)));
      await sleep(ms);
      ctx.applied(`delayed ${ms}ms (lognormal)`);
      return ctx.route.fallback();
    },
  }),
  netOp({
    id: 'NLD.timeout.afterWait', category: LATENCY, refs: ['Meiklejohn21'], aliases: ['Filibuster:TimeoutAfterWait'],
    intent: 'The request times out after a long wait.',
    defaults: { waitMs: 5000 },
    handle: async (ctx) => {
      const ms = Number(ctx.params.waitMs ?? 5000);
      await sleep(ms);
      ctx.applied(`aborted (timedout) after ${ms}ms`);
      return ctx.route.abort('timedout');
    },
  }),
  netOp({
    id: 'NRC.response.postpone', category: ORDER, refs: ['Adamsen18'], aliases: ['AjaxRacer:postpone'],
    intent: "The endpoint's responses arrive after concurrently pending responses (AJAX event race).",
    defaults: { quietMs: 50, maxHoldMs: 3000 },
    observeAll: true,
    applicable: (ep) => ep.resourceType === 'xhr' || ep.resourceType === 'fetch',
    handle: async (ctx) => {
      const s = ctx.state;
      s.inflight ??= 0;
      s.done ??= 0;
      s.lastBusy ??= 0;
      if (!ctx.matches(ctx.request)) {
        s.inflight++;
        let once = false;
        const fin = () => {
          if (once) return;
          once = true;
          s.inflight--;
          s.done++;
          s.lastBusy = Date.now();
        };
        ctx.request.response().then((r) => (r ? r.finished() : null)).then(fin, fin);
        return ctx.route.fallback();
      }
      const r = await ctx.route.fetch();
      const start = Date.now();
      const done0 = s.done;
      const quiet = Number(ctx.params.quietMs ?? 50);
      const maxHold = Number(ctx.params.maxHoldMs ?? 3000);
      while (Date.now() - start < maxHold) {
        if (s.inflight <= 0 && Date.now() - Math.max(s.lastBusy, start) >= quiet) break;
        await sleep(10);
      }
      const overtook = s.done - done0;
      if (overtook > 0) ctx.applied(`response held ${Date.now() - start}ms; ${overtook} response(s) overtook it`);
      return ctx.route.fulfill({ response: r });
    },
  }),

  /* ------------------------------------------------------------ request side */
  netOp({
    id: 'NRQ.method.swap', category: REQUEST, refs: ['Praphamontripong10', 'Mirshokraie15', 'ChaosMesh'],
    aliases: ['Praphamontripong10:WTR', 'Mirshokraie15:XHR-1', 'ChaosMesh:replace.method'],
    intent: 'The request is sent with the wrong HTTP method (GET <-> POST).',
    applicable: (ep) => ['GET', 'POST'].includes(ep.method.toUpperCase()),
    handle: async (ctx) => {
      const m = ctx.request.method().toUpperCase();
      if (m !== 'GET' && m !== 'POST') return ctx.route.fallback();
      const to = m === 'GET' ? 'POST' : 'GET';
      ctx.applied(`method ${m} -> ${to}`);
      return ctx.route.continue({ method: to });
    },
  }),
  netOp({
    id: 'NRQ.url.mutate', category: REQUEST, refs: ['LinaresVasquez17', 'ChaosMesh'], aliases: ['LinaresVasquez17:InvalidURI', 'ChaosMesh:replace.path'],
    intent: 'The request targets a wrong URL (last path segment altered).',
    defaults: { suffix: '_mut' },
    applicable: (ep) => /\/[^/]+\/?$/.test(new URL(ep.url).pathname),
    handle: async (ctx) => {
      const u = new URL(ctx.request.url());
      const m = /([^/]+)(\/?)$/.exec(u.pathname);
      if (!m) return ctx.route.fallback();
      u.pathname = u.pathname.slice(0, m.index) + m[1] + String(ctx.params.suffix ?? '_mut') + m[2];
      ctx.applied(`url -> ${u.pathname}`);
      return ctx.route.continue({ url: u.href });
    },
  }),
  netOp({
    id: 'NRQ.query.drop', category: REQUEST, refs: ['RESTest', 'ChaosMesh'], aliases: ['RESTest:dropRequired', 'ChaosMesh:replace.queries'],
    intent: 'A query parameter is missing from the request.',
    applicable: (ep) => new URL(ep.url).search.length > 1,
    handle: async (ctx) => {
      const u = new URL(ctx.request.url());
      const name = choose(ctx, [...new Set([...u.searchParams.keys()])], (x) => x);
      if (name === undefined) return ctx.route.fallback();
      u.searchParams.delete(name);
      ctx.applied(`query parameter ${name} dropped`);
      return ctx.route.continue({ url: u.href });
    },
  }),
  netOp({
    id: 'NRQ.body.dropField', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:dropRequired'],
    intent: 'A field is missing from the request body (JSON or form).',
    applicable: hasBodyMethod,
    handle: reqFieldOp({ json: () => true, form: () => true }),
  }),
  netOp({
    id: 'NRQ.body.wrongType', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:wrongType'],
    intent: 'A request field has a value of the wrong type.',
    applicable: hasBodyMethod,
    handle: reqFieldOp({
      json: () => true,
      jsonValue: (v) => (typeof v === 'string' ? 1.5 : typeof v === 'number' ? 'abc' : kindOf(v) === 'object' ? 'abc' : {}),
      form: () => true,
      formValue: (v) => (/^-?\d+(\.\d+)?$/.test(v) ? 'abc' : '1.5'),
    }),
  }),
  netOp({
    id: 'NRQ.body.null', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:sendNull'],
    intent: 'A JSON request field is null.',
    applicable: hasBodyMethod,
    handle: reqFieldOp({ json: (n) => n.value !== null, jsonValue: () => null }),
  }),
  netOp({
    id: 'NRQ.body.empty', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:sendEmpty', 'RESTest:emptyBody'],
    intent: 'A request field (or the whole unparseable body) is empty.',
    applicable: hasBodyMethod,
    handle: reqFieldOp({
      json: (n) => n.value !== '',
      jsonValue: () => '',
      form: (v) => v !== '',
      formValue: () => '',
      raw: () => '',
    }),
  }),
  netOp({
    id: 'NRQ.body.oversize', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:oversize'],
    intent: 'A string field of the request is far longer than expected.',
    defaults: { length: 10000 },
    applicable: hasBodyMethod,
    handle: (ctx) => {
      const big = 'A'.repeat(Number(ctx.params.length ?? 10000));
      return reqFieldOp({ json: (n) => typeof n.value === 'string' && n.value !== big, jsonValue: () => big, form: (v) => v !== big, formValue: () => big })(ctx);
    },
  }),
  netOp({
    id: 'NRQ.body.notJson', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:notJson'],
    intent: 'The JSON request body is syntactically invalid (truncated in the middle).',
    applicable: hasBodyMethod,
    handle: async (ctx) => {
      const b = parseReqBody(ctx.request);
      if (b?.kind !== 'json' || b.text.length < 2) return ctx.route.fallback();
      const postData = b.text.slice(0, Math.floor(b.text.length / 2));
      ctx.applied(`JSON request body truncated ${b.text.length} -> ${postData.length} chars`);
      return ctx.route.continue({ postData });
    },
  }),
  netOp({
    id: 'NRQ.contentType.wrong', category: REQUEST, refs: ['RESTest'], aliases: ['RESTest:wrongContentType'],
    intent: 'The request body is sent with a wrong Content-Type.',
    defaults: { contentType: 'text/plain' },
    applicable: hasBodyMethod,
    handle: async (ctx) => {
      const to = String(ctx.params.contentType ?? 'text/plain');
      const headers = { ...ctx.request.headers() };
      const k = headerKey(headers, 'content-type');
      const cur = k ? headers[k] : undefined;
      if (!ctx.request.postDataBuffer()?.length || (cur && cur.split(';')[0].trim().toLowerCase() === to.toLowerCase())) return ctx.route.fallback();
      if (k) delete headers[k];
      headers['content-type'] = to;
      ctx.applied(`request content-type ${cur ?? '(none)'} -> ${to}`);
      return ctx.route.continue({ headers });
    },
  }),
  netOp({
    id: 'NRQ.body.sqlTautology', category: REQUEST, refs: ['Offutt04'], aliases: ['Offutt04:Unauthorized'],
    intent: 'A request string field carries an SQL tautology (injection attempt).',
    defaults: { payload: "' OR '1'='1" },
    applicable: hasBodyMethod,
    handle: (ctx) => {
      const p = String(ctx.params.payload ?? "' OR '1'='1");
      return reqFieldOp({ json: (n) => typeof n.value === 'string', jsonValue: (v) => `${v}${p}`, form: () => true, formValue: (v) => `${v}${p}` })(ctx);
    },
  }),

  /* ------------------------------------------------------------ cookies */
  netOp({
    id: 'NRQ.cookie.drop', category: COOKIE, refs: ['Praphamontripong17', 'Hammoudi16'], aliases: ['Praphamontripong17:WSIR', 'Hammoudi16:session'],
    intent: 'The request is sent without its cookies (session lost).',
    handle: async (ctx) => {
      const cs = await cookiesFor(ctx.request);
      if (!cs.length) return ctx.route.fallback();
      const r = await nodeFetch(ctx.request, { sendCookies: false });
      ctx.applied(`request sent without cookies (${cs.map((c) => c.name).join(', ')})`);
      return fulfillNode(ctx, r, r.setCookies);
    },
  }),
  netOp({
    id: 'NRS.setCookie.drop', category: COOKIE, refs: ['Praphamontripong17'], aliases: ['Praphamontripong17:WSIR'],
    intent: 'The response does not set its cookies (session never established or updated).',
    handle: setCookieOp(() => null, 'dropped'),
  }),
  netOp({
    id: 'SEC.cookie.insecure', category: COOKIE, refs: ['Loise17'], aliases: ['Loise17:UC'],
    intent: 'Cookies are set without the Secure attribute.',
    handle: setCookieOp(stripCookieAttr('secure'), 'Secure removed'),
  }),
  netOp({
    id: 'SEC.cookie.noHttpOnly', category: COOKIE, refs: ['Loise17'], aliases: ['Loise17:RHTTPOFC'],
    intent: 'Cookies are set without the HttpOnly attribute (readable from scripts).',
    handle: setCookieOp(stripCookieAttr('httponly'), 'HttpOnly removed'),
  }),
] as NetworkOperatorDef[];
