/**
 * R-095 — the portal is reached by a token, not a staff session, so every
 * query must be scoped to the token's company AND customer, and a token that
 * should no longer work must be refused without a database error reaching the
 * customer. Covers the three session routes (statement, invoices, chat) and
 * the per-invoice token route (a single invoice).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { callPortal, cleanupPortalFixture, seedPortalFixture, tokenFor, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let f: PortalFixture;
type Route = 'statement' | 'invoices' | 'chat';
const ROUTES: Route[] = ['statement', 'invoices', 'chat'];

function input(route: Route, clientId: string) {
  return route === 'chat' ? { body: { question: 'what do I owe?', clientId } } : { query: { clientId } };
}

/** Every document reference in a response, whatever the route's shape. */
function refsIn(body: Record<string, unknown>): string[] {
  return (JSON.stringify(body).match(/R95\d+-[A-Z0-9-]+/g) ?? []);
}

async function expectRefused(token: string, clientId: string, label: string) {
  for (const route of ROUTES) {
    const { status, body } = await callPortal(route, token, input(route, clientId));
    expect(status, `${label} on ${route}`).toBe(401);
    expect(JSON.stringify(body), `${label} on ${route} leaks nothing`).not.toMatch(/sql|postgres|syntax|uuid|column|relation/i);
    expect(refsIn(body)).toEqual([]);
  }
}

describeIfDb('R-095 portal session scoping', () => {
  beforeAll(async () => {
    assertDisposable();
    delete process.env.ANTHROPIC_API_KEY;
    f = await seedPortalFixture();
  }, 120000);

  afterAll(async () => { await cleanupPortalFixture(f); }, 120000);

  it("customer A's valid token only ever returns customer A's own documents", async () => {
    const token = await tokenFor(f.customerA, f.companyA, f.emailA);
    for (const route of ['statement', 'invoices'] as const) {
      const { status, body } = await callPortal(route, token, input(route, f.customerA));
      expect(status).toBe(200);
      const refs = refsIn(body);
      expect(refs.length).toBeGreaterThan(0);
      for (const foreign of ['SIBLING', 'OTHERCO', 'XCO']) expect(refs).not.toContain(`${f.tag}-${foreign}`);
    }
  });

  it("A's token asking for the sibling customer B (same company) is refused on every route", async () => {
    const token = await tokenFor(f.customerA, f.companyA, f.emailA);
    for (const route of ROUTES) {
      const { status, body } = await callPortal(route, token, input(route, f.sibling));
      expect(status, route).toBe(route === 'chat' ? 400 : 403);
      expect(refsIn(body)).toEqual([]);
    }
  });

  it('a validly signed token whose customer is not in its company is refused (other company, and cross-wired claims)', async () => {
    // Customer of company B presented under company A's id, and customer A under B's.
    await expectRefused(await tokenFor(f.other, f.companyA, f.emailOther), f.other, 'other-company customer under A');
    await expectRefused(await tokenFor(f.customerA, f.companyB, f.emailA), f.customerA, 'A under company B');
    // A's customer id with the sibling's email: the email must be A's own portal account.
    await expectRefused(await tokenFor(f.customerA, f.companyA, f.emailSibling), f.customerA, "A's id with B's email");
  });

  it('expired, wrongly signed, unsigned, garbage and non-UUID-claim tokens are refused with no database error', async () => {
    const secret = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
    const claims = { clientId: f.customerA, companyId: f.companyA, email: f.emailA };
    const expired = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(secret);
    const wrongKey = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-portal-secret-but-long-enough-0123456789'));
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    const badClaims = await new SignJWT({ clientId: "x' OR 1=1 --", companyId: 'not-a-uuid', email: f.emailA })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret);

    for (const [label, token] of [['expired', expired], ['wrong key', wrongKey], ['alg none', unsigned], ['garbage', 'garbage'], ['non-UUID claims', badClaims]]) {
      await expectRefused(token!, f.customerA, label!);
    }
    for (const route of ROUTES) {
      expect((await callPortal(route, null, input(route, f.customerA))).status, `no cookie on ${route}`).toBe(401);
    }
  });

  it('a revoked portal account (deactivated, or removed) ends a live session', async () => {
    const token = await tokenFor(f.customerA, f.companyA, f.emailA);
    expect((await callPortal('statement', token, input('statement', f.customerA))).status).toBe(200);

    await sql`UPDATE portal_access SET is_active = false WHERE client_id = ${f.customerA}::UUID`;
    await expectRefused(token, f.customerA, 'deactivated');
    await sql`UPDATE portal_access SET is_active = true WHERE client_id = ${f.customerA}::UUID`;

    const [row] = (await sql`DELETE FROM portal_access WHERE client_id = ${f.customerA}::UUID RETURNING email, password_hash, name`) as { email: string; password_hash: string; name: string }[];
    await expectRefused(token, f.customerA, 'removed');
    await sql`INSERT INTO portal_access (client_id, company_id, email, password_hash, name) VALUES (${f.customerA}::UUID, (SELECT company_id FROM customers WHERE id = ${f.customerA}::UUID), ${row!.email}, ${row!.password_hash}, ${row!.name})`;

    expect((await callPortal('statement', token, input('statement', f.customerA))).status).toBe(200);
  });

  it('a soft-deleted customer: a live session is refused', async () => {
    const token = await tokenFor(f.customerA, f.companyA, f.emailA);
    await sql`UPDATE customers SET deleted_at = NOW() WHERE id = ${f.customerA}::UUID`;
    try {
      await expectRefused(token, f.customerA, 'soft-deleted customer');
    } finally {
      await sql`UPDATE customers SET deleted_at = NULL WHERE id = ${f.customerA}::UUID`;
    }
  });

  it('a single invoice by its link token: that invoice only, and never once soft-deleted or for an unknown token', async () => {
    const { default: route } = await import('../../pages/api/portal/invoice/[token]');
    const get = async (token: string) => {
      const req = { method: 'GET', query: { token }, headers: {}, socket: { remoteAddress: '127.0.0.80' } };
      const result = response();
      await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
      return { status: result.state.statusCode, body: (result.state.body ?? {}) as Record<string, unknown> };
    };
    const issued = await get(f.issuedInvoiceToken);
    expect(issued.status).toBe(200);
    expect([...new Set(refsIn(issued.body))]).toEqual([`${f.tag}-INV-1`]);

    for (const token of [f.softDeletedInvoiceToken, 'unknown-token', "' OR 1=1 --"]) {
      const res = await get(token);
      expect(res.status, token).toBe(404);
      expect(refsIn(res.body)).toEqual([]);
    }
  });
});
