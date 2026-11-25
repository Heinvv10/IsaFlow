/**
 * Migration 1018, rule 1: gl_journal_entries.reversal_of_id. An app_user (and migration_admin / platform_admin) can
 * neither INSERT a journal carrying one nor point a journal at one that it is not the exact negation of, nor change or
 * clear one once set. Each forgery runs as app_user under RLS and the member's claims; the positive controls show a real
 * contra still links, by hand and through reverseJournalEntry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, asRole, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row, linkAsApp } from './helpers/ledgerFreezeFixture';
import { inAppUserTx } from './helpers/appUserTx';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const link = (contra: string, original: string) => (c: import('pg').PoolClient) =>
  linkAsApp(c, contra, original);
const linkOf = async (id: string) => ((await sql`SELECT reversal_of_id FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!.reversal_of_id;
/** An original already claimed as reversed, and a posted journal that is (or is not) its contra. */
async function pair(contraLegs?: Leg[]): Promise<{ original: string; contra: string }> {
  const original = await journal(z, legs, { claimed: true });
  return { original, contra: await journal(z, contraLegs ?? negate(legs)) };
}

describeIfDisposable('ledger column immutability: the reversal link (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.expense, 100, 0], [z.ap, 0, 100]];
  }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('an INSERT carrying a reversal_of_id is refused, to a real journal or any other', async () => {
    const { original } = await pair();
    for (const target of [original, crypto.randomUUID()]) {
      await refused(asApp(z, (c) => c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, reversal_of_id)
         VALUES ($1, '2026-06-11', 'forged', 'manual', 'draft', $2, $3)`, [z.f.fx.companyId, z.f.fx.userId, target])), /never on insert/);
    }
  });

  it('a contra that is the exact negation of a claimed original links, by hand, once', async () => {
    const { original, contra } = await pair();
    await asApp(z, link(contra, original), { commit: true });
    expect(await linkOf(contra)).toBe(original);
    const other = await journal(z, legs, { claimed: true });
    await refused(asApp(z, link(contra, other)), /fixed once set/);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE id = $1', [contra])), /fixed once set/);
    expect(await linkOf(contra)).toBe(original);
  });

  it.each([
    ['an amount off by a cent', (l: Leg[]): Leg[] => [[l[0]![0], 0, 100.01], [l[1]![0], 100, 0]]],
    ['the wrong account', (l: Leg[]): Leg[] => [[z.revenue, 0, 100], [l[1]![0], 100, 0]]],
    ['an extra line', (l: Leg[]): Leg[] => [...negate(l), [z.expense, 0, 0]]],
    ['a missing line', (l: Leg[]): Leg[] => [negate(l)[0]!]],
    ['the same direction, not swapped', (l: Leg[]): Leg[] => l],
    ['no lines at all (an empty "reversal")', (): Leg[] => []],
  ])('a journal that is not the exact negation is refused: %s', async (_name, build) => {
    const { original, contra } = await pair(build(legs));
    await refused(asApp(z, link(contra, original)), /exact negation/);
    expect(await linkOf(contra)).toBeNull();
  });

  it('refuses a draft contra, itself, a loop and another company\'s journal', async () => {
    const { original } = await pair();
    await refused(asApp(z, link(await journal(z, negate(legs), { status: 'draft' }), original)), /only a posted journal/);
    const self = await journal(z, legs, { claimed: true });
    await refused(asApp(z, link(self, self)), /reverse itself/);
    const a = await journal(z, legs, { claimed: true });
    const b = await journal(z, negate(legs), { claimed: true });
    await asApp(z, link(b, a), { commit: true });
    await refused(asApp(z, link(a, b)), /cannot loop/);
    const foreign = await journal(z, [[z.f.acct.foreign, 100, 0], [z.f.acct.foreign, 0, 100]], { claimed: true, company: z.f.other.companyId });
    await refused(asApp(z, link(await journal(z, negate(legs)), foreign)), /posted journal of its own company/);
  });

  it('refuses an original that is not posted, an empty pair, and (to a role that sees every tenant) another company\'s journal', async () => {
    for (const status of ['draft', 'reversed']) {
      const original = await journal(z, legs, { status, claimed: true });
      await refused(asApp(z, link(await journal(z, negate(legs)), original)), /posted journal of its own company/);
    }
    await refused(asApp(z, link(await journal(z, []), await journal(z, [], { claimed: true }))), /exact negation/);
    // A legacy shape: the original's journal row is company B's, its lines carry A's accounts and company, so only the company test can refuse it.
    const original = await journal(z, legs, { claimed: true, company: z.f.other.companyId, lineCompany: z.f.fx.companyId });
    await refused(asRole(z, 'platform_admin', link(await journal(z, negate(legs)), original)), /posted journal of its own company/);
  });

  it('migration_admin and platform_admin are refused the same forgery', async () => {
    for (const role of ['migration_admin', 'platform_admin']) {
      const { original, contra } = await pair([[z.revenue, 0, 100], [z.ap, 100, 0]]);
      await refused(asRole(z, role, link(contra, original)), /exact negation/);
    }
  });

  it('the reversed_at stamp alone does not make a link: an original claimed in another transaction does not link (round 11), a stamped one is not enough', async () => {
    const unstamped = await journal(z, legs);
    const contra = await journal(z, negate(legs));
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [unstamped, contra])), /claimed the journal and created the reversal/);
    await asApp(z, link(contra, unstamped), { commit: true }); // claimed and born in the linking transaction
    expect(await linkOf(contra)).toBe(unstamped);
    const stamped = await journal(z, legs, { claimed: true });
    await refused(asApp(z, link(await journal(z, legs), stamped)), /exact negation/);
  });

  it('a journal a document holds is never itself linked as a reversal (and the check waits for a document linking it)', async () => {
    const original = await journal(z, legs);
    const doc = original;
    for (const kind of ['customer_invoices', 'supplier_invoices', 'credit_notes'] as const) {
      const held = await journal(z, negate(legs));
      await document(z, kind, { link: held });
      await refused(asApp(z, link(held, original)), /a document holds/);
      expect(await linkOf(held), kind).toBeNull();
    }
    // Round 11 M1: the old race here (a document linking a free journal in one session while another session made it a
    // contra) is unreachable now: a contra is born in the transaction that links it, so no other session can see it,
    // let alone link a document to it. The advisory lock the race tested still serialises the link with the root's.
    expect(doc).toBeTruthy();
  });

  it('reverseJournalEntry as app_user still reverses, links the contra, and reverses a reversal', async () => {
    const created = await inAppUserTx(z.f.fx, async () => {
      const je = await createJournalEntry(z.f.fx.companyId, { entryDate: '2026-06-12', description: 'LCI service', source: 'manual',
        lines: [{ glAccountId: z.expense, debit: 40, credit: 0 }, { glAccountId: z.ap, debit: 0, credit: 40 }] }, z.f.fx.userId);
      await postJournalEntry(z.f.fx.companyId, je.id, z.f.fx.userId);
      return je.id;
    });
    const contra = (await inAppUserTx(z.f.fx, () => reverseJournalEntry(z.f.fx.companyId, created, z.f.fx.userId))).id;
    expect(await linkOf(contra)).toBe(created);
    const again = (await inAppUserTx(z.f.fx, () => reverseJournalEntry(z.f.fx.companyId, contra, z.f.fx.userId))).id;
    expect(await linkOf(again)).toBe(contra);
  });
});
