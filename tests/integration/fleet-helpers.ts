/**
 * Fleet records and asset / fleet bank-line links (mig 853) — shared fixture for the fleet-*.int.test.ts files and
 * d12-r2-links on the d8-r4 fixture (isaflow_test). Assets and fleet records are seeded as rows (their own routes are
 * what the fleet-records suite tests); links are always written through the routes.
 */
import { sql } from '@/lib/neon';
import { request, response } from './mfa-impersonation-postgres.helpers';
import type { Ctx } from './d8-r4-helpers';
import type { Call, Route } from './d12-helpers';

type Row = Record<string, unknown>;

/** Any method, body and query, through the real route (withAuth + JWT). */
export async function callAs(c: Ctx, token: string, route: Route, method: string,
  body: Record<string, unknown> = {}, query: Record<string, string> = {}): Promise<Call> {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, method) as unknown as Row;
  req.body = body; req.query = query;
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: (out.headers.get('retry-after') as string) ?? null,
    body: JSON.stringify(out.state.body ?? null).slice(0, 600), data: (out.state.body as { data?: unknown } | undefined)?.data };
}

/** The error message of a refused call — what "identical answer" compares. */
export const messageOf = (out: Call): string =>
  String((JSON.parse(out.body) as { error?: { message?: string }; message?: string } | null)?.error?.message
    ?? (JSON.parse(out.body) as { message?: string } | null)?.message ?? '');

export async function newAsset(c: Ctx, name = 'Toyota Hilux'): Promise<string> {
  return String(((await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status)
    VALUES (${c.fx.companyId}::UUID, ${`FA-${++c.seq}-${c.fx.tag.slice(-8)}`}, ${`${name} ${c.seq}`}, '2026-01-10', 450000, 5,
      'available') RETURNING id`) as Row[])[0]!.id);
}

export async function newFuel(c: Ctx, assetId: string, amount = 850, date = '2026-06-01'): Promise<string> {
  return String(((await sql`
    INSERT INTO fleet_fuel_transactions (company_id, asset_id, fill_date, litres, amount, supplier_name)
    VALUES (${c.fx.companyId}::UUID, ${assetId}::UUID, ${date}::DATE, 42.5, ${amount}, 'Engen')
    RETURNING id`) as Row[])[0]!.id);
}

export async function newService(c: Ctx, assetId: string, description = '60 000 km service'): Promise<string> {
  return String(((await sql`
    INSERT INTO fleet_service_history (company_id, asset_id, service_date, description, amount)
    VALUES (${c.fx.companyId}::UUID, ${assetId}::UUID, '2026-06-03', ${description}, 4200)
    RETURNING id`) as Row[])[0]!.id);
}

/** Every column a link may write or must leave alone. */
export const linkState = async (id: string) => ((await sql`
  SELECT status, matched_journal_line_id::TEXT AS jl, reconciliation_id::TEXT AS rec,
    linked_asset_id::TEXT AS asset, linked_fleet_fuel_id::TEXT AS fuel, linked_fleet_service_id::TEXT AS service,
    updated_at::TEXT AS at
  FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!;

/** Remove what these suites add beyond the d8-r4 fixture, so `teardown` can drop the company. */
export async function clearFleet(c: Ctx | undefined): Promise<void> {
  if (!c) return;
  await sql`UPDATE bank_transactions SET linked_asset_id = NULL, linked_fleet_fuel_id = NULL, linked_fleet_service_id = NULL
    WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM fleet_fuel_transactions WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM fleet_service_history WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM assets WHERE company_id = ${c.fx.companyId}::UUID`;
}
