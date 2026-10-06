/**
 * DOCNUM (sec-docnum F2): a supplier return whose number is already taken answers 409, and writes nothing.
 *
 * Supplier returns take an explicit number from the company's `supplier_return` sequence (RTN...). Settings lets a
 * user set that sequence's next number back below one already issued. Before migration 859 the next return then
 * stored a duplicate number silently; with uq_credit_notes_company_number it fails 23505, which the route answered
 * as a masked 500 — and since the 500 rolls back the reservation too, every retry failed the same way with nothing
 * telling the user why. The route now answers 409 naming the fix. The reservation and the INSERT share a savepoint,
 * so the 409 (which withAuth COMMITs) leaves neither the sequence nor credit_notes changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supplierReturns from '../../pages/api/accounting/supplier-returns';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture | undefined;
let token = '';

async function returnsAndNext(): Promise<{ numbers: string[]; next: number }> {
  const numbers = ((await sql`SELECT credit_note_number AS n FROM credit_notes
    WHERE company_id = ${fx!.companyId}::UUID ORDER BY created_at`) as Row[]).map((r) => String(r.n));
  const next = Number(((await sql`SELECT next_number FROM company_document_numbers
    WHERE company_id = ${fx!.companyId}::UUID AND document_type = 'supplier_return'`) as Row[])[0]?.next_number);
  return { numbers, next };
}

describeIfDb('DOCNUM: supplier return number already taken', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('DOCNUM-RTN', DATABASE_URL!);
    token = await seedRouteUser(fx, 'docnum-rtn');
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${fx.companyId}::UUID`;
    await dropRouteUser(fx);
    await dropFixture(fx);
  }, 60000);

  it('the sequence set back below an issued number: 409 naming the fix, nothing written', async () => {
    const body = { supplierId: fx!.supplierId, amount: 10, reason: 'docnum' };
    const first = await callRoute(fx!, token, supplierReturns, body);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const before = await returnsAndNext();
    expect(before.numbers).toHaveLength(1);

    // What the settings PUT does for { documentType: 'supplier_return', nextNumber: 1 }.
    await sql`UPDATE company_document_numbers SET next_number = 1
      WHERE company_id = ${fx!.companyId}::UUID AND document_type = 'supplier_return'`;

    const second = await callRoute(fx!, token, supplierReturns, body);
    expect(second.statusCode, JSON.stringify(second.body)).toBe(409);
    expect(JSON.stringify(second.body)).toContain(`Supplier return number ${before.numbers[0]} is already in use`);
    expect(JSON.stringify(second.body)).toContain('Settings');
    expect(await returnsAndNext(), 'the 409 must leave the sequence and credit_notes as they were')
      .toEqual({ numbers: before.numbers, next: 1 });
  }, 60000);
});
