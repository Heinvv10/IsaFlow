/**
 * Calling a real route handler (withAuth, CSRF, write access) as the fixture's
 * admin user — the pattern vat-period-lock-routes.int.test.ts uses, shared by
 * the late-claim route tests.
 */
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import type { Fixture } from './l1FifoFixture';

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

export async function seedRouteUser(fx: Fixture, prefix: string): Promise<string> {
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${prefix}-${fx.userId}@isaflow.test`}, 'admin', true)`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
  return new SignJWT({ sub: fx.userId, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

export async function dropRouteUser(fx: Fixture): Promise<void> {
  await sql`DELETE FROM company_document_numbers WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM users WHERE id = ${fx.userId}`;
}

export async function callRoute(
  fx: Fixture, token: string, handler: Handler, body: Record<string, unknown>,
  query: Record<string, string> = {},
): Promise<{ statusCode: number; body: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = query;
  req.url = '/api/accounting/vat-late-claim-route-fixture';
  const out = response();
  await handler(req as never, out.res as never);
  return out.state;
}

/** The `data` of an apiResponse.success envelope. */
export function dataOf<T = Record<string, unknown>>(state: { body: unknown }): T {
  return (state.body as { data: T }).data;
}
