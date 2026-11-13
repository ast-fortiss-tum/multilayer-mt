import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { applyNetworkMutation, registry } from '../src/index';
import type { NetworkOperatorDef } from '../src/index';
import { NETWORK_LIT_OPERATORS } from '../src/operators/lit/network';

/* ------------------------------------------------------------ fixtures */

const PAGE = `<!doctype html><html><body><p>lit network</p><script>
window.F = async (u, o) => {
  try { const r = await fetch(u, o); const text = await r.text(); return { status: r.status, ct: r.headers.get('content-type'), text, url: r.url }; }
  catch (e) { return { error: String(e) }; }
};
window.X = (u) => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', u); x.onload = () => res({ status: x.status, text: x.responseText }); x.onerror = () => res({ error: 'xhr error' }); x.send(); });
</script></body></html>`;

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
let received: Received[] = [];
let server: http.Server;
let base = '';
let browser: Browser;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (u.pathname.startsWith('/api/sink')) {
        received.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      if (u.pathname === '/api/r') {
        const q = u.searchParams;
        const headers: http.OutgoingHttpHeaders = {};
        if (q.get('ct') !== '') headers['content-type'] = q.get('ct') ?? 'application/json';
        if (q.has('location')) headers.location = q.get('location')!;
        if (q.getAll('setcookie').length) headers['set-cookie'] = q.getAll('setcookie');
        const send = () => {
          res.writeHead(Number(q.get('status') ?? 200), headers);
          res.end(q.get('body') ?? '{}');
        };
        return q.has('delay') ? setTimeout(send, Number(q.get('delay'))) : send();
      }
      if (u.pathname === '/api/other') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"other":true}');
      }
      if (u.pathname === '/api/slow') {
        return setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"slow":true}');
        }, Number(u.searchParams.get('ms') ?? 300));
      }
      if (u.pathname.startsWith('/target')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('target:' + u.pathname);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as any).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  server.close();
});

type FRes = { status: number; ct: string | null; text: string; url: string; error?: string };

/** Run `fn` on a fresh page with mutant `operator` injected on endpoint `path`. */
async function run<T>(
  operator: string,
  path: string,
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  o: { method?: string; params?: Record<string, unknown>; seed?: number; before?: (c: BrowserContext) => Promise<void> } = {},
): Promise<{ r: T; applied: string[] }> {
  const context = await browser.newContext();
  try {
    if (o.before) await o.before(context);
    const h = await applyNetworkMutation(context, { operator, url: base + path, method: o.method, params: o.params, seed: o.seed });
    const page = await context.newPage();
    await page.goto(base + '/');
    const r = await fn(page, context);
    return { r, applied: h.applied() };
  } finally {
    await context.close();
  }
}

const F = (page: Page, url: string, init?: Record<string, unknown>) => page.evaluate(([u, i]) => (window as any).F(u, i), [url, init] as const) as Promise<FRes>;
const R = (q: Record<string, string | number>) => '/api/r?' + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
const J = (obj: unknown, extra: Record<string, string | number> = {}) => R({ body: JSON.stringify(obj), ...extra });

/** Fetch JSON `obj` from /api/r through mutant `op`. */
async function mutJson(op: string, obj: unknown, params?: Record<string, unknown>, seed?: number) {
  const { r, applied } = await run(op, '/api/r', (p) => F(p, J(obj)), { params, seed });
  let json: any;
  try {
    json = JSON.parse(r.text);
  } catch {
    json = undefined;
  }
  return { res: r, json, applied };
}

/** POST `body` to /api/sink through mutant `op`; returns what the server received. */
async function mutRequest(op: string, body: string, ct: string, params?: Record<string, unknown>) {
  received = [];
  const { applied } = await run(op, '/api/sink', (p) => F(p, '/api/sink', { method: 'POST', body, headers: { 'content-type': ct } }), { method: 'POST', params });
  assert.equal(received.length, 1);
  return { got: received[0], applied };
}

/* ------------------------------------------------------------ catalogue */

