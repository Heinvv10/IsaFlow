// R-051 review round 1 — the VAT adjustment action route answers each refusal for what it
// is: a malformed id is a 400 with a reason, a cancel of a non-draft is refused (404/400),
// a contended cancel is a retryable 409, and a journal-number collision with a concurrent
// posting (23505 on uq_gl_je_company_entry_number, raised inside approve's savepoint) is a
// retryable 409 rather than a generic "Action failed". Same fixture as
// r051-vat-adjustment-approve.int.test.ts; own companies.
import { describe, expect, it } from 'vitest';
import {
  act, adjustment, company, journals, otherCompany, pool, seedAdjustment, useR051Fixture, user, waitBlocked,
  type Out,
} from './r051-vat-adjustment.helpers';

useR051Fixture();

describe('R-051: vat-adjustments-action answers each refusal for what it is', () => {
  it('a malformed id is a 400 that says so, and writes nothing', async () => {
    const out = await act('approve', 'abc');

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/uuid/i);
  });

  it('cancelling an approved adjustment is refused with its status, and it stays approved', async () => {
    const id = await seedAdjustment();
    expect((await act('approve', id)).statusCode).toBe(200);

    const out = await act('cancel', id);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/approved/i);
    expect((await adjustment(id)).status).toBe('approved');
  });

  it("cancelling another company's adjustment answers 404 and leaves it draft", async () => {
    const foreign = await seedAdjustment(otherCompany);

    const out = await act('cancel', foreign);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
    expect((await pool.query('SELECT status FROM vat_adjustments WHERE id=$1', [foreign])).rows[0].status).toBe('draft');
  });

  it('a cancel that waits on a held adjustment answers 409, and cancels nothing', async () => {
    const id = await seedAdjustment();
    const c = await pool.connect();
    let out: Out;
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM vat_adjustments WHERE id=$1 FOR UPDATE', [id]);
      out = await Promise.race([act('cancel', id), new Promise<Out>((_, reject) =>
        setTimeout(() => reject(new Error('cancel waited on the held row for 15s')), 15_000))]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
    expect((await adjustment(id)).status).toBe('draft');
  }, 30_000);

  it('a journal-number collision with a concurrent posting is a retryable 409, and writes nothing', async () => {
    const id = await seedAdjustment();
    // Another posting in the same company and year takes the next journal number, uncommitted.
    const other = await pool.connect();
    let out: Promise<Out> | undefined;
    try {
      await other.query('BEGIN');
      const otherPid = (await other.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      await other.query(
        `INSERT INTO gl_journal_entries(company_id,entry_date,description,source,status,created_by)
         VALUES($1,'2026-08-15','R051 concurrent posting','manual','draft',$2)`, [company, user]);
      // The approval mints the same number and waits on the unique index for the other to settle.
      out = act('approve', id);
      await waitBlocked([otherPid]);
      await other.query('COMMIT');
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
    const res = await out!;

    expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
    expect(await journals(id)).toHaveLength(0);
    expect(await adjustment(id)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  }, 30_000);
});
