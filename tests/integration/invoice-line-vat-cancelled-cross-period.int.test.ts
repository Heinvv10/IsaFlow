/**
 * A document dated in a FILED VAT period and cancelled later. The period is locked the way the product locks it
 * (lockVatPeriod, with the figures computeVatLockFigures gives), so the cancel's reversal rolls to the first day after
 * the lock (journalEntryReversalDate / journalEntryReversalVatRoll). The filed period P1 must read exactly what it read
 * before the cancel, and P2 the equal and opposite of what the cancelled document contributed to P1. Both readers
 * (the box basis and the nil-rated reader) apply the K-032 pair rule from one definition (vatCancelledPairSql): a pair
 * straddling the period edge is real on both sides. The nil-rated reader used to drop a cancelled credit note's
 * original from its own period whenever queried, so the FILED figure moved (returnDrift reported drift), and a legacy
 * zero-VAT note's reversal (uncoded) counted nowhere.
 *
 * Drift is judged by returnDrift.driftOf, the check the versions route runs, against a version whose figures are built
 * from the same sources finaliseVatReturn records (report totals and boxes, buildVat201SarsFields' form). The version
 * row itself is not written: tax_return_versions refuses DELETE, and driftOf reads only the figures and the period.
 *
 * A cancelled INVOICE: its cancel nulls gl_journal_entry_id, so its journal is in no cancelled list and its coded legs
 * count in both periods. A LEGACY zero-VAT invoice's uncoded line counts only while an untaxed document links its
 * journal; the cancel removes that link, so the FILED period's field 2 drops after the fact. That needs the link kept
 * (or recorded elsewhere), not a reader change: the last case pins the defect as it stands (reports/.claude.md OPEN).
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { listNilRatedLines, type NilRatedField } from '@/modules/accounting/services/reports/vat201NilRatedDrill';
import { buildVat201SarsFields } from '@/modules/accounting/services/reports/vat201SarsFields';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { UNCODED_REVENUE_NOTE, driftOf } from '@/modules/accounting/services/returns/returnDrift';
import type { ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { typeLines } from './helpers/lineVatFixture';
import { closePeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));
vi.mock('@/modules/accounting/services/audit/autoSnapshotQueue', () => ({ scheduleAutoSnapshot: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/budgetRollQueue', () => ({ scheduleBudgetRoll: vi.fn() }));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
type Period = [string, string];
type Items = { description: string; unitPrice: number }[];

async function approvedInvoice(date: string, items: Items, taxRate: number,
  types?: Record<string, [string, number]>, tax?: number): Promise<string> {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, taxRate, items,
  }))).id;
  if (types) await typeLines(id, types, { tax });
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}

async function approvedNote(invoiceId: string, date: string, subtotal: number, taxAmount?: number): Promise<string> {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate: date, subtotal,
    taxRate: taxAmount ? 15 : 0, ...(taxAmount !== undefined ? { taxAmount } : {}),
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId));
  return cn.id;
}

/** Fields 1, 2, 3 and 5, as the VAT201 route assembles them (box basis less the nil-rated give-back, and fields 2/3). */
async function fields([from, to]: Period): Promise<number[]> {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, from, to));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
}

/** The drill-down's lines for fields 2, 2A and 3 sum to the aggregate the form reads (same pair rule, same CTEs). */
async function expectDrillTies([from, to]: Period): Promise<void> {
  const n = await inTx(f.fx, () => getNilRatedSupplies(f.fx.companyId, from, to));
  const sum = async (field: NilRatedField) => Math.round((await inTx(f.fx, () =>
    listNilRatedLines(f.fx.companyId, from, to, field))).reduce((t, l) => t + l.amount * 100, 0)) / 100;
  expect([await sum('2'), await sum('2A'), await sum('3')]).toEqual([n.zeroRated - n.exported, n.exported, n.exempt]);
}

/** Lock P1 as the product does and return the version finalise would record for it. */
async function lockAndRecord([from, to]: Period): Promise<ReturnVersion> {
  return inTx(f.fx, async () => {
    const { figures, report } = await computeVatLockFigures(f.fx.companyId, from, to);
    const sarsForm = buildVat201SarsFields(report, await getNilRatedSupplies(f.fx.companyId, from, to));
    const { lock, created } = await lockVatPeriod(f.fx.companyId, from, to, figures,
      { userId: f.fx.userId, actorType: 'human' });
    expect(created).toBe(true);
    const at = new Date().toISOString();
    return {
      id: crypto.randomUUID(), formType: 'VAT201', periodStart: from, periodEnd: to, versionNo: 1, status: 'finalised',
      figures: { outputTax: lock.outputTax, inputTax: lock.inputTax, netVat: lock.netVat, sarsFields: report.boxes, sarsForm },
      postedThrough: lock.postedThrough, vatPeriodLockId: lock.id, sarsSubmissionId: null, filedReference: null,
      amendsVersionId: null, finalisedBy: f.fx.userId, finalisedAt: at, filedBy: null, filedAt: null, amendedBy: null,
      amendReason: null, amendedAt: null, filingFileSha256: null, filingFileKind: null, filingFileAt: null, filingFileBy: null,
    };
  });
}