const IDS = `HTM.status.success HTM.status.client HTM.status.server HTM.contentType.change HTM.contentType.delete HTM.charset.change
HTM.charset.delete HTM.location.change HTM.location.delete HTM.array.add HTM.array.remove HTM.array.exchange HTM.array.empty
HTM.array.maxCardinality HTM.object.remove HTM.bool.reverse HTM.value.null HTM.number.replace HTM.string.replace HTM.string.specialChars
HTM.string.length ESP.body.malformed ESP.body.empty ESP.body.reformat ESP.fields.removeMany DPT.number.divide DPT.number.square
DPT.number.negate DPT.number.abs DPT.number.boundary DPT.number.beyondWidth DPT.fields.exchange DPT.values.invert DPT.value.space
NBD.body.null NBD.body.wrongRoot NBD.body.truncate NBD.response.swap GQL.errors.inject NCF.abort.reset NCF.abort.refused NCF.abort.dns
NCF.abort.failed NCF.abort.afterServer NCF.abort.probabilistic NCF.overload NCF.offline NLD.delay.lognormal NLD.timeout.afterWait
NRC.response.postpone NRQ.method.swap NRQ.url.mutate NRQ.query.drop NRQ.body.dropField NRQ.body.wrongType NRQ.body.null NRQ.body.empty
NRQ.body.oversize NRQ.body.notJson NRQ.contentType.wrong NRQ.body.sqlTautology NRQ.cookie.drop NRS.setCookie.drop SEC.cookie.insecure
SEC.cookie.noHttpOnly`.split(/\s+/);

describe('catalogue', () => {
  test('all Batch D operators are registered with metadata', () => {
    assert.deepEqual(NETWORK_LIT_OPERATORS.map((o) => o.id).sort(), [...IDS].sort());
    for (const id of IDS) {
      const d = registry.get(id) as NetworkOperatorDef;
      assert.equal(d.layer, 'network', id);
      assert.equal(d.set, 'literature', id);
      assert.ok(d.intent && d.category && Array.isArray(d.refs) && Array.isArray(d.aliases), id);
      assert.equal(typeof d.handle, 'function', id);
    }
  });

  test('applicable pre-checks', () => {
    const ep = (o: Partial<any>) => ({ method: 'GET', url: base + '/api/r', resourceType: 'fetch', status: 200, contentType: 'application/json', ...o });
    const ap = (id: string, e: any) => {
      const d = registry.get(id) as NetworkOperatorDef;
      return d.applicable ? d.applicable(e, d.defaults) : true;
    };
    const shape = (fields: Record<string, string>, hasArray = false, maxArrayLength = 0) => ({ fields, samples: {}, hasArray, maxArrayLength });
    assert.equal(ap('HTM.status.success', ep({})), false);
    assert.equal(ap('HTM.status.success', ep({ status: 404 })), true);
    assert.equal(ap('HTM.charset.delete', ep({})), false);
    assert.equal(ap('HTM.charset.delete', ep({ contentType: 'text/html; charset=utf-8' })), true);
    assert.equal(ap('HTM.contentType.delete', ep({ contentType: '' })), false);
    assert.equal(ap('HTM.location.change', ep({})), false);
    assert.equal(ap('HTM.location.change', ep({ status: 302 })), true);
    assert.equal(ap('HTM.location.change', ep({ resourceType: 'document' })), true);
    assert.equal(ap('HTM.bool.reverse', ep({ json: shape({ a: 'number' }) })), false);
    assert.equal(ap('HTM.bool.reverse', ep({ json: shape({ a: 'boolean' }) })), true);
    assert.equal(ap('HTM.array.empty', ep({ json: shape({ a: 'number' }) })), false);
    assert.equal(ap('HTM.array.exchange', ep({ json: shape({ a: 'array' }, true, 1) })), false);
    assert.equal(ap('DPT.number.negate', ep({ contentType: 'text/html' })), false);
    assert.equal(ap('DPT.fields.exchange', ep({ json: shape({ a: 'number', b: 'string' }) })), false);
    assert.equal(ap('GQL.errors.inject', ep({ json: shape({ a: 'number' }) })), false);
    assert.equal(ap('NRQ.query.drop', ep({})), false);
    assert.equal(ap('NRQ.query.drop', ep({ url: base + '/api/r?a=1' })), true);
    assert.equal(ap('NRQ.body.null', ep({})), false);
    assert.equal(ap('NRQ.body.null', ep({ method: 'POST' })), true);
    assert.equal(ap('NRC.response.postpone', ep({ resourceType: 'document' })), false);
  });
});

