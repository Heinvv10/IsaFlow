/**
 * pages/api/accounting/supplier-merge.ts — the inline-SQL merge path — against
 * a real database, auth wrappers passed through. Pins that it refuses a merge
 * across differing DRC VAT flags before moving anything, and the race the
 * ledger review reproduced: a flag set on the SOURCE by a concurrent,
 * still-uncommitted request must not be carried through the merge.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));

import { sql } from '@/lib/neon';
import supplierMerge from '../../pages/api/accounting/supplier-merge';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, runOn, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

function response() {
  const state: { status?: number; body?: { error?: { message?: string } } } = {};
  const res = {
    status: (s: number) => { state.status = s; return res; },
    json: (b: typeof state.body) => { state.body = b; return res; },
    setHeader: () => res,
  };
  return { res: res as unknown as NextApiResponse, state };
}

/** One request: its own transaction, committed whatever the status (as withAuth does below 500). */
async function merge(source_id: string, target_id: string) {
  const c = await fx.pool.connect();
  const { res, state } = response();
  try {
    await c.query('BEGIN');
    await runOn(fx, c, () => supplierMerge(
      { method: 'POST', companyId: fx.companyId, user: { id: fx.userId }, query: {},
        body: { source_id, target_id } } as unknown as NextApiRequest, res));
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return state;
}

const billSupplier = async (id: string) => String(((await sql`
  SELECT supplier_id FROM supplier_invoices WHERE id = ${id}::UUID`) as { supplier_id: string }[])[0]!.supplier_id);

describeIfDb('supplier-merge route — DRC flags must agree', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test merges suppliers.');
    fx = await seedFixture('SMR', DATABASE_URL!);
  }, 120000);
  afterAll(async () => { await dropFixture(fx); }, 120000);

  it('refuses differing flags with a 400 and moves nothing', async () => {
    const flagged = await seedSupplier(fx, 'R Flagged');
    const plain = await seedSupplier(fx, 'R Plain');
    await sql`UPDATE suppliers SET subject_to_drc_vat = true WHERE id = ${flagged}::UUID`;
    const bill = await seedBill(fx, { number: 'SMR-1', date: '2026-05-01', total: 100, supplierId: plain });
    const r = await merge(plain, flagged);
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toContain('Subject to DRC VAT');
    expect(await billSupplier(bill)).toBe(plain);
  });

  it('a flag set on the source by an uncommitted request is seen, not merged through', async () => {
    const source = await seedSupplier(fx, 'R Source');
    const target = await seedSupplier(fx, 'R Target');
    const bill = await seedBill(fx, { number: 'SMR-2', date: '2026-05-01', total: 100, supplierId: source });
    const b = await fx.pool.connect();
    let r: Awaited<ReturnType<typeof merge>>;
    try {
      await b.query('BEGIN');
      await b.query('UPDATE suppliers SET subject_to_drc_vat = true WHERE id = $1', [source]);
      const pending = merge(source, target);          // blocks on the source row
      await new Promise((resolve) => setTimeout(resolve, 300));
      await b.query('COMMIT');
      r = await pending;
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      b.release();
    }
    expect(r!.status).toBe(400);
    expect(await billSupplier(bill)).toBe(source);
  });
});
