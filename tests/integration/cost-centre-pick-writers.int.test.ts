/**
 * Every writer that takes a cost-centre PICK puts it in its dimension slot and
 * never in the legacy cost_center_id (gl/dimensions/costCentrePick, PR #688
 * rounds 3-4), each through its real service or route. Here:
 *
 *   expense claim post · provisional capture · GL import ·
 *   POST /api/accounting/journal-entries · petty cash
 *
 * (AP bills and the recurring paths: cost-centre-pick-documents.int.test.ts.)
 *
 *  - a CC1 pick is the line's cc1_id; a CC2 pick is its cc2_id and the FNO is
 *    derived; with a CC2 on the line a CC1 pick gives way to the derived FNO;
 *  - a dropped pick is REPORTED on the posting result (`warnings`), and the
 *    document still posts; an untyped or foreign one is refused before
 *    anything is written, as a 4xx;
 *  - petty cash tags the expense leg only;
 *  - a historical copy re-derives nothing: after a CC1 is cleared, the
 *    reversal's contra carries none and the pair nets to zero in every CC1.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { approveClaim, createClaim, postClaimToGl, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { postReceiptAsPettyCashJournal } from '@/modules/accounting/services/capture/pettyCashJournalService';
import { importJournalEntries, ImportValidationError } from '@/modules/accounting/services/gl/glImportExecuteService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { applyDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import {
  COST_CENTRE_NOT_A_CC1_OR_CC2,
  COST_CENTRE_OUTSIDE_COMPANY,
} from '@/modules/accounting/services/gl/dimensions/costCentrePick';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { countRows, type LateFixture } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import { bareOn, dropPickFixture, legsOn, seedPickFixture, type PickFixture } from './helpers/costCentrePickFixture';
import journalEntries from '../../pages/api/accounting/journal-entries';
import expenseClaimPost from '../../pages/api/accounting/expense-claims/[id]/post';
import glImport from '../../pages/api/accounting/gl-import';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
const INACTIVE_WARNING = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
let p: PickFixture;
let fx: LateFixture;

describeIfDb('cost-centre picks land in their slot on every writer path', () => {
  beforeAll(async () => { p = await seedPickFixture('CCP', process.env.DATABASE_URL!); fx = p.fx; }, 120000);
  afterAll(async () => { await dropPickFixture(p); }, 120000);

  const claim = async (costCentreId: string) => {
    const c = await inTx(fx, () => createClaim({
      companyId: fx.companyId, employeeId: p.employeeId, claimDate: DATE, title: 'CCP claim', createdBy: fx.userId,
      lines: [{
        lineDate: DATE, description: 'Stationery', merchant: 'Waltons', amount: 115, vatAmount: 15,
        vatCode: 'standard', glAccountId: fx.expenseId, costCentreId, projectId: null, sourceDocumentId: null,
        kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
      }],
    }));
    await inTx(fx, () => submitClaim(c.id, fx.companyId));
    await inTx(fx, () => approveClaim(c.id, fx.companyId, fx.userId));
    return c.id;
  };
  const postClaim = (id: string) => inTx(fx, () => postClaimToGl(id, fx.companyId, {
    userId: fx.userId, reimbursementAccountId: p.reimbursementId, vatInputAccountId: fx.vatInputId,
  }));
  const claimJournal = async (id: string) => String(((await sql`
    SELECT posted_je_id FROM expense_claims WHERE id = ${id}::UUID`) as Row[])[0]!.posted_je_id);

  it('expense claim: a project pick is cc2 with its FNO derived; an inactive pick is dropped, reported, and the claim posts', async () => {
    const project = await claim(p.PH);
    const posted = await postClaim(project);
    expect(posted!.warnings).toBeUndefined();
    const je = await claimJournal(project);
    expect(await legsOn(p, je, fx.expenseId)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 100 }]);
    expect(await bareOn(p, je, fx.vatInputId) && await bareOn(p, je, p.reimbursementId)).toBe(true);

    const withdrawn = await claim(p.INACTIVE);
    expect((await postClaim(withdrawn))!.warnings).toEqual([INACTIVE_WARNING]);
    expect(await legsOn(p, await claimJournal(withdrawn), fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 100 }]);
  });

  it('expense claim: an untyped pick, and another company\'s, are refused before anything is written — a 400 on the route', async () => {
    const untyped = await claim(p.UNTYPED);
    const foreign = await claim(p.FOREIGN);
    const before = await countRows(fx);
    await expect(postClaim(untyped)).rejects.toThrow(COST_CENTRE_NOT_A_CC1_OR_CC2);
    await expect(postClaim(foreign)).rejects.toThrow(COST_CENTRE_OUTSIDE_COMPANY);
    const state = await callRoute(fx, p.token, expenseClaimPost,
      { reimbursementAccountId: p.reimbursementId, vatInputAccountId: fx.vatInputId }, { id: untyped });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toContain(COST_CENTRE_NOT_A_CC1_OR_CC2);
    expect(await countRows(fx)).toEqual(before);
  });

  it('provisional capture: the predicted centre is the expense line\'s cc1', async () => {
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, cost_centre_id, posted_by)
        VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${fx.expenseId}::UUID, 'standard', ${p.FT}::UUID, ${fx.userId})`;
    }
    // seedBankTx appends the fixture tag, which is also the fixture supplier's name: that is the match.
    const tx = await seedBankTx(fx, { date: DATE, amount: -115, description: 'WALTONS STATIONERY' });
    const out = await inTx(fx, () => postProvisional(fx.companyId, tx, fx.userId));
    expect(out.journalEntryId, JSON.stringify(out)).toEqual(expect.any(String));
    expect(await legsOn(p, out.journalEntryId!, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 100 }]);
    expect(await bareOn(p, out.journalEntryId!, fx.vatInputId) && await bareOn(p, out.journalEntryId!, fx.bankAccountId)).toBe(true);
  });

  it('GL import: a row\'s cost-centre code goes to its slot; one that cannot be used is a 400 naming the row', async () => {
    const before = ((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[]).map((r) => String(r.id));
    const ref = `CCP-IMP-${fx.tag}`.slice(0, 40);
    await inTx(fx, () => importJournalEntries(fx.companyId, [
      { date: DATE, reference: ref, description: 'fno', accountCode: '6000', debit: 70, credit: 0, costCentre: 'FT' },
      { date: DATE, reference: ref, description: 'project', accountCode: '6000', debit: 30, credit: 0, costCentre: 'ph' },
      { date: DATE, reference: ref, description: 'ap', accountCode: '2100', debit: 0, credit: 100 },
    ], fx.userId, false));
    const [made] = ((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])
      .map((r) => String(r.id)).filter((id) => !before.includes(id));
    expect(await legsOn(p, made!, fx.expenseId)).toEqual([
      { cc1: p.HT, cc2: p.PH, legacy: null, net: 30 }, { cc1: p.FT, cc2: null, legacy: null, net: 70 },
    ]);
    expect(await bareOn(p, made!, fx.apId)).toBe(true);

    const rows = [
      { date: DATE, reference: `${ref}-2`, description: 'ap', accountCode: '2100', debit: 0, credit: 5 },
      { date: DATE, reference: `${ref}-2`, description: 'untyped centre', accountCode: '6000', debit: 5, credit: 0, costCentre: 'UNT' },
    ];
    const counted = await countRows(fx);
    const err = await inTx(fx, () => importJournalEntries(fx.companyId, rows, fx.userId, true)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ImportValidationError);
    const state = await callRoute(fx, p.token, glImport, { rows, postImmediately: true });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toContain('Import row \\"untyped centre\\" (2026-07-10): cost centre \\"UNT\\" cannot be used');
    expect(await countRows(fx)).toEqual(counted);
  });

  it('POST journal-entries: picks go to their slots, a dropped one is in `warnings`; a foreign or untyped pick is a 400 that writes nothing', async () => {
    const body = (pick: string) => ({
      entryDate: DATE, description: 'CCP manual', lines: [
        { glAccountId: fx.expenseId, debit: 60, credit: 0, costCenterId: p.FT },
        { glAccountId: fx.expenseId, debit: 40, credit: 0, costCenterId: pick },
        { glAccountId: fx.apId, debit: 0, credit: 100 },
      ],
    });
    const ok = await callRoute(fx, p.token, journalEntries, body(p.PH));
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(dataOf<{ warnings?: string[] }>(ok).warnings).toBeUndefined();
    expect(await legsOn(p, dataOf<{ id: string }>(ok).id, fx.expenseId)).toEqual([
      { cc1: p.HT, cc2: p.PH, legacy: null, net: 40 }, { cc1: p.FT, cc2: null, legacy: null, net: 60 },
    ]);
    // A CC1 pick beside the line's own project gives way to the project's FNO (it was refused as a conflict), and says so.
    const beside = await callRoute(fx, p.token, journalEntries, {
      entryDate: DATE, description: 'CCP manual', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0, costCenterId: p.FT, cc2Id: p.PH },
        { glAccountId: fx.apId, debit: 0, credit: 100 },
      ],
    });
    expect(beside.statusCode, JSON.stringify(beside.body)).toBe(200);
    expect(dataOf<{ warnings?: string[] }>(beside).warnings)
      .toEqual(['Line 1: cost centre FT was not applied — the line already carries its own CC1 or project.']);
    expect(await legsOn(p, dataOf<{ id: string }>(beside).id, fx.expenseId)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 100 }]);
    const before = await countRows(fx);
    for (const [pick, message] of [[p.FOREIGN, COST_CENTRE_OUTSIDE_COMPANY], [p.UNTYPED, COST_CENTRE_NOT_A_CC1_OR_CC2]] as const) {
      const refused = await callRoute(fx, p.token, journalEntries, body(pick));
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(message);
    }
    expect(await countRows(fx)).toEqual(before);
  });

  const slip = async (costCentreId: string) => {
    const documentId = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES (${documentId}::UUID, ${fx.companyId}::UUID, 'slip.jpg', 'image/jpeg')`;
    return inTx(fx, () => postReceiptAsPettyCashJournal({
      companyId: fx.companyId, userId: fx.userId, eventId: randomUUID(), documentId,
      extracted: {
        documentType: 'receipt', vendorName: 'Waltons Stationery', date: DATE, referenceNumber: `REC-${documentId.slice(0, 8)}`,
        currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15, totalAmount: 115, lineItems: [], rawText: '',
        confidence: 0.9, warnings: [], extractionMethod: 'vlm',
      } as never,
      resolvedGlAccountId: fx.expenseId, vatInputAccountId: fx.vatInputId, costCentreId,
      fingerprint: { receiptKey: null, duplicateOf: null, confirmedBy: null },
    }));
  };

  it('petty cash: the pick is on the expense leg only, never on the bank or VAT leg; a dropped pick is a warning', async () => {
    const out = await slip(p.FT);
    expect(out.warnings).toEqual([]);
    const je = out.journalEntry.id;
    expect(await legsOn(p, je, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 100 }]);
    expect(await legsOn(p, je, fx.vatInputId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 15 }]);
    expect(await legsOn(p, je, fx.bankAccountId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: -115 }]);
    const withdrawn = await slip(p.INACTIVE);
    expect(withdrawn.warnings).toEqual([INACTIVE_WARNING]);
    expect(await legsOn(p, withdrawn.journalEntry.id, fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 100 }]);
  });

  it('a reversal after a CC1 clear nets to zero: the contra copies what is stored, and re-derives nothing', async () => {
    // A line as the old writers left it: the legacy column AND cc1 both name FT.
    const entry = await inTx(fx, async () => {
      const e = await createJournalEntry(fx.companyId, {
        entryDate: DATE, description: 'CCP clear then reverse', lines: [
          { glAccountId: fx.expenseId, debit: 250, credit: 0, costCenterId: p.FT, cc1Id: p.FT },
          { glAccountId: fx.apId, debit: 0, credit: 250 },
        ],
      }, fx.userId);
      await postJournalEntry(fx.companyId, e.id, fx.userId);
      return e;
    });
    const [line] = (await sql`
      SELECT id::TEXT AS id FROM gl_journal_lines WHERE journal_entry_id = ${entry.id}::UUID AND gl_account_id = ${fx.expenseId}::UUID`) as Row[];
    await inTx(fx, async () => {
      const plan = await planDimensionTags(fx.companyId, [{ journalLineId: String(line!.id), cc1: null, unallocatedReason: 'not an FNO cost' }]);
      await applyDimensionTags(fx.companyId, plan, { idempotencyKey: `ccp-clear-${entry.id}`, userId: fx.userId });
    });
    const contra = await inTx(fx, () => reverseJournalEntry(fx.companyId, entry.id, fx.userId));
    expect(await legsOn(p, contra.id, fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: p.FT, net: -250 }]);
    const byCc1 = (await sql`
      SELECT jl.cc1_id::TEXT AS cc1, SUM(jl.debit - jl.credit)::FLOAT8 AS net
      FROM gl_journal_lines jl
      WHERE jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${[entry.id, contra.id]}::UUID[])
        AND jl.gl_account_id = ${fx.expenseId}::UUID
      GROUP BY jl.cc1_id`) as Row[];
    expect(byCc1).toEqual([{ cc1: null, net: 0 }]);
  });
});
