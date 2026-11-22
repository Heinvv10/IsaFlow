/**
 * Migration 1018, round 11, through the real services as a login of the production login's shape
 * (helpers/appLoginWorld). M1: reverseJournalEntry claims, creates and links in one transaction, so it meets the
 * born-here rule (and a re-reversal of its contra does too), while an independent posting with the same lines stays
 * unlinkable. G2: a late-claim original reverses as a pair and the companion's contra carries its base negated, so the
 * commit-time base check passes for the one writer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, refused, seedFreeze, asApp, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';
import { draftBill, dropLateFixture, lockPeriod, P, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let late: LateFixture;
let world: AppWorld;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const inForce = async (je: string) => (await one(sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`)).f;

describeIfDisposable('ledger column immutability, round 11: the reversal service as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    late = await seedLateFixture('LF11', process.env.DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${late.userId}, ${`lf11-${late.userId}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${late.companyId}::UUID, ${late.userId}, 'admin')`;
    await lockPeriod(late, P.start, P.end);
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (late) {
      await sql`DELETE FROM company_document_numbers WHERE company_id = ${late.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${late.companyId}::UUID`;
      await sql`DELETE FROM users WHERE id = ${late.userId}`;
      await dropLateFixture(late);
    }
    if (z) await dropFreeze(z);
  }, 120000);

  it('M1 the service reverses and re-reverses (born here each time); an independent twin of the original is never linked', async () => {
    const who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    const legs: Leg[] = [[z.ar, 250, 0], [z.revenue, 0, 250]];
    const j1 = await journal(z, legs);
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const r1 = await world.run(who, () => reverseJournalEntry(z.f.fx.companyId, j1, z.f.fx.userId));
    const stamps = await one(sql`SELECT c.created_at = o.reversed_at AS same FROM gl_journal_entries c JOIN gl_journal_entries o ON o.id = c.reversal_of_id WHERE c.id = ${r1.id}::UUID`);
    expect(stamps.same).toBe(true);
    const j2 = await journal(z, legs); // an independent posting with J1's lines
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r1.id, j2])),
      /claimed the journal and created the reversal/);
    expect([await inForce(j1), await inForce(j2)]).toEqual([false, true]);
    const r2 = await world.run(who, () => reverseJournalEntry(z.f.fx.companyId, r1.id, z.f.fx.userId)); // the undo of the undo
    expect((await one(sql`SELECT reversal_of_id AS r FROM gl_journal_entries WHERE id = ${r2.id}::UUID`)).r).toBe(r1.id);
    expect(await inForce(j1)).toBe(true);
  });

  it('G2 a late-claim original reverses as a pair; the companion\'s contra carries the base negated and commits', async () => {
    const who = { userId: late.userId, companyId: late.companyId };
    const { approveSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const bill = await draftBill(late, '2026-06-12');
    const approved = await world.run(who, () => approveSupplierInvoice(late.companyId, bill.id, late.userId, { allowLateInputClaim: true }));
    const companion = approved.lateClaim!.companionEntryId;
    const original = String((await one(sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).je);
    const rev = await world.run(who, () => reverseJournalEntry(late.companyId, original, late.userId));
    const contra = rev.lateClaimReversal!.id;
    expect((await one(sql`SELECT reversal_of_id AS r FROM gl_journal_entries WHERE id = ${contra}::UUID`)).r).toBe(companion);
    expect((await one(sql`SELECT public.gl_late_claim_bases_negated(${contra}::UUID, ${companion}::UUID) AS n`)).n).toBe(true);
    const bases = await one(sql`SELECT (SELECT SUM(late_claim_base) FROM gl_journal_lines WHERE journal_entry_id = ${companion}::UUID) AS o,
      (SELECT SUM(late_claim_base) FROM gl_journal_lines WHERE journal_entry_id = ${contra}::UUID) AS r`);
    expect(Number(bases.o)).toBeGreaterThan(0);
    expect(Number(bases.r)).toBe(-Number(bases.o));
  });
});
