/**
 * Round 2 of the security review of the rubric harness's guard (PR #1209): tests/e2e/rubric/_rubricGuard.ts.
 * A listener whose pid ss cannot show (another user's socket) is refused; the harness Api writes only to a path on its
 * own server (one leading slash, no backslash); the email route is matched in the spellings the server routes.
 */
import { describe, expect, it } from 'vitest';
import { assertServerPath, guardWrites, isEmailRoute, listenerPids } from '../../e2e/rubric/_rubricGuard';

describe('listener pids', () => {
  const line = (port: number, users: string) => `LISTEN 0      511      *:${port}      *:*    ${users}`;

  it('refuses when a LISTEN line on the port shows no pid (another user\'s socket)', () => {
    const ss = [line(3277, 'users:(("next-server (v1",pid=4242,fd=19))'), line(3277, '')].join('\n');
    expect(() => listenerPids(ss, 3277)).toThrow(/rubric guard: a listener on :3277 shows no pid/);
  });

  it('refuses a pid-less line alone', () => {
    expect(() => listenerPids(line(3277, ''), 3277)).toThrow(/shows no pid/);
  });

  it('ignores a pid-less line on another port', () => {
    expect(listenerPids([line(3277, 'users:(("n",pid=7,fd=1))'), line(32770, '')].join('\n'), 3277)).toEqual([7]);
  });
});

describe('harness API write paths', () => {
  function fakeApi() {
    const calls: string[] = [];
    const send = (m: string) => async (path: string, _body?: unknown) => { calls.push(`${m} ${path}`); return {}; };
    const api = { post: send('post'), postRaw: send('postRaw'), put: send('put'), del: send('del'), postMultipart: send('postMultipart') };
    guardWrites(api, async (m, path) => { calls.push(`scope ${m} ${path}`); });
    return { api, calls };
  }

  it.each(['post', 'postRaw', 'put', 'del', 'postMultipart'] as const)('%s refuses anything but a path on its own server', async (method) => {
    const { api, calls } = fakeApi();
    for (const path of ['http://localhost:3111/api/accounting/customers', 'https://app.isaflow.co.za/api/x', '//app.isaflow.co.za/api/x',
      '/\\app.isaflow.co.za/api/x', '/api\\x', 'api/accounting/customers', '', 'HTTP://localhost:3111/api/x',
      '/\t/evil.com/x', '/\n/evil.com/x', '/\r/evil.com/x', '/api/x\t', ' //evil.com/x', '\t//evil.com/x', '/api/x y', '/api/\x00x',
      '/api/\x1fx']) {
      await expect(api[method](path, {} as never)).rejects.toThrow(/rubric guard: .*not a path on the harness server/);
    }
    expect(calls).toEqual([]);
  });

  it.each(['/\t/evil.com/x', '/\n/evil.com/x', '/\r\n/evil.com/x'])('refuses %j: WHATWG strips tab/CR/LF, so it would resolve to another host', (p) => {
    expect(new URL(p, 'http://localhost:3277').host).toBe('evil.com'); // why it matters
    expect(() => assertServerPath(p)).toThrow(/not a path on the harness server/);
  });

  it.each(['/api/accounting/customers', '/api/x?a=1&b=//c', '/api/payroll/runs/x/inputs'])('accepts %s, as resolved', (p) => {
    expect(assertServerPath(p)).toBe(p);
  });

  it('returns the normalised path', () => {
    expect(assertServerPath('/api/accounting/x/../invoice-email?a=1')).toBe('/api/accounting/invoice-email?a=1');
  });

  it.each(['/api/accounting/x/../invoice-email', '/api/accounting/./invoice-email', '/api/accounting/invoice%2Demail'])(
    'the email refusal judges the normalised path: %s', async (p) => {
      const { api, calls } = fakeApi();
      await expect(api.post(p, {})).rejects.toThrow(/email route \(\/api\/accounting\/invoice/);
      expect(calls).toEqual([]);
    });

  it('passes a plain path through the scope check', async () => {
    const { api, calls } = fakeApi();
    await api.post('/api/accounting/customers', {});
    expect(calls).toEqual(['scope post /api/accounting/customers', 'post /api/accounting/customers']);
  });
});

describe('email route spellings', () => {
  it.each(['/api/accounting/invoice-email', '//api/accounting/invoice-email', '/api/accounting/invoice%2Demail',
    '/api/accounting/invoice-email?x=1', '/api//accounting/./invoice-email/', '/api/accounting/%2e/invoice-email'])('%s is the route', (p) => {
    expect(isEmailRoute(p)).toBe(true);
  });

  it.each(['/api/accounting/invoice-email%3F', '/API/accounting/invoice-email', '/api/accounting/invoice-email;x'])(
    '%s is another route', (p) => {
      expect(isEmailRoute(p)).toBe(false);
    });
});
