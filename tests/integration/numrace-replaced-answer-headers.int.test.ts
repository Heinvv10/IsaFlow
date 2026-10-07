/**
 * sec-numrace F1: an answer the owner REPLACES (a failed COMMIT, a failed critical audit, a rollback-only request, a
 * throw) must not carry the Set-Cookie and Location the route set for the answer it meant to give. impersonate sets the
 * target's session cookies before answering; on a rolled-back request they used to reach the admin's browser while the
 * impersonation_start audit row rolled back. Driven through the real withPlatformAdmin on the fixture, each handler
 * writing an admin_audit_log row and setting the cookies as impersonate does (sec-numrace8's probe shape).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const ADMIN = `nrhdr-admin-${process.pid}`;
let token = '';

type Wire = { status: number; body: unknown; setCookie: unknown; location: unknown };
function fakeRes() {
  const headers = new Map<string, unknown>();
  const wire: Wire[] = [];
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return this; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
    removeHeader(k: string) { headers.delete(k.toLowerCase()); },
    json(body: unknown) { this.setHeader('Content-Type', 'application/json'); return this.end(JSON.stringify(body)); },
    end(body?: unknown) {
      wire.push({ status: this.statusCode, body: body === undefined ? null : JSON.parse(String(body)),
        setCookie: headers.get('set-cookie') ?? null, location: headers.get('location') ?? null });
      this.writableEnded = true; return this;
    },
    destroy() { wire.push({ status: -1, body: 'DESTROYED', setCookie: null, location: null }); },
  };
  return { res, wire };
}

const audit = (tag: string) => sql`INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
  VALUES (${ADMIN}, ${tag}, 'user', ${ADMIN}, '{}'::jsonb)`;
const audited = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM admin_audit_log
  WHERE admin_user_id = ${ADMIN} AND action = ${tag}`) as { n: number }[])[0]!.n);
/** What impersonate sets before it answers: the target's session, the proof cookie, and (here) a redirect. */
const sessionCookies = (r: NextApiResponse) => {
  r.setHeader('Set-Cookie', ['sb-access-token=TARGET-SESSION; HttpOnly', 'impersonation_proof=PROOF']);
  r.setHeader('Location', '/accounting');
};

async function run(tag: string, body: (res: NextApiResponse) => Promise<void>, wrapErr = true) {
  const { res, wire } = fakeRes();
  const h = async (_req: unknown, r: NextApiResponse) => body(r);
  await withPlatformAdmin((wrapErr ? withErrorHandler(h as never) : h) as never)(
    { headers: { cookie: `sb-access-token=${token}` }, url: `/api/admin/nrhdr-${tag}`, method: 'POST' } as never, res as never);
  return { wire, committed: await audited(tag) };
}

describeIfDb('sec-numrace F1: a replaced answer drops the route\'s Set-Cookie and Location', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${ADMIN}, ${`${ADMIN}@isaflow.test`}, 'super_admin', true)`;
    token = await new SignJWT({ sub: ADMIN, aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    // A row that fails only at COMMIT (a deferred constraint trigger), so the COMMIT itself is what fails.
    await sql`CREATE TABLE IF NOT EXISTS public.nrhdr_defer (id int)`;
    await sql`CREATE OR REPLACE FUNCTION public.nrhdr_fail() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'nrhdr deferred failure at commit'; END $f$`;
    await sql`DROP TRIGGER IF EXISTS nrhdr_t ON public.nrhdr_defer`;
    await sql`CREATE CONSTRAINT TRIGGER nrhdr_t AFTER INSERT ON public.nrhdr_defer DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.nrhdr_fail()`;
    await sql`GRANT ALL ON public.nrhdr_defer TO PUBLIC`;
  }, 60000);
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS public.nrhdr_defer`;
    await sql`DROP FUNCTION IF EXISTS public.nrhdr_fail()`;
    await sql`DELETE FROM admin_audit_log WHERE admin_user_id = ${ADMIN}`.catch(() => undefined);
    await sql`DELETE FROM users WHERE id = ${ADMIN}`.catch(() => undefined);
  }, 60000);

  it('a committed answer keeps its cookies and redirect', async () => {
    const out = await run('ok', async (r) => { await audit('ok'); sessionCookies(r); r.status(200).json({ success: true }); });
    expect(out.committed).toBe(1);
    expect(out.wire).toHaveLength(1);
    expect(out.wire[0]).toMatchObject({ status: 200, location: '/accounting' });
    expect(out.wire[0]!.setCookie).toEqual(['sb-access-token=TARGET-SESSION; HttpOnly', 'impersonation_proof=PROOF']);
  }, 60000);

  it.each([
    ['COMMIT fails', 'commit', async (r: NextApiResponse) => {
      await audit('commit'); await sql`INSERT INTO public.nrhdr_defer VALUES (1)`; sessionCookies(r); r.status(200).json({ success: true });
    }, true],
    ['critical audit failed', 'audit', async (r: NextApiResponse) => {
      await audit('audit'); sessionCookies(r); als.getStore()!.criticalAuditFailed = true; r.status(200).json({ success: true });
    }, true],
    ['rollback-only (25P02 hand-back)', 'only', async (r: NextApiResponse) => {
      await audit('only');
      await withJournalDateRefusal(r, async () => { try { await sql`SELECT 1/0`; } catch (e) { void e; } return 1; });
      sessionCookies(r); r.status(200).json({ success: true });
    }, true],
    ['a throw reaches the owner', 'throw', async (r: NextApiResponse) => {
      await audit('throw'); sessionCookies(r); throw new Error('nrhdr throw');
    }, false],
  ] as const)('%s: 500, nothing committed, no Set-Cookie and no Location', async (_name, tag, body, wrapErr) => {
    const out = await run(tag, body, wrapErr);
    process.stdout.write(`NRHDR ${tag} ${JSON.stringify(out)}\n`);
    expect(out.committed).toBe(0);
    expect(out.wire).toHaveLength(1);
    expect(out.wire[0]).toMatchObject({ status: 500, setCookie: null, location: null });
  }, 60000);
});