/* ------------------------------------------------------------ status & headers */

describe('status and headers', () => {
  test('HTM.status.success', async () => {
    const { r, applied } = await run('HTM.status.success', '/api/r', (p) => F(p, R({ status: 404, body: 'nf' })));
    assert.equal(r.status, 200);
    assert.equal(r.text, 'nf');
    assert.equal(applied.length, 1);
    const ok = await run('HTM.status.success', '/api/r', (p) => F(p, R({ status: 200 })));
    assert.deepEqual(ok.applied, []);
  });

  test('HTM.status.client / HTM.status.server (deterministic per seed)', async () => {
    const c = await run('HTM.status.client', '/api/r', (p) => F(p, R({ body: 'b' })), { seed: 7 });
    assert.ok([400, 401, 403, 404, 409].includes(c.r.status));
    assert.equal(c.r.text, 'b');
    const c2 = await run('HTM.status.client', '/api/r', (p) => F(p, R({ body: 'b' })), { seed: 7 });
    assert.equal(c2.r.status, c.r.status);
    const s = await run('HTM.status.server', '/api/r', (p) => F(p, R({ status: 500 })));
    assert.ok([501, 502, 503, 504].includes(s.r.status), String(s.r.status));
    assert.equal(s.applied.length, 1);
  });

  test('HTM.contentType.change', async () => {
    const j = await run('HTM.contentType.change', '/api/r', (p) => F(p, R({})));
    assert.match(j.r.ct!, /^text\/plain/);
    const h = await run('HTM.contentType.change', '/api/r', (p) => F(p, R({ ct: 'text/html; charset=utf-8' })));
    assert.equal(h.r.ct, 'text/plain; charset=utf-8');
    assert.equal(h.applied.length, 1);
  });

  test('HTM.contentType.delete', async () => {
    const { r, applied } = await run('HTM.contentType.delete', '/api/r', (p) => F(p, R({})));
    assert.equal(r.ct, null);
    assert.equal(applied.length, 1);
    const none = await run('HTM.contentType.delete', '/api/r', (p) => F(p, R({ ct: '' })));
    assert.deepEqual(none.applied, []);
  });

  test('HTM.charset.change garbles XHR text', async () => {
    const url = R({ ct: 'text/plain; charset=utf-8', body: 'hello' });
    const { r, applied } = await run('HTM.charset.change', '/api/r', (p) => p.evaluate((u) => (window as any).X(u), url));
    assert.notEqual(r.text, 'hello');
    assert.match(applied[0], /UTF-16/);
  });

  test('HTM.charset.delete', async () => {
    const { r, applied } = await run('HTM.charset.delete', '/api/r', (p) => F(p, R({ ct: 'text/plain; charset=utf-8', body: 'x' })));
    assert.equal(r.ct, 'text/plain');
    assert.equal(applied.length, 1);
  });

  test('HTM.location.change / HTM.location.delete', async () => {
    const url = R({ status: 302, location: '/target', ct: 'text/plain', body: '' });
    const c = await run('HTM.location.change', '/api/r', (p) => F(p, url));
    assert.match(c.r.url, /\/target\/\d+$/);
    assert.match(c.r.text, /^target:\/target\/\d+$/);
    assert.equal(c.applied.length, 1);
    const d = await run('HTM.location.delete', '/api/r', (p) => F(p, url));
    assert.equal(d.r.status, 302);
    assert.match(d.r.url, /\/api\/r\?/);
    const none = await run('HTM.location.delete', '/api/r', (p) => F(p, R({})));
    assert.deepEqual(none.applied, []);
  });
});

/* ------------------------------------------------------------ JSON payload */

