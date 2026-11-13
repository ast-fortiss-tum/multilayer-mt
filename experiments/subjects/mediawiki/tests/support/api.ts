/**
 * Test-data setup through the MediaWiki action API.
 *
 * The BEWT suite is order-dependent: e.g. CreateUserTest creates User001 and
 * later tests log in as User001. In this port each test creates the state it
 * needs here, with unique names, so that tests run in any order, in parallel
 * and repeatedly against the same instance (as MultilayerMT requires).
 *
 * API calls use Playwright's APIRequestContext, which is separate from the
 * browser context: setup traffic is neither recorded nor mutated.
 */
import { randomBytes } from 'crypto';
import { request, APIRequestContext } from '@playwright/test';

export const ADMIN = 'Admin';
export const PASSWORD = 'e2eW3Bt3s71nGB3nchM4rK';
export const BASE_URL = process.env.MW_URL || 'http://localhost:8080';

/**
 * Run-unique id. Always `Q9` + 8 hex digits: the MultilayerMT config maps it to
 * a fixed placeholder (`pageKeyNormalize`) so page keys are stable across runs.
 */
export function uid(): string {
  return 'Q9' + randomBytes(4).toString('hex');
}

type Params = Record<string, string>;

export class WikiApi {
  private constructor(private readonly ctx: APIRequestContext, readonly user: string) {}

  static async login(user: string, password = PASSWORD): Promise<WikiApi> {
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const api = new WikiApi(ctx, user);
    const logintoken = await api.token('login');
    const r = await api.post({ action: 'clientlogin', username: user, password, logintoken, loginreturnurl: BASE_URL });
    if (r.clientlogin?.status !== 'PASS') throw new Error(`API login failed for ${user}: ${JSON.stringify(r)}`);
    return api;
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }

  async get(params: Params): Promise<any> {
    const res = await this.ctx.get('/api.php', { params: { format: 'json', formatversion: '2', ...params } });
    return this.check(await res.json(), params);
  }

  async post(params: Params): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.ctx.post('/api.php', { form: { format: 'json', formatversion: '2', ...params } });
      const json = await res.json();
      // Concurrent writes can deadlock in the database; MediaWiki does not retry.
      if (json.error?.code?.includes('DBQueryError') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 200 * attempt + Math.random() * 300));
        continue;
      }
      return this.check(json, params);
    }
  }

  private check(json: any, params: Params): any {
    if (json.error) throw new Error(`API ${params.action} failed: ${json.error.code}: ${json.error.info}`);
    return json;
  }

  async token(type: 'csrf' | 'login' | 'createaccount' | 'userrights' | 'rollback' = 'csrf'): Promise<string> {
    const r = await this.get({ action: 'query', meta: 'tokens', type });
    return r.query.tokens[`${type}token`];
  }

  async createUser(name: string, opts: { realname?: string; groups?: string[] } = {}): Promise<string> {
    const r = await this.post({
      action: 'createaccount', username: name, password: PASSWORD, retype: PASSWORD,
      realname: opts.realname ?? '', createreturnurl: BASE_URL, createtoken: await this.token('createaccount'),
    });
    if (r.createaccount?.status !== 'PASS') throw new Error(`createaccount ${name}: ${JSON.stringify(r)}`);
    if (opts.groups?.length) await this.addGroups(name, opts.groups);
    return name;
  }

  async addGroups(name: string, groups: string[], reason = ''): Promise<void> {
    await this.post({ action: 'userrights', user: name, add: groups.join('|'), reason, token: await this.token('userrights') });
  }

  async edit(title: string, text: string, summary = 'test setup'): Promise<void> {
    await this.post({ action: 'edit', title, text, summary, token: await this.token() });
  }

  async protect(title: string, level = 'sysop'): Promise<void> {
    await this.post({ action: 'protect', title, protections: `edit=${level}|move=${level}`, expiry: 'infinite', token: await this.token() });
  }

  async block(name: string): Promise<void> {
    await this.post({ action: 'block', user: name, expiry: 'infinite', token: await this.token() });
  }

  /** Change preferences of the logged-in user. */
  async setOptions(options: Record<string, string>): Promise<void> {
    const change = Object.entries(options).map(([k, v]) => `${k}=${v}`).join('|');
    await this.post({ action: 'options', change, token: await this.token() });
  }
}

export interface UserSpec {
  /** Name prefix; a uid is appended. */
  prefix?: string;
  realname?: string;
  /** Extra groups, e.g. ['sysop', 'bureaucrat']. */
  groups?: string[];
  /**
   * Hide VisualEditor's one-time welcome dialog. In the BEWT suite this
   * dialog is dismissed once by CloseInitialEditorPopupTest and is gone for
   * all later tests (default: true).
   */
  hideWelcome?: boolean;
  /** Editor opened by red links: 'visualeditor' (default) or 'wikitext'. */
  editor?: 'visualeditor' | 'wikitext';
}

let adminApi: Promise<WikiApi> | null = null;

/** API session of the wiki's bureaucrat account (one per worker). */
export function admin(): Promise<WikiApi> {
  return (adminApi ??= WikiApi.login(ADMIN));
}

/** Create a fresh account in the state a BEWT test expects of its user. */
export async function freshUser(spec: UserSpec = {}): Promise<string> {
  const api = await admin();
  const name = `${spec.prefix ?? 'User'}${uid()}`;
  await api.createUser(name, { realname: spec.realname, groups: spec.groups });
  const options: Record<string, string> = { 'visualeditor-editor': spec.editor ?? 'visualeditor' };
  if (spec.hideWelcome ?? true) options['visualeditor-hidebetawelcome'] = '1';
  const self = await WikiApi.login(name);
  await self.setOptions(options);
  await self.dispose();
  return name;
}

/**
 * The BEWT tests log in as "admin" (sysop + bureaucrat). Each test gets its
 * own such account so that per-user state (preferences, dismissed dialogs)
 * does not leak between tests.
 */
export function freshAdmin(spec: Omit<UserSpec, 'groups'> = {}): Promise<string> {
  return freshUser({ prefix: 'Admin', ...spec, groups: ['sysop', 'bureaucrat'] });
}

/** Edit a page as a given user (default: the bureaucrat account). */
export async function editAs(user: string, title: string, text: string, summary?: string): Promise<void> {
  const api = await WikiApi.login(user);
  try {
    await api.edit(title, text, summary);
  } finally {
    await api.dispose();
  }
}
