/**
 * POST /api/onboarding/complete only re-issues the onboarding cookie: flag true, or flag NULL
 * for a user who belongs to a company. No users row, a false flag, or NULL with no membership
 * is a 409 with nothing written. withAuth already demands a profile and a membership; these
 * cases are the route's own check, so withAuth is passed through here and sql is scripted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ user: [] as { onboarding_completed: boolean | null }[], member: [] as unknown[], writes: [] as string[] }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.startsWith('UPDATE')) { db.writes.push(q); return Promise.resolve([]); }
    if (q.includes('FROM company_users')) return Promise.resolve(db.member);
    return Promise.resolve(db.user);
  }),
}));
import handler from '../../../pages/api/onboarding/complete';

async function post() {
  const headers = new Map<string, unknown>();
  const out = { status: 200, body: undefined as unknown, cookies: () => (headers.get('set-cookie') as string[] | undefined) ?? [] };
  const res = {
    status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; }, end() { return this; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return this; }, getHeader(k: string) { return headers.get(k.toLowerCase()); },
  };
  await (handler as unknown as (q: unknown, r: unknown) => Promise<void>)({ method: 'POST', user: { id: 'u1' }, headers: {} }, res);
  return out;
}
beforeEach(() => { db.user = []; db.member = []; db.writes = []; });

describe('POST /api/onboarding/complete', () => {
  it('no users row: 409, no write, no cookie', async () => {
    const r = await post();
    expect(r.status).toBe(409); expect(db.writes).toEqual([]); expect(r.cookies()).toEqual([]);
  });
  it('flag false: 409, no write', async () => {
    db.user = [{ onboarding_completed: false }];
    const r = await post();
    expect(r.status).toBe(409); expect(JSON.stringify(r.body)).toContain('Complete the setup wizard'); expect(db.writes).toEqual([]);
  });
  it('flag NULL with no company membership: 409, no write', async () => {
    db.user = [{ onboarding_completed: null }];
    const r = await post();
    expect(r.status).toBe(409); expect(db.writes).toEqual([]); expect(r.cookies()).toEqual([]);
  });
  it('flag NULL with a membership: flag set, cookie issued', async () => {
    db.user = [{ onboarding_completed: null }]; db.member = [{ ok: 1 }];
    const r = await post();
    expect(r.status).toBe(200); expect(db.writes).toHaveLength(1); expect(r.cookies().some(c => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
  });
  it('flag true: cookie re-issued, no write', async () => {
    db.user = [{ onboarding_completed: true }];
    const r = await post();
    expect(r.status).toBe(200); expect(db.writes).toEqual([]); expect(r.cookies().some(c => c.startsWith('ff_onboarding_done=1;'))).toBe(true);
  });
});