describe('JSON payload', () => {
  test('HTM.array.add / remove / empty / maxCardinality', async () => {
    let m = await mutJson('HTM.array.add', { tags: ['a', 'b'] });
    assert.deepEqual(m.json.tags, ['a', 'b', 'b']);
    m = await mutJson('HTM.array.remove', { tags: ['a', 'b'] });
    assert.equal(m.json.tags.length, 1);
    m = await mutJson('HTM.array.empty', { tags: ['a', 'b'] });
    assert.deepEqual(m.json.tags, []);
    m = await mutJson('HTM.array.maxCardinality', { tags: ['a', 'b'] });
    assert.equal(m.json.tags.length, 50);
    assert.equal(m.json.tags[49], 'b');
    m = await mutJson('HTM.array.empty', { tags: [] });
    assert.deepEqual(m.applied, []);
  });

  test('HTM.array.exchange', async () => {
    const m = await mutJson('HTM.array.exchange', { tags: ['a', 'b', 'c'] });
    assert.notDeepEqual(m.json.tags, ['a', 'b', 'c']);
    assert.deepEqual([...m.json.tags].sort(), ['a', 'b', 'c']);
    const same = await mutJson('HTM.array.exchange', { tags: ['a', 'a'] });
    assert.deepEqual(same.applied, []);
  });

  test('HTM.object.remove', async () => {
    const m = await mutJson('HTM.object.remove', { owner: { login: 'u' }, id: 1 });
    assert.deepEqual(m.json, { id: 1 });
  });

  test('HTM.bool.reverse / HTM.value.null', async () => {
    assert.deepEqual((await mutJson('HTM.bool.reverse', { a: true, b: 1 })).json, { a: false, b: 1 });
    assert.deepEqual((await mutJson('HTM.value.null', { a: 'x' })).json, { a: null });
    assert.deepEqual((await mutJson('HTM.bool.reverse', { b: 1 })).applied, []);
  });

  test('HTM.number.replace', async () => {
    const m = await mutJson('HTM.number.replace', { n: 5 });
    assert.notEqual(m.json.n, 5);
    assert.ok(Number.isInteger(m.json.n) && m.json.n >= -1000 && m.json.n <= 1000);
  });

  test('HTM.string.replace / specialChars / length', async () => {
    let m = await mutJson('HTM.string.replace', { s: 'hello' });
    assert.equal(m.json.s.length, 5);
    assert.notEqual(m.json.s, 'hello');
    m = await mutJson('HTM.string.specialChars', { s: 'hello' });
    assert.ok(m.json.s.includes('<&') && m.json.s.includes('\u0000'));
    assert.equal(m.json.s.replace("/'\"<&\u0000\u{1F600}", ''), 'hello');
    m = await mutJson('HTM.string.length', { s: 'Hello' });
    assert.ok(['', 'HELLO', 'hello', 'Hello'.repeat(10), 'He'].includes(m.json.s), m.json.s);
  });

  test('ESP.body.malformed / empty / reformat', async () => {
    const obj = { a: 1, b: [1, 2] };
    let m = await mutJson('ESP.body.malformed', obj);
    assert.equal(m.json, undefined);
    assert.equal(m.res.text, JSON.stringify(obj).slice(0, -1));
    const e = await run('ESP.body.empty', '/api/r', (p) => F(p, J(obj, { status: 201 })));
    assert.equal(e.r.text, '');
    assert.equal(e.r.status, 201);
    m = await mutJson('ESP.body.reformat', obj);
    assert.notEqual(m.res.text, JSON.stringify(obj));
    assert.match(m.res.text, /\n/);
    assert.deepEqual(m.json, obj);
  });

  test('ESP.fields.removeMany', async () => {
    const m = await mutJson('ESP.fields.removeMany', { a: 1, b: 2, c: 3, d: 4 });
    assert.equal(Object.keys(m.json).length, 1);
    assert.match(m.applied[0], /^3 field/);
  });

  test('DPT.number.*', async () => {
    assert.equal((await mutJson('DPT.number.divide', { n: 4 })).json.n, 0.25);
    assert.equal((await mutJson('DPT.number.square', { n: 3 })).json.n, 9);
    assert.equal((await mutJson('DPT.number.negate', { n: 3 })).json.n, -3);
    assert.equal((await mutJson('DPT.number.abs', { n: -3 })).json.n, 3);
    assert.deepEqual((await mutJson('DPT.number.abs', { n: 3 })).applied, []);
    const b = await mutJson('DPT.number.boundary', { n: 5 });
    assert.ok([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0].includes(b.json.n));
    const w = await mutJson('DPT.number.beyondWidth', { n: 5 });
    assert.match(w.res.text, /^\{"n":(2147483648|9007199254740993)\}$/);
  });

  test('DPT.fields.exchange / values.invert / value.space', async () => {
    assert.deepEqual((await mutJson('DPT.fields.exchange', { a: 1, b: 2, s: 'x' })).json, { a: 2, b: 1, s: 'x' });
    assert.deepEqual((await mutJson('DPT.values.invert', { a: 1, b: 2, c: 3 })).json, { a: 3, b: 2, c: 1 });
    assert.deepEqual((await mutJson('DPT.value.space', { s: 'x' })).json, { s: ' ' });
  });

  test('NBD.body.null / wrongRoot / truncate', async () => {
    assert.equal((await mutJson('NBD.body.null', { a: 1 })).res.text, 'null');
    assert.deepEqual((await mutJson('NBD.body.wrongRoot', { a: 1 })).json, [{ a: 1 }]);
    assert.deepEqual((await mutJson('NBD.body.wrongRoot', [1])).json, { data: [1] });
    const t = await run('NBD.body.truncate', '/api/r', (p) => F(p, R({ ct: 'text/plain', body: 'x'.repeat(200) })));
    assert.equal(t.r.text.length, 64);
    const short = await run('NBD.body.truncate', '/api/r', (p) => F(p, R({ ct: 'text/plain', body: 'short' })));
    assert.deepEqual(short.applied, []);
  });

  test('NBD.response.swap', async () => {
    const { r, applied } = await run('NBD.response.swap', '/api/r', async (p) => {
      const first = await F(p, '/api/other');
      await p.waitForTimeout(200);
      return [first, await F(p, J({ mine: true }))];
    });
    assert.equal(r[0].text, '{"other":true}');
    assert.equal(r[1].text, '{"other":true}');
    assert.equal(applied.length, 1);
    const alone = await run('NBD.response.swap', '/api/r', (p) => F(p, J({ mine: true })));
    assert.equal(alone.r.text, '{"mine":true}');
    assert.deepEqual(alone.applied, []);
  });

  test('GQL.errors.inject', async () => {
    const m = await mutJson('GQL.errors.inject', { data: { user: { id: 1 } } });
    assert.deepEqual(m.json, { data: { user: null }, errors: [{ message: 'mlmt injected error' }] });
    assert.deepEqual((await mutJson('GQL.errors.inject', { user: 1 })).applied, []);
  });
});

