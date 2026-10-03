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

type Hook = null | (() => Promise<void>);
const hooks = vi.hoisted(() => ({
  afterSelection: null as Hook, afterKeptCount: null as Hook, afterSecondKeptCount: null as Hook,
  keptCounts: 0, fired: 0, issued: null as null | string[],
}));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  // Every other call returns the real lazy query untouched, so nested `sql` fragments still splice.
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = realSql(strings, ...values);
    const text = strings.join('?');
    hooks.issued?.push(text);
    const isSelection = /^\s*SELECT ci\.id/.test(text) && text.includes('FROM customer_invoices ci');
    const isKeptCount = text.includes('WITH RECURSIVE chain');
    if (isKeptCount) hooks.keptCounts += 1;
    const keptHook = hooks.keptCounts === 2 ? hooks.afterSecondKeptCount : hooks.afterKeptCount;
    const hook = isSelection ? hooks.afterSelection : isKeptCount ? keptHook : null;
    if (!hook) return query;
    return (async () => {
      const rows = await query;
      if (isSelection) hooks.afterSelection = null;
      else if (hooks.keptCounts === 2) hooks.afterSecondKeptCount = null;
      else hooks.afterKeptCount = null;
      hooks.fired += 1;
      await hook();
      return rows;
    })();
  };
  Object.assign(sql, { transaction: (realSql as unknown as Record<string, unknown>).transaction });
  return { ...real, sql };
});

assertDisposable();

const coReopen = randomUUID();
const coRedate = randomUUID();
const coConflict = randomUUID();
const coEscape = randomUUID();
const coRequested = randomUUID();
const coEarly = randomUUID();
const coLinkedLate = randomUUID();
const coLinkedLater = randomUUID();
const companies = [coReopen, coRedate, coConflict, coEscape, coRequested, coEarly, coLinkedLate, coLinkedLater];

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
    expect(failure.message).toMatch(/1 invoice id\(s\) already in the archive/);
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

  it('a request opened on a selected invoice after the selection: ARCHIVE_SET_CHANGED, not a raw 23514', async () => {
    const requested = await addInvoice(coRequested, 'paid');
    const other = await addInvoice(coRequested, 'cancelled');
    hooks.fired = 0;
    hooks.afterSelection = async () => { await addPaystackRequest(coRequested, requested); };

    const failure = await failureOf(coRequested, () => executeArchive(coRequested, CUTOFF, user));

    expect(hooks.fired, 'the hook did not fire').toBe(1);
    expect(failure.code).toBe('ARCHIVE_SET_CHANGED');
    expect(await live(coRequested)).toEqual([requested, other].sort());
    expect(await archived(coRequested)).toEqual([]);
  }, 40000);

  it('a refused run copies and deletes nothing before it refuses', async () => {
    const skipped = await addInvoice(coEarly, 'paid');
    await addPaystackRequest(coEarly, skipped);
    await linkJournal(skipped, await addJournal(coEarly, OLD_DAY, 'posted'));
    await addJournal(coEarly, OLD_DAY, 'posted');
    hooks.afterSelection = null;
    hooks.issued = [];

    const failure = await failureOf(coEarly, () => executeArchive(coEarly, CUTOFF, user));
    const issued = hooks.issued;
    hooks.issued = null;

    expect(failure.code).toBe('ARCHIVE_SKIPPED_INVOICE_JOURNAL');
    expect(issued.some((t) => t.includes('FROM customer_invoices ci')), 'the selection did not run').toBe(true);
    expect(issued.filter((t) => /INSERT INTO archive_(gl|bank|supplier|customer)|DELETE FROM/.test(t))).toEqual([]);
  }, 40000);

  it('a skipped invoice linked to a moved journal after the step-0 check: the second check refuses before the GL deletes', async () => {
    const skipped = await addInvoice(coLinkedLate, 'paid');
    await addPaystackRequest(coLinkedLate, skipped);
    const journal = await addJournal(coLinkedLate, OLD_DAY, 'posted');
    hooks.fired = 0;
    hooks.keptCounts = 0;
    hooks.afterKeptCount = async () => { await linkJournal(skipped, journal); };

    const failure = await failureOf(coLinkedLate, () => executeArchive(coLinkedLate, CUTOFF, user));

    expect(hooks.fired, 'the hook did not fire').toBe(1);
    expect(failure.code).toBe('ARCHIVE_SKIPPED_INVOICE_JOURNAL');
    expect(await ids('SELECT id FROM gl_journal_entries WHERE company_id=$1', [coLinkedLate])).toEqual([journal]);
    expect(await ids('SELECT id FROM archive_gl_journal_entries WHERE company_id=$1', [coLinkedLate])).toEqual([]);
    expect(await live(coLinkedLate)).toEqual([skipped]);
  }, 40000);

  it('a link written by another connection after the second check waits for the run (FOR SHARE)', async () => {
    const skipped = await addInvoice(coLinkedLater, 'paid');
    await addPaystackRequest(coLinkedLater, skipped);
    const journal = await addJournal(coLinkedLater, OLD_DAY, 'posted');
    const writer = { blocked: false, done: false, pending: null as null | Promise<void> };
    hooks.fired = 0;
    hooks.keptCounts = 0;
    hooks.afterSecondKeptCount = async () => {
      const c2 = await pool.connect();
      const pid = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
      writer.pending = (async () => {
        try {
          await c2.query("SET statement_timeout = '20s'");
          await c2.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [skipped, journal]);
          writer.done = true;
        } finally {
          c2.release();
        }
      })();
      for (let i = 0; i < 60 && !writer.done && !writer.blocked; i += 1) {
        const waits = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0]!.n as number;
        writer.blocked = waits > 0;
        if (!writer.blocked) await new Promise((r) => setTimeout(r, 50));
      }
    };

    const failure = await failureOf(coLinkedLater, () => executeArchive(coLinkedLater, CUTOFF, user));
    await writer.pending;

    expect(hooks.fired, 'the hook did not fire').toBe(1);
    expect(writer.blocked, 'the linking UPDATE did not wait for the run').toBe(true);
    // The run saw no link when it moved the journal; the writer's UPDATE landed after the commit.
    expect(failure).toEqual({});
    expect(await ids('SELECT id FROM archive_gl_journal_entries WHERE company_id=$1', [coLinkedLater])).toEqual([journal]);
  }, 60000);
});