/** The dates of every reversal journal of the company, oldest first. */
async function reversalDates(): Promise<string[]> {
  return ((await sql`SELECT entry_date::TEXT AS d FROM gl_journal_entries
    WHERE company_id = ${f.fx.companyId}::UUID AND reversal_of_id IS NOT NULL ORDER BY created_at`) as { d: string }[])
    .map((r) => r.d);
}

/**
 * Documents already seeded in P1: lock P1, cancel, and assert the reversal's date, then P1 after (default: as before,
 * and no drift) and P2 after. `reversalDate` defaults to P2's first day (the VAT lock's roll).
 */
async function crossPeriod(p1: Period, p2: Period, cancelIt: () => Promise<unknown>, expected: {
  p1: number[]; p2After: number[]; p1After?: number[]; drifts?: boolean; reversalDate?: string;
}): Promise<string[] | undefined> {
  expect(await fields(p1)).toEqual(expected.p1);
  expect(await fields(p2)).toEqual([0, 0, 0, 0]);
  const version = await lockAndRecord(p1);
  const before = (await reversalDates()).length;
  await cancelIt();
  expect((await reversalDates()).slice(before)).toEqual([expected.reversalDate ?? p2[0]]);
  expect(await fields(p1)).toEqual(expected.p1After ?? expected.p1);
  expect(await fields(p2)).toEqual(expected.p2After);
  await expectDrillTies(p1);
  await expectDrillTies(p2);
  const drift = await inTx(f.fx, () => driftOf(f.fx.companyId, version));
  expect(drift.drifted).toBe(expected.drifts ?? false);
  return drift.notes;
}

/** Run `fn` with the process clock on `day` (Date only; timers stay real): the cancel dates a fallback reversal today. */
async function onDay<T>(day: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${day}T12:00:00+02:00`));
  try { return await fn(); } finally { vi.useRealTimers(); }
}

/**
 * The fixture's one open 2026 period is split into Jan..`end` and the rest of 2026 (layout only, as the fixture itself
 * inserts its period), then Jan..`end` is CLOSED through the product's close: `closePeriod`, what POST
 * /fiscal-periods-action `close` calls (status and prior-period guards, the readiness gate, under the row lock).
 */
async function closeFiscalThrough(end: string): Promise<void> {
  const c = f.fx.companyId;
  const first = ((await sql`UPDATE fiscal_periods SET end_date = ${end}::DATE WHERE company_id = ${c}::UUID
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES (${c}::UUID, ${`FY26b ${f.fx.tag}`}, 2, 2026, ${end}::DATE + 1, '2026-12-31', 'open')`;
  const closed = await inTx(f.fx, () => closePeriod(c, first, f.fx.userId));
  expect(closed.status).toBe('closed');
}

const MIXED_ITEMS: Items = [
  { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
];
const MIXED_TYPES: Record<string, [string, number]> = { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] };
const EXEMPT: [Items, Record<string, [string, number]>] = [[{ description: 'Rent', unitPrice: 1000 }], { Rent: ['exempt', 0] }];
const LEGACY: Items = [{ description: 'Export', unitPrice: 1000 }];
const cancelNote = (id: string) => () => inTx(f.fx, () => cancelCreditNote(f.fx.companyId, id, f.fx.userId));
const cancelInvoice = (id: string) => () => inTx(f.fx, () => cancelCustomerInvoice(f.fx.companyId, id, f.fx.userId));
const teardown = async () => {
  if (!f) return;
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${f.fx.companyId}::UUID`;
  await dropLineRevenue(f);
};

