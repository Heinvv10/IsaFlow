/**
 * R-186 review round 1: the archive's customer-invoice selection is an unlocked read, so an
 * invoice can change between it and the delete (say an allocation unwind puts a paid invoice
 * back to 'approved'). The move must re-check the eligibility predicate, and the run must fail
 * whole when what it moved is not what it selected or what it archived. The window is opened
 * deterministically: straight after the selecting SELECT, another connection changes the
 * invoice and commits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  CUTOFF, OLD_DAY, addCompany, addInvoice, addJournal, addPaystackRequest, addUser, cleanup, failureOf, ids, linkJournal, pool, user,
} from './r186-archive.helpers';

const hooks = vi.hoisted(() => ({ afterSelection: null as null | (() => Promise<void>), fired: 0 }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = await realSql(strings, ...values);
    const text = strings.join('?');
    const hook = hooks.afterSelection;
    if (hook && /^\s*SELECT ci\.id/.test(text) && text.includes('FROM customer_invoices ci')) {
      hooks.afterSelection = null;
      hooks.fired += 1;
      await hook();
    }
    return rows;
  };
  Object.assign(sql, { transaction: (realSql as unknown as Record<string, unknown>).transaction });
  return { ...real, sql };
});

assertDisposable();

const coReopen = randomUUID();
const coRedate = randomUUID();
const coConflict = randomUUID();
const coEscape = randomUUID();
const companies = [coReopen, coRedate, coConflict, coEscape];

beforeAll(async () => {
  await addUser();
  for (const id of companies) await addCompany(id);
});
afterAll(async () => { await cleanup(companies); });

const live = (co: string) => ids('SELECT id FROM customer_invoices WHERE company_id=$1', [co]);
const archived = (co: string) => ids('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [co]);

describe('R-186: the move re-checks what it selected', () => {
  it.each([
    ['reopened to approved', coReopen, "status = 'approved', amount_paid = 0"],
    ['re-dated past the cutoff', coRedate, "invoice_date = '2010-01-01'"],
  ])('an invoice %s after the selection survives, and the run fails whole', async (_what, co, change) => {
    const changed = await addInvoice(co, 'paid');
    const other = await addInvoice(co, 'cancelled');
    hooks.fired = 0;
    hooks.afterSelection = async () => {
      await pool.query(`UPDATE customer_invoices SET ${change} WHERE id = $1`, [changed]);
    };

    const failure = await failureOf(co, () => executeArchive(co, CUTOFF, user));

    expect(hooks.fired, 'the hook did not fire').toBe(1);
    expect(failure.code).toBe('ARCHIVE_SET_CHANGED');
    expect(await live(co)).toEqual([changed, other].sort());
    expect(await archived(co)).toEqual([]);
  }, 40000);

  it('an invoice already in the archive is not deleted unarchived: the run fails whole', async () => {
    const clash = await addInvoice(coConflict, 'paid');
    await pool.query(
      "INSERT INTO archive_customer_invoices(id,company_id,invoice_number,status) VALUES($1,$2,'R186-OLD','paid')",
      [clash, coConflict]);
    hooks.afterSelection = null;

    const failure = await failureOf(coConflict, () => executeArchive(coConflict, CUTOFF, user));

    expect(failure.code).toBe('ARCHIVE_SET_CHANGED');
    expect(await live(coConflict)).toEqual([clash]);
    const kept = (await pool.query('SELECT invoice_number FROM archive_customer_invoices WHERE id=$1', [clash])).rows;
    expect(kept).toEqual([{ invoice_number: 'R186-OLD' }]);
  }, 40000);

  it('a skipped invoice reopened after the selection still keeps its journal: the run refuses', async () => {
    const skipped = await addInvoice(coEscape, 'paid');
    await addPaystackRequest(coEscape, skipped);
    const journal = await addJournal(coEscape, OLD_DAY, 'posted');
    await linkJournal(skipped, journal);
    hooks.fired = 0;
    hooks.afterSelection = async () => {
      await pool.query("UPDATE customer_invoices SET status = 'approved', amount_paid = 0 WHERE id = $1", [skipped]);
    };

    const failure = await failureOf(coEscape, () => executeArchive(coEscape, CUTOFF, user));

    expect(hooks.fired, 'the hook did not fire').toBe(1);
    expect(failure.code).toBe('ARCHIVE_SKIPPED_INVOICE_JOURNAL');
    expect(await ids('SELECT id FROM gl_journal_entries WHERE company_id=$1', [coEscape])).toEqual([journal]);
    expect(await ids('SELECT id FROM archive_gl_journal_entries WHERE company_id=$1', [coEscape])).toEqual([]);
  }, 40000);
});
