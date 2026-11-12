import type { BrowserContext, Route, Request } from '@playwright/test';
import type { MutantDescriptor, NetworkTarget } from '../../types';
import { addField, changeType, dropField, invalidEnum, renameField, reorderArrays, Transformed } from './payload';
import { mulberry32 } from '../../util/random';
import { registry, NetworkOperatorDef } from '../registry';

export type AppliedCallback = (detail: string) => void;

function urlBaseOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function isJson(contentType: string | undefined): boolean {
  return !!contentType && /json/i.test(contentType);
}

function strippedHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Registers the network mutation of `mutant` on `context` using request
 * interception (page.route / context.route). The handler is removed when the
 * context is closed, which makes every network operator reversible between runs.
 */
export async function installNetworkMutation(
  context: BrowserContext,
  mutant: MutantDescriptor,
  onApplied: AppliedCallback,
  seed = 42,
): Promise<void> {
  const target = mutant.target as NetworkTarget;
  const p = mutant.params as Record<string, any>;
  const rand = mulberry32(seed);
  let cached: { status: number; headers: Record<string, string>; body: Buffer } | null = null;

  const matches = (req: Request) =>
    req.method().toUpperCase() === target.method.toUpperCase() && urlBaseOf(req.url()) === target.urlBase;

  const payloadOp = async (route: Route, fn: (json: unknown) => Transformed) => {
    const response = await route.fetch();
    const headers = response.headers();
    if (!isJson(headers['content-type'])) return route.fulfill({ response });
    let json: unknown;
    try {
      json = JSON.parse((await response.body()).toString('utf8'));
    } catch {
      return route.fulfill({ response });
    }
    const res = fn(json);
    if (!res.changed) return route.fulfill({ response });
    onApplied(res.detail || mutant.operator);
    return route.fulfill({
      status: response.status(),
      headers: strippedHeaders(headers),
      body: JSON.stringify(res.value),
    });
  };

  const handler = async (route: Route, request: Request) => {
    if (!matches(request)) return route.fallback();
    try {
      switch (mutant.operator) {
        case 'NPF.field.drop':
          return await payloadOp(route, (j) => dropField(j, String(p.fieldName)));
        case 'NPR.field.rename':
          return await payloadOp(route, (j) => renameField(j, String(p.oldName), String(p.newName)));
        case 'NPT.type.change':
          return await payloadOp(route, (j) => changeType(j, String(p.fieldName), (p.toType as any) || 'auto'));
        case 'NPE.enum.invalid':
          return await payloadOp(route, (j) => invalidEnum(j, String(p.fieldName), p.invalidValue));
        case 'NPA.field.add':
          return await payloadOp(route, (j) => addField(j, String(p.fieldName), p.fieldValue));
        case 'NOR.response.reorder':
          return await payloadOp(route, (j) => reorderArrays(j, p.strategy === 'shuffle' ? 'shuffle' : 'reverse', rand));
        case 'NSO.status.override': {
          const response = await route.fetch();
          const status = Number(p.status ?? 500);
          if (response.status() === status) return route.fulfill({ response });
          onApplied(`status ${response.status()} -> ${status}`);
          return route.fulfill({ response, status });
        }
        case 'NLF.delay.fixed': {
          const ms = Number(p.delayMs ?? 2000);
          await new Promise((r) => setTimeout(r, ms));
          onApplied(`delayed ${ms}ms`);
          return route.fallback();
        }
        case 'NLR.delay.jitter': {
          const min = Number(p.minMs ?? 100);
          const max = Number(p.maxMs ?? 1000);
          const ms = Math.floor(min + rand() * (max - min + 1));
          await new Promise((r) => setTimeout(r, ms));
          onApplied(`delayed ${ms}ms (jitter)`);
          return route.fallback();
        }
        case 'NLT.timeout.inject':
          onApplied('aborted (timedout)');
          return route.abort('timedout');
        case 'NOD.response.duplicate': {
          if (cached) {
            onApplied('replayed first response');
            return route.fulfill({ status: cached.status, headers: cached.headers, body: cached.body });
          }
          const response = await route.fetch();
          cached = { status: response.status(), headers: strippedHeaders(response.headers()), body: await response.body() };
          return route.fulfill({ response });
        }
        default: {
          const def = registry.has(mutant.operator) ? (registry.get(mutant.operator) as NetworkOperatorDef) : null;
          if (def?.handle) return await def.handle({ route, request, params: p, applied: onApplied, rand });
          return route.fallback();
        }
      }
    } catch (e) {
      // the context may be closing; never crash the test because of the handler
      try {
        await route.fallback();
      } catch {
        /* ignore */
      }
    }
  };

  await context.route(() => true, handler);
}

/** SFM.* operators additionally fail the resource at the network boundary. */
export async function installResourceFailure(
  context: BrowserContext,
  resourceUrl: string | undefined,
  kind: 'script' | 'stylesheet',
  onApplied: AppliedCallback,
): Promise<void> {
  await context.route(
    (url) => {
      const s = url.toString();
      if (resourceUrl) return s === resourceUrl || /\.404\.(js|css)(\?|#|$)/.test(s);
      return /\.404\.(js|css)(\?|#|$)/.test(s);
    },
    async (route, req) => {
      const rt = req.resourceType();
      if ((kind === 'script' && rt !== 'script') || (kind === 'stylesheet' && rt !== 'stylesheet')) return route.fallback();
      onApplied(`${kind} request failed: ${req.url()}`);
      return route.fulfill({ status: 404, body: 'Not Found (MultilayerMT)' });
    },
  );
}
