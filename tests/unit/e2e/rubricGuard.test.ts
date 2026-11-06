/**
 * Every refusal of the rubric harness's guard (master plan wave 4, MW): tests/e2e/rubric/_rubricGuard.ts.
 * The deny-list is tested on its own, against allow-lists that contain the live ports (grill 13).
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVER_EMAIL, DEMO_COMPANY_ID, EmailInterceptTally, PORT_ALLOW_LIST, PORT_DENY_LIST, REQUESTER_EMAIL, RubricGuardError,
  assertBaseUrl, assertLogins, assertPortAllowed, assertPortNotDenied, assertRunId, assertSandbox,
  assertNotEmailRoute, assertSession, employeeNumber, guardWrites, isEmailRoute, isSwitchCompanyRoute, listenerPids, parseEnvFile,
  sandboxName, type MeView,
} from '../../e2e/rubric/_rubricGuard';

const LIVE = [80, 3101, 3111, 3112];
const refused = (fn: () => unknown, msg: RegExp) => expect(fn).toThrow(msg);

describe('deny-list (on its own)', () => {
  it('names exactly the live ports', () => {
    expect([...PORT_DENY_LIST].sort((a, b) => a - b)).toEqual(LIVE);
  });

  it.each(LIVE)('refuses %i directly', (port) => {
    refused(() => assertPortNotDenied(port), /deny-list/);
  });

  it.each(LIVE)('refuses http://localhost:%i even with an allow-list that contains it', (port) => {
    refused(() => assertBaseUrl(`http://localhost:${port}/`, [...PORT_ALLOW_LIST, ...LIVE]), /deny-list/);
  });

  it('refuses a URL with no port (port 80) whatever the allow-list', () => {
    refused(() => assertBaseUrl('http://localhost/', [80]), /port 80 is on the deny-list/);
  });
});

describe('allow-list', () => {
  it('is exactly the wave ports 3271-3280', () => {
    expect(PORT_ALLOW_LIST).toEqual([3271, 3272, 3273, 3274, 3275, 3276, 3277, 3278, 3279, 3280]);
  });

  it.each([3270, 3281, 3200, 3111, 3112])('does not hold %i', (port) => {
    refused(() => assertPortAllowed(port), /not on the allow-list/);
  });

  it.each([3270, 3281, 3200])('refuses http://localhost:%i', (port) => {
    refused(() => assertBaseUrl(`http://localhost:${port}`), /not on the allow-list/);
  });

  it('accepts each wave port and returns it', () => {
    for (const port of PORT_ALLOW_LIST) expect(assertBaseUrl(`http://localhost:${port}`)).toBe(port);
  });
});

describe('base URL spellings from the security review (PR #1209)', () => {
  it.each([
    ['http://localhost:3271', 3271], ['http://LOCALHOST:3271', 3271], ['http://localhost:03271', 3271],
    ['http://local%68ost:3271', 3271], ['http://localhost:3271/x/..', 3271],
  ])('%s is localhost:%i', (url, port) => {
    expect(assertBaseUrl(url)).toBe(port);
  });

  it.each([
    ['http://127.0.0.1:3271', /host must be localhost/], ['http://[::1]:3271', /host must be localhost/],
    ['http://0.0.0.0:3271', /host must be localhost/], ['http://localhost.evil:3271', /host must be localhost/],
    ['http://localhost.:3271', /host must be localhost/], ['http://localhost%2e:3271', /host must be localhost/],
    ['http://localhost:3271@host:3111', /host must be localhost/], ['http://user@localhost:3271', /credentials/],
    ['http://localhost', /deny-list/], ['http://localhost:3111#:3271', /server root/],
    ['http://localhost:3271\\@x:3111', /server root/],
  ])('refuses %s', (url, msg) => {
    refused(() => assertBaseUrl(url), msg);
  });
});

describe('base URL shape', () => {
  it.each([
    ['https://localhost:3277', /http:\/\/localhost/],
    ['http://127.0.0.1:3277', /host must be localhost/],
    ['http://app.isaflow.co.za:3277', /host must be localhost/],
    ['http://u:p@localhost:3277', /credentials/],
    ['http://localhost:3277/accounting', /server root/],
    ['http://localhost:3277/?x=1', /server root/],
    ['not a url', /not a URL/],
    [undefined, /not a URL/],
  ])('refuses %s', (url, msg) => {
    refused(() => assertBaseUrl(url), msg);
  });
});

describe('logins', () => {
  it('accepts exactly the two QA users', () => {
    expect(() => assertLogins(REQUESTER_EMAIL, APPROVER_EMAIL)).not.toThrow();
  });

  it.each([
    ['hein@h10.co.za', APPROVER_EMAIL, /requester must be/],
    ['Reporting-QA@isaflow.dev', APPROVER_EMAIL, /requester must be/],
    [` ${REQUESTER_EMAIL}`, APPROVER_EMAIL, /requester must be/],
    [undefined, APPROVER_EMAIL, /requester must be/],
    [REQUESTER_EMAIL, REQUESTER_EMAIL, /approver must be/],
    [REQUESTER_EMAIL, 'admin@isaflow.co.za', /approver must be/],
    [REQUESTER_EMAIL, undefined, /approver must be/],
  ])('refuses requester %s / approver %s', (requester, approver, msg) => {
    refused(() => assertLogins(requester, approver), msg);
  });
});

describe('sandbox', () => {
  const id = '6a1f0000-0000-4000-8000-000000000001';

  it('names the sandbox for the run and accepts it', () => {
    expect(sandboxName('w4-before')).toBe('0RS Rubric Sandbox w4-before');
    expect(() => assertSandbox({ id, name: '0RS Rubric Sandbox w4-before' }, 'w4-before')).not.toThrow();
  });

  it('refuses Demo, even under the sandbox name', () => {
    refused(() => assertSandbox({ id: DEMO_COMPANY_ID, name: '0RS Rubric Sandbox w4-before' }, 'w4-before'), /Demo/);
  });

  it.each(['ISAFlow Demo', '0RS Rubric Sandbox w4-after', '0GP Golden Pay Run Sandbox'])('refuses "%s"', (name) => {
    refused(() => assertSandbox({ id, name }, 'w4-before'), /not this run's sandbox/);
  });

  it.each(['', 'W4', 'a b', '-x', 'x'.repeat(15), 'x'.repeat(33), undefined])('refuses run id %s', (runId) => {
    refused(() => assertRunId(runId), /RUBRIC_RUN_ID/);
  });

  it('accepts a 14-character run id, whose employee numbers fit the API\'s 20', () => {
    const runId = 'a'.repeat(13) + '9';
    expect(assertRunId(runId)).toBe(runId);
    expect(employeeNumber(runId, 2)).toBe(`RBR-${runId.toUpperCase()}-2`);
    expect(employeeNumber(runId, 2)).toHaveLength(20);
  });
});

describe('session', () => {
  const sandbox = { id: '6a1f0000-0000-4000-8000-000000000001', runId: 'w4-before' };
  const me = (over: Partial<MeView> = {}): MeView => ({
    user: { email: REQUESTER_EMAIL },
    activeCompanyId: sandbox.id,
    memberships: [{ company_id: sandbox.id, name: '0RS Rubric Sandbox w4-before' }],
    ...over,
  });

  it('accepts the requester in the sandbox', () => {
    expect(() => assertSession(me(), REQUESTER_EMAIL, sandbox)).not.toThrow();
  });

  it('refuses another user', () => {
    refused(() => assertSession(me({ user: { email: 'golden-slot-1@isaflow.dev' } }), REQUESTER_EMAIL), /session belongs to/);
  });

  it('refuses a session scoped to Demo', () => {
    refused(() => assertSession(me({ activeCompanyId: DEMO_COMPANY_ID }), REQUESTER_EMAIL, sandbox), /not the sandbox/);
  });

  it('refuses a sandbox id whose membership name is not the sandbox', () => {
    refused(() => assertSession(me({ memberships: [{ company_id: sandbox.id, name: 'ISAFlow Demo' }] }), REQUESTER_EMAIL, sandbox),
      /not this run's sandbox/);
  });

  it('refuses when the user is not a member', () => {
    refused(() => assertSession(me({ memberships: [] }), REQUESTER_EMAIL, sandbox), /not a member/);
  });
});

describe('email intercept', () => {
  it.each([
    ['http://localhost:3277/api/accounting/invoice-email', true],
    ['http://localhost:3277/api/accounting/invoice-email/', true],
    ['http://localhost:3277/api/accounting/invoice-email?retry=1', true],
    ['http://localhost:3277/api/accounting/invoice-emails', false],
    ['http://localhost:3277/api/accounting/customer-invoices-detail', false],
    // The security review's spellings (PR #1209): the server routes each of these to the email handler.
    ['http://localhost:3277//api/accounting/invoice-email', true],
    ['http://localhost:3277/api//accounting///invoice-email', true],
    ['http://localhost:3277/api/accounting/./invoice-email', true],
    ['http://localhost:3277/api/accounting/x/../invoice-email', true],
    ['http://localhost:3277/api/accounting/invoice%2Demail', true],
    ['http://localhost:3277/api/accounting%2Finvoice-email', true],
    // A path that does not decode: refused as if it were the route (fail closed).
    ['http://localhost:3277/api/accounting/invoice-email%E0', true],
    // Not a URL at all: nothing can be sent to it.
    ['not a url', false],
    ['', false],
  ])('%s is the email route: %s', (url, expected) => {
    expect(isEmailRoute(url)).toBe(expected);
  });

  it.each([
    ['http://localhost:3277/api/auth/switch-company', true],
    ['http://localhost:3277/api/auth/switch-company/', true],
    ['http://localhost:3277/api/auth/me', false],
    ['http://localhost:3277/accounting/switch-company', false],
  ])('%s is the switch-company route: %s', (url, expected) => {
    expect(isSwitchCompanyRoute(url)).toBe(expected);
  });

  it('fails when the intercept was never hit', () => {
    refused(() => new EmailInterceptTally().assertClean(), /never hit/);
  });

  it('fails when a request to the route was not fulfilled here', () => {
    const tally = new EmailInterceptTally();
    tally.onRequest('http://localhost:3277/api/accounting/invoice-email');
    tally.onRequest('http://localhost:3277/api/accounting/invoice-email');
    tally.onFulfilled();
    refused(() => tally.assertClean(), /1 request\(s\) .* not intercepted/);
  });

  it('passes when every request was fulfilled', () => {
    const tally = new EmailInterceptTally();
    tally.onRequest('http://localhost:3277/api/accounting/invoice-email');
    tally.onRequest('http://localhost:3277/api/accounting/other');
    tally.onFulfilled();
    expect(() => tally.assertClean()).not.toThrow();
  });
});

describe('harness API writes', () => {
  type Call = [string, string];
  function fakeApi() {
    const calls: Call[] = [];
    const api = {
      post: async (path: string, _body?: unknown) => { calls.push(['post', path]); return { ok: true }; },
      postRaw: async (path: string, _body?: unknown) => { calls.push(['postRaw', path]); return { status: 200, json: null }; },
      put: async (path: string, _body?: unknown) => { calls.push(['put', path]); return {}; },
      del: async (path: string, _body?: unknown) => { calls.push(['del', path]); return {}; },
      postMultipart: async (path: string, _body?: unknown) => { calls.push(['postMultipart', path]); return {}; },
      get: async (path: string) => { calls.push(['get', path]); return {}; },
    };
    return { api, calls };
  }

  it.each(['post', 'postRaw', 'put', 'del', 'postMultipart'] as const)('%s checks the scope before it writes', async (method) => {
    const { api, calls } = fakeApi();
    guardWrites(api, async (m, path) => { calls.push([`scope:${m}`, path]); });
    await api[method]('/api/accounting/customers', {} as never);
    expect(calls).toEqual([[`scope:${method}`, '/api/accounting/customers'], [method, '/api/accounting/customers']]);
  });

  it('does not write when the scope check refuses', async () => {
    const { api, calls } = fakeApi();
    guardWrites(api, async () => { throw new RubricGuardError('active company is Demo'); });
    await expect(api.put('/api/payroll/runs/x/inputs')).rejects.toThrow(/active company is Demo/);
    expect(calls).toEqual([]);
  });

  it.each(['post', 'postRaw', 'put', 'del', 'postMultipart'] as const)('%s refuses the email route in any spelling', async (method) => {
    const { api, calls } = fakeApi();
    guardWrites(api, async () => undefined);
    for (const path of ['/api/accounting/invoice-email', '//api/accounting/invoice-email/', '/api/accounting/invoice%2Demail?x=1']) {
      await expect(api[method](path, {} as never)).rejects.toThrow(/email route/);
    }
    expect(calls).toEqual([]);
  });

  it('leaves reads alone', async () => {
    const { api, calls } = fakeApi();
    guardWrites(api, async () => { throw new Error('no'); });
    await api.get('/api/auth/me');
    expect(calls).toEqual([['get', '/api/auth/me']]);
  });

  it('assertNotEmailRoute passes other paths', () => {
    expect(() => assertNotEmailRoute('/api/accounting/customer-invoices-detail')).not.toThrow();
  });
});

describe('server tree discovery', () => {
  const ss = [
    'LISTEN 0      511      *:3277      *:*    users:(("next-server (v1",pid=4242,fd=19))',
    'LISTEN 0      511      *:32770     *:*    users:(("other",pid=1,fd=3))',
    'LISTEN 0      511      [::]:3277   [::]:*  users:(("next-server (v1",pid=4242,fd=20))',
  ].join('\n');

  it('finds the one pid listening on the port, not on a longer port', () => {
    expect(listenerPids(ss, 3277)).toEqual([4242]);
    expect(listenerPids(ss, 3278)).toEqual([]);
  });

  it('parses .env.local lines', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n\nbad line')).toEqual({ A: '1', B: 'two words', C: 'x=y' });
  });

  it('is a RubricGuardError', () => {
    expect(() => assertRunId('')).toThrow(RubricGuardError);
  });
});