describeIfDisposable('a credit note dated in a VAT-locked period and cancelled later', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(teardown);

  it('(i) a typed mixed invoice with a proportional note of 150 + 15.00: P1 as filed, P2 the reversal', async () => {
    const inv = await approvedInvoice('2026-01-10', MIXED_ITEMS, 15, MIXED_TYPES, 150);
    const cn = await approvedNote(inv, '2026-01-20', 150, 15);
    await crossPeriod(['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], cancelNote(cn),
      { p1: [900, 270, 180, 135], p2After: [100, 30, 20, 15] });
  });

  it('(ii) a typed exempt invoice of 1000 with a full note: P1 as filed (0), P2 field 3 = 1000', async () => {
    const inv = await approvedInvoice('2026-03-10', EXEMPT[0], 0, EXEMPT[1], 0);
    const cn = await approvedNote(inv, '2026-03-20', 1000);
    await crossPeriod(['2026-03-01', '2026-03-31'], ['2026-04-01', '2026-04-30'], cancelNote(cn),
      { p1: [0, 0, 0, 0], p2After: [0, 0, 1000, 0] });
  });

  // PRE-EXISTING, pinned as it stands (reports/.claude.md OPEN (i)): an uncoded journal moves no VAT figure the lock
  // knows (journalVatLockGuard), so the VAT lock does not roll its reversal: it is dated with the note, in the FILED
  // period, and the pair is hidden there. Field 2 moves 600 -> 1000, which returnDrift reports with its uncoded note.
  it('(iii) a legacy zero-VAT note of 400 (uncoded): its reversal stays in P1, so P1 drifts (OPEN (i))', async () => {
    const inv = await approvedInvoice('2026-05-10', LEGACY, 0);
    const cn = await approvedNote(inv, '2026-05-20', 400);
    const notes = await crossPeriod(['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30'], cancelNote(cn),
      { p1: [0, 600, 0, 0], p1After: [0, 1000, 0, 0], p2After: [0, 0, 0, 0], drifts: true, reversalDate: '2026-05-20' });
    expect(notes).toEqual([UNCODED_REVENUE_NOTE]);
  });
});

describeIfDisposable('an invoice dated in a VAT-locked period and cancelled later (its cancel nulls the journal link)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(teardown);

  it('a typed exempt invoice of 1000: P1 as filed, P2 minus 1000 in field 3', async () => {
    const inv = await approvedInvoice('2026-01-10', EXEMPT[0], 0, EXEMPT[1], 0);
    await crossPeriod(['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], cancelInvoice(inv),
      { p1: [0, 0, 1000, 0], p2After: [0, 0, -1000, 0] });
  });

  it('a typed mixed invoice: P1 as filed, P2 the equal and opposite in every field', async () => {
    const inv = await approvedInvoice('2026-03-10', MIXED_ITEMS, 15, MIXED_TYPES, 150);
    await crossPeriod(['2026-03-01', '2026-03-31'], ['2026-04-01', '2026-04-30'], cancelInvoice(inv),
      { p1: [1000, 300, 200, 150], p2After: [-1000, -300, -200, -150] });
  });
});

// A CLOSED fiscal period dates the reversal TODAY, whatever its lines (journalEntryReversalDate
// resolveReversalDateDetailed: the original's period not open -> fmtDate(new Date())): the one way an uncoded pair
// straddles a VAT period. P1 is VAT-locked too, as a filed period is. crossPeriod asserts each reversal's entry_date is
// the faked P2 day, so the state these cases depend on is checked, not assumed.
describeIfDisposable('a legacy zero-VAT document (uncoded) in a closed, filed period, cancelled later', () => {
  let note: string;
  let invoice: string;
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    note = await approvedNote(await approvedInvoice('2026-03-10', LEGACY, 0), '2026-03-20', 400);
    invoice = await approvedInvoice('2026-04-10', LEGACY, 0);
    await closeFiscalThrough('2026-04-30');
  });
  afterAll(teardown);

  it('(iii) a legacy note of 400 on a legacy invoice of 1000: P1 as filed (600), P2 the reversal (400)', async () => {
    await crossPeriod(['2026-03-01', '2026-03-31'], ['2026-06-01', '2026-06-30'],
      () => onDay('2026-06-15', cancelNote(note)),
      { p1: [0, 600, 0, 0], p2After: [0, 400, 0, 0], reversalDate: '2026-06-15' });
  });

  // DEFECT, pinned as it stands (reports/.claude.md OPEN): the uncoded line counts only while a live untaxed document
  // links the journal. The invoice cancel nulls the link, so the filed period's field 2 drops to 0 and drifts, and the
  // reversal (no document's journal) counts nowhere. Fixing it needs the link kept, not a reader rule.
  it('DEFECT: a legacy invoice of 1000: the filed P1 loses its field 2 and drifts; P2 reads 0', async () => {
    await crossPeriod(['2026-04-01', '2026-04-30'], ['2026-07-01', '2026-07-31'],
      () => onDay('2026-07-15', cancelInvoice(invoice)),
      { p1: [0, 1000, 0, 0], p1After: [0, 0, 0, 0], p2After: [0, 0, 0, 0], drifts: true, reversalDate: '2026-07-15' });
  });
});
