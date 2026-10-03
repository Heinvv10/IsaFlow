/** Shared fixture and callers for the LINK-REVOKE integration suites. */
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { vi } from 'vitest';
import { request } from './mfa-impersonation-postgres.helpers';
import { CO, SECRET, USER, call, cleanupCompany, pool, seedCompany } from './r167-portal-links.helpers';
import { signIn } from './r177-portal-followups.helpers';
import { als } from '@/lib/als';
import { revokeStandingLink } from '@/modules/accounting/services/ar/standingPaymentLink';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

export const VIEWER = randomUUID();
let adminJwt = '';
let viewerJwt = '';
export const viewerToken = () => viewerJwt;
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

export async function revoke(invoiceId: string, opts: { jwt?: string; csrf?: boolean } = {}) {
  const req = request({ 'sb-access-token': opts.jwt ?? adminJwt, active_company_id: CO }, 'POST') as unknown as Record<string, unknown>;
  if (opts.csrf === false) {
    delete (req.headers as Record<string, unknown>)['x-csrf-token'];
    req.cookies = { ...(req.cookies as Record<string, string>), isaflow_csrf: undefined };
  }
  return call((await import('../../pages/api/accounting/customer-invoices/[id]/payment-link/revoke')).default as never,
    { ...req, query: { id: invoiceId } });
}
/** The service in a transaction of its own as the fixture owner: no row security, so only its predicates isolate. */
export async function revokeInTx(companyId: string, invoiceId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: USER, companyId, claims: {} } as never, () => revokeStandingLink(companyId, invoiceId));
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
export const row = async (id: string) => (await pool.query<{ payment_url: string | null; on: boolean | null }>(
  'SELECT payment_url, online_payment_enabled AS on FROM customer_invoices WHERE id = $1', [id])).rows[0]!;
export const status = async (token: string) => (await pool.query<{ status: string }>(
  'SELECT status FROM portal_payment_links WHERE token = $1', [token])).rows[0]!.status;

export async function setupRevokeFixture(): Promise<void> {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.revoke.test');
  await seedCompany();
  await pool.query("INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'viewer', true, 'direct')",
    [VIEWER, `revoke-viewer-${VIEWER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', true)", [CO, VIEWER]);
  clearSystemAccountCache();
  await signIn();
  adminJwt = await sign(USER);
  viewerJwt = await sign(VIEWER);
}
export async function teardownRevokeFixture(): Promise<void> {
  vi.unstubAllEnvs();
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [VIEWER]);
  await pool.query('DELETE FROM users WHERE id = $1', [VIEWER]);
  await cleanupCompany();
}

