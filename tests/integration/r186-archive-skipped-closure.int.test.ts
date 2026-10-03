/**
 * R-186 review round 1, item 2 (orchestrator's option b): an invoice the archive skips keeps its
 * journals. `customer_invoices.gl_journal_entry_id` has no FK, so the run used to archive and
 * delete a skipped invoice's journal (or its reversal) by date and leave the live invoice
 * pointing at the archive. Now, when a skipped invoice's journal or any journal in its reversal
 * chain (`reversal_of_id`, both directions) is one the run would move (posted, before the
 * cutoff, this company), the run refuses with ARCHIVE_SKIPPED_INVOICE_JOURNAL and rolls back
 * whole. Validation predicts the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { validateArchive } from '@/modules/accounting/services/core/archiveQueryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  CUTOFF, LATE_DAY, OLD_DAY, addCompany, addInvoice, addJournal, addPaystackRequest, addStitchRequest, addUser, cleanup,
  drive, failureOf, ids, linkJournal, user,
} from './r186-archive.helpers';

assertDisposable();

const co = { forward: randomUUID(), backward: randomUUID(), direct: randomUUID(), stitch: randomUUID(), outside: randomUUID(),
  tenant: randomUUID(), foreign: randomUUID() };
const companies = Object.values(co);
const REFUSAL = /payment request/i;

/** A cancelled invoice a payment request references (skipped), plus a free one beside it. */
async function skippedInvoice(company: string, stitch = false): Promise<{ skipped: string; free: string }> {
  const skipped = await addInvoice(company, 'cancelled');
  await (stitch ? addStitchRequest : addPaystackRequest)(company, skipped);
  return { skipped, free: await addInvoice(company, 'cancelled') };
}
const journals = (c: string) => ids('SELECT id FROM gl_journal_entries WHERE company_id=$1', [c]);
const archivedJournals = (c: string) => ids('SELECT id FROM archive_gl_journal_entries WHERE company_id=$1', [c]);
const liveInvoices = (c: string) => ids('SELECT id FROM customer_invoices WHERE company_id=$1', [c]);
const archivedInvoices = (c: string) => ids('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [c]);
const validationErrors = async (c: string) => (await drive(c, () => validateArchive(c, CUTOFF))).errors;

beforeAll(async () => {
  await addUser();
  for (const id of companies) await addCompany(id);
});
afterAll(async () => { await cleanup(companies); });

describe('R-186: a skipped invoice keeps its journals, or the run refuses', () => {
  it.each([
    // LEGACY rows: an original left at status='reversed' (the run would not move it) that the
    // invoice still points at, its reversal posted before the cutoff (the run would). Today's
    // cancel keeps the original 'posted' and NULLs the link: r186-archive-current-cancel.
    ['its reversal is in the window (legacy status=reversed original)', 'forward', async (c: string) => {
      const original = await addJournal(c, OLD_DAY, 'reversed');
      await addJournal(c, OLD_DAY, 'posted', original);
      return original;
    }],
    ['the journal it reverses is in the window', 'backward', async (c: string) => {
      const reversed = await addJournal(c, OLD_DAY, 'posted');
      return addJournal(c, LATE_DAY, 'posted', reversed);
    }],
    ['its own journal is in the window', 'direct', async (c: string) => addJournal(c, OLD_DAY, 'posted')],
    ['a Stitch request refers to it and its own journal is in the window', 'stitch',
      async (c: string) => addJournal(c, OLD_DAY, 'posted')],
  ] as const)('refuses whole when %s', async (_shape, key, journalOf) => {
    const c = co[key];
    const { skipped, free } = await skippedInvoice(c, key === 'stitch');
    await linkJournal(skipped, await journalOf(c));
    const unrelated = await addJournal(c, OLD_DAY, 'posted');
    const before = await journals(c);

    const failure = await failureOf(c, () => executeArchive(c, CUTOFF, user));

    expect(failure.code).toBe('ARCHIVE_SKIPPED_INVOICE_JOURNAL');
    // Validation predicts the refusal (the refused run left the state as it was).
    expect(await validationErrors(c)).toEqual(expect.arrayContaining([expect.stringMatching(REFUSAL)]));
    expect(await journals(c)).toEqual(before);
    expect(before).toContain(unrelated);
    expect(await archivedJournals(c)).toEqual([]);
    expect(await liveInvoices(c)).toEqual([skipped, free].sort());
    expect(await archivedInvoices(c)).toEqual([]);
  }, 40000);

  it('completes when no journal of the skipped invoice is one the run moves (legacy status=reversed original)', async () => {
    const c = co.outside;
    const { skipped, free } = await skippedInvoice(c);
    // LEGACY rows: a status='reversed' original in the window (not moved), its reversal after
    // the cutoff (not moved).
    const original = await addJournal(c, OLD_DAY, 'reversed');
    await addJournal(c, LATE_DAY, 'posted', original);
    await linkJournal(skipped, original);
    // The free invoice's own in-window journal moves with it: no reason to refuse.
    const freeJournal = await addJournal(c, OLD_DAY, 'posted');
    await linkJournal(free, freeJournal);

    expect(await validationErrors(c)).not.toEqual(expect.arrayContaining([expect.stringMatching(REFUSAL)]));
    const result = await drive(c, () => executeArchive(c, CUTOFF, user), { commit: true });

    expect(result.invoicesSkipped).toBe(1);
    expect(result.invoicesArchived).toBe(1);
    expect(await liveInvoices(c)).toEqual([skipped]);
    expect(await archivedInvoices(c)).toEqual([free]);
    expect(await archivedJournals(c)).toEqual([freeJournal]);
    expect(await journals(c)).toEqual(expect.arrayContaining([original]));
  }, 40000);

  it('does not reach into another company\'s journals, which the run never moves', async () => {
    const c = co.tenant;
    const { skipped, free } = await skippedInvoice(c);
    const own = await addJournal(c, LATE_DAY, 'posted');
    await linkJournal(skipped, own);
    // Forged: another company's posted, in-window journal claims to reverse this one.
    await addJournal(co.foreign, OLD_DAY, 'posted', own);
    // Forged: a second skipped invoice names another company's in-window journal directly.
    const pointsAway = await addInvoice(c, 'cancelled');
    await addPaystackRequest(c, pointsAway);
    await linkJournal(pointsAway, await addJournal(co.foreign, OLD_DAY, 'posted'));

    const result = await drive(c, () => executeArchive(c, CUTOFF, user), { commit: true });

    expect(result.invoicesSkipped).toBe(2);
    expect(await archivedInvoices(c)).toEqual([free]);
    expect(await liveInvoices(c)).toEqual([skipped, pointsAway].sort());
  }, 40000);
});