/* ------------------------------------------------------------ faults & latency */

describe('connection faults and latency', () => {
  for (const [id, re] of [
    ['NCF.abort.reset', /connectionreset/],
    ['NCF.abort.refused', /connectionrefused/],
    ['NCF.abort.dns', /namenotresolved/],
    ['NCF.abort.failed', /failed/],
  ] as const) {
    test(id, async () => {
      const { r, applied } = await run(id, '/api/r', (p) => F(p, R({})));
      assert.match(r.error!, /Failed to fetch/);
      assert.match(applied[0], re);
    });
  }

  test('NCF.abort.afterServer: the server is reached, the client fails', async () => {
    received = [];
    const { r } = await run('NCF.abort.afterServer', '/api/sink', (p) => F(p, '/api/sink', { method: 'POST', body: 'x' }), { method: 'POST' });
    assert.ok(r.error);
    assert.equal(received.length, 1);
  });

  test('NCF.abort.probabilistic', async () => {
    const a = await run('NCF.abort.probabilistic', '/api/r', (p) => F(p, R({})), { params: { p: 1 } });
    assert.ok(a.r.error);
    const b = await run('NCF.abort.probabilistic', '/api/r', (p) => F(p, R({})), { params: { p: 0 } });
    assert.equal(b.r.status, 200);
    assert.deepEqual(b.applied, []);
  });

  test('NCF.overload', async () => {
    const a = await run('NCF.overload', '/api/r', (p) => F(p, R({})), { params: { p: 1 } });
    assert.equal(a.r.status, 503);
    const b = await run('NCF.overload', '/api/r', (p) => F(p, R({})), { params: { p: 0 } });
    assert.equal(b.r.status, 200);
    assert.match(b.applied[0], /delayed 100ms/);
  });

  test('NCF.offline', async () => {
    const { r, applied } = await run('NCF.offline', '/api/r', async (p) => [await F(p, '/api/other'), await F(p, R({})), await F(p, '/api/other')]);
    assert.equal(r[0].status, 200);
    assert.equal(r[1].status, 200);
    assert.ok(r[2].error);
    assert.equal(applied.length, 1);
  });

  test('NLD.delay.lognormal', async () => {
    const { r, applied } = await run('NLD.delay.lognormal', '/api/r', (p) => F(p, R({})), { params: { medianMs: 50 } });
    assert.equal(r.status, 200);
    assert.match(applied[0], /^delayed \d+ms/);
  });

  test('NLD.timeout.afterWait', async () => {
    const t0 = Date.now();
    const { r } = await run('NLD.timeout.afterWait', '/api/r', (p) => F(p, R({})), { params: { waitMs: 300 } });
    assert.ok(r.error);
    assert.ok(Date.now() - t0 >= 300);
  });

  test('NRC.response.postpone lets a slower response overtake', async () => {
    const race = (p: Page) =>
      p.evaluate(async (u) => {
        const order: string[] = [];
        const slow = fetch('/api/slow?ms=300').then(() => order.push('slow'));
        await new Promise((r) => setTimeout(r, 20));
        const fast = fetch(u).then(() => order.push('fast'));
        await Promise.all([slow, fast]);
        return order;
      }, R({}));
    const ctl = await run('NRC.response.postpone', '/api/elsewhere', race);
    assert.deepEqual(ctl.r, ['fast', 'slow']);
    const m = await run('NRC.response.postpone', '/api/r', race);
    assert.deepEqual(m.r, ['slow', 'fast']);
    assert.match(m.applied[0], /overtook/);
  });
});

/* ------------------------------------------------------------ request side */

describe('request mutations', () => {
  test('NRQ.method.swap', async () => {
    received = [];
    await run('NRQ.method.swap', '/api/sink', (p) => F(p, '/api/sink'));
    assert.equal(received[0].method, 'POST');
    received = [];
    await run('NRQ.method.swap', '/api/sink', (p) => F(p, '/api/sink', { method: 'POST', body: 'x' }), { method: 'POST' });
    assert.equal(received[0].method, 'GET');
  });

  test('NRQ.url.mutate / NRQ.query.drop', async () => {
    received = [];
    await run('NRQ.url.mutate', '/api/sink', (p) => F(p, '/api/sink?a=1'));
    assert.equal(received[0].url, '/api/sink_mut?a=1');
    received = [];
    await run('NRQ.query.drop', '/api/sink', (p) => F(p, '/api/sink?a=1'));
    assert.equal(received[0].url, '/api/sink');
  });

  test('NRQ.body.dropField (JSON and form)', async () => {
    let m = await mutRequest('NRQ.body.dropField', '{"a":1}', 'application/json');
    assert.equal(m.got.body, '{}');
    m = await mutRequest('NRQ.body.dropField', 'a=1&b=2', 'application/x-www-form-urlencoded');
    assert.ok(['a=1', 'b=2'].includes(m.got.body), m.got.body);
  });

  test('NRQ.body.wrongType / null / oversize / sqlTautology', async () => {
    assert.deepEqual(JSON.parse((await mutRequest('NRQ.body.wrongType', '{"a":"x"}', 'application/json')).got.body), { a: 1.5 });
    assert.equal((await mutRequest('NRQ.body.wrongType', 'a=5', 'application/x-www-form-urlencoded')).got.body, 'a=abc');
    assert.deepEqual(JSON.parse((await mutRequest('NRQ.body.null', '{"a":"x"}', 'application/json')).got.body), { a: null });
    assert.equal(JSON.parse((await mutRequest('NRQ.body.oversize', '{"a":"x"}', 'application/json')).got.body).a.length, 10000);
    assert.deepEqual(JSON.parse((await mutRequest('NRQ.body.sqlTautology', '{"u":"bob"}', 'application/json')).got.body), { u: "bob' OR '1'='1" });
  });

  test('NRQ.body.empty (field and raw body)', async () => {
    assert.deepEqual(JSON.parse((await mutRequest('NRQ.body.empty', '{"a":"x"}', 'application/json')).got.body), { a: '' });
    const raw = await mutRequest('NRQ.body.empty', 'hello world', 'text/plain');
    assert.equal(raw.got.body, '');
    assert.equal(raw.applied.length, 1);
  });

  test('NRQ.body.notJson', async () => {
    const m = await mutRequest('NRQ.body.notJson', '{"a":"xyz"}', 'application/json');
    assert.equal(m.got.body, '{"a":');
    assert.throws(() => JSON.parse(m.got.body));
  });

  test('NRQ.contentType.wrong', async () => {
    const m = await mutRequest('NRQ.contentType.wrong', '{"a":1}', 'application/json');
    assert.equal(m.got.headers['content-type'], 'text/plain');
    assert.equal(m.got.body, '{"a":1}');
  });
});

/* ------------------------------------------------------------ cookies */

describe('cookies', () => {
  const addSid = (c: BrowserContext) => c.addCookies([{ name: 'sid', value: '1', url: base }]);

  test('NRQ.cookie.drop', async () => {
    received = [];
    await run('NRQ.method.swap', '/api/elsewhere', (p) => F(p, '/api/sink'), { before: addSid });
    assert.equal(received[0].headers.cookie, 'sid=1'); // control
    received = [];
    const { applied } = await run('NRQ.cookie.drop', '/api/sink', (p) => F(p, '/api/sink'), { before: addSid });
    assert.equal(received[0].headers.cookie, undefined);
    assert.equal(applied.length, 1);
    const none = await run('NRQ.cookie.drop', '/api/sink', (p) => F(p, '/api/sink'));
    assert.deepEqual(none.applied, []);
  });

  test('NRS.setCookie.drop', async () => {
    const { r, applied } = await run('NRS.setCookie.drop', '/api/r', async (p, c) => {
      await F(p, R({ setcookie: 'sid=1; Path=/' }));
      return c.cookies();
    });
    assert.deepEqual(r, []);
    assert.equal(applied.length, 1);
  });

  test('SEC.cookie.insecure', async () => {
    const url = R({ setcookie: 'sid=1; Secure; Path=/' });
    const ctl = await run('NRS.setCookie.drop', '/api/elsewhere', async (p, c) => (await F(p, url), c.cookies()));
    assert.equal(ctl.r[0]?.secure, true);
    const { r, applied } = await run('SEC.cookie.insecure', '/api/r', async (p, c) => (await F(p, url), c.cookies()));
    assert.equal(r.length, 1);
    assert.equal(r[0].secure, false);
    assert.equal(applied.length, 1);
  });

  test('SEC.cookie.noHttpOnly', async () => {
    const url = R({ setcookie: 'sid=1; HttpOnly; Path=/' });
    const ctl = await run('NRS.setCookie.drop', '/api/elsewhere', async (p) => (await F(p, url), p.evaluate(() => document.cookie)));
    assert.equal(ctl.r, '');
    const { r, applied } = await run('SEC.cookie.noHttpOnly', '/api/r', async (p) => (await F(p, url), p.evaluate(() => document.cookie)));
    assert.equal(r, 'sid=1');
    assert.equal(applied.length, 1);
  });
});
