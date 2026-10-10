/**
 * Every writer that takes a cost-centre PICK puts it in its dimension slot and
 * never in the legacy cost_center_id (gl/dimensions/costCentrePick, PR #688
 * round 3), each through its real service or route:
 *
 *   AP bill approve · expense claim post · provisional capture · GL import ·
 *   POST /api/accounting/journal-entries · petty cash
 *
 *  - a CC1 pick is the line's cc1_id; a CC2 pick is its cc2_id and the FNO is
 *    derived; with a CC2 on the line a CC1 pick gives way to the derived FNO (a
 *    bill with header FT and an item project under HT posts as HT — it was
 *    refused);
 *  - an inactive pick is dropped and the document still posts; an untyped or
 *    foreign one is refused before anything is written;
 *  - petty cash tags the expense leg only;
 *  - a historical copy re-derives nothing: after a CC1 is cleared, the
 *    reversal's contra carries none and the pair nets to zero in every CC1.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveClaim, createClaim, postClaimToGl, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { postReceiptAsPettyCashJournal } from '@/modules/accounting/services/capture/pettyCashJournalService';
import { importJournalEntries } from '@/modules/accounting/services/gl/glImportExecuteService';
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
import { countRows, dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import journalEntries from '../../pages/api/accounting/journal-entries';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type Leg = { account: string; cc1: string | null; cc2: string | null; legacy: string | null; net: number };
const DATE = '2026-07-10';
const [FT, HT, PH, INACTIVE, UNTYPED, FOREIGN] = Array.from({ length: 6 }, () => randomUUID());
const employeeId = randomUUID();
const otherCompany = randomUUID();
let fx: LateFixture;
let token = '';
let reimbursementId = '';

/** The entry's lines as (account, cc1, cc2, legacy cost_center_id, debit − credit), by account then amount. */
async function legs(entryId: string): Promise<Leg[]> {
  return ((await sql`
    SELECT gl_account_id::TEXT AS account, cc1_id::TEXT AS cc1, cc2_id::TEXT AS cc2,
           cost_center_id::TEXT AS legacy, (debit - credit)::FLOAT8 AS net
    FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID AND journal_entry_id = ${entryId}::UUID
    ORDER BY gl_account_id, debit - credit`) as Leg[]);
}
const on = (rows: Leg[], account: string) => rows.filter((r) => r.account === account).map(({ cc1, cc2, legacy, net }) => ({ cc1, cc2, legacy, net }));
const bare = (rows: Leg[], account: string) => on(rows, account).every((r) => r.cc1 === null && r.cc2 === null && r.legacy === null);

describeIfDb('cost-centre picks land in their slot on every writer path', () => {
  beforeAll(async () => {
    fx = await seedLateFixture('CCP', DATABASE_URL!);
    token = await seedRouteUser(fx, 'ccp');
    await sql`INSERT INTO companies (id, name) VALUES (${otherCompany}::UUID, ${`CCP other ${fx.tag}`})`;
    await sql`
      INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id, is_active) VALUES
        (${FT}::UUID, ${fx.companyId}::UUID, 'FT', 'Fibertime', 'cc1', NULL, true),
        (${HT}::UUID, ${fx.companyId}::UUID, 'HT', 'Hometech', 'cc1', NULL, true),
        (${PH}::UUID, ${fx.companyId}::UUID, 'PH', 'Project under HT', 'cc2', ${HT}::UUID, true),
        (${INACTIVE}::UUID, ${fx.companyId}::UUID, 'OLD', 'Withdrawn', 'cc1', NULL, false),
        (${UNTYPED}::UUID, ${fx.companyId}::UUID, 'UNT', 'Untyped', NULL, NULL, true),
        (${FOREIGN}::UUID, ${otherCompany}::UUID, 'FX', 'Other company', 'cc1', NULL, true)`;
    reimbursementId = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, level)
      VALUES (${fx.companyId}::UUID, '2300', ${`Employee reimbursements ${fx.tag}`}, 'liability',
              'other_current_liability', 'credit', true, 3)
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, employment_type, start_date, status)
      VALUES (${employeeId}::UUID, ${fx.companyId}::UUID, ${`CCP-${Date.now() % 1e9}`}, 'Pick', 'Slot', 'permanent', CURRENT_DATE, 'active')`;
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM dimension_tag_batch_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM dimension_tag_batches WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE id = ${employeeId}::UUID`;
    await dropRouteUser(fx);
    await sql`UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE supplier_invoice_items SET cc1_id = NULL, cc2_id = NULL WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`UPDATE cost_centres SET parent_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM cost_centres WHERE company_id = ANY(${[c, otherCompany]}::UUID[])`;
    await sql`DELETE FROM companies WHERE id = ${otherCompany}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  const bill = (n: string, item: Record<string, unknown>) => inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: `CCP-${n}-${fx.tag}`.slice(0, 50), invoiceDate: DATE, costCenterId: FT,
    items: [{ description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: fx.expenseId, ...item }],
  }, fx.userId));
  const journalOf = async (billId: string) => String(((await sql`
    SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${billId}::UUID`) as Row[])[0]!.gl_journal_entry_id);

  it('AP: a header CC1 is the expense line\'s cc1; with an item project the derived FNO wins and the bill posts', async () => {
    const plain = await bill('A', {});
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, plain.id, fx.userId));
    const a = await legs(await journalOf(plain.id));
    expect(on(a, fx.expenseId)).toEqual([{ cc1: FT, cc2: null, legacy: null, net: 1000 }]);
    expect(bare(a, fx.apId) && bare(a, fx.vatInputId)).toBe(true);

    // Header FT, item project PH under HT: refused when the header was mirrored into cc1 (round-3 REPRO 2).
    const project = await bill('B', { cc2Id: PH });
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, project.id, fx.userId));
    const b = await legs(await journalOf(project.id));
    expect(on(b, fx.expenseId)).toEqual([{ cc1: HT, cc2: PH, legacy: null, net: 1000 }]);

    // Post to GL — the second posting path — of a bill that is already approved.
    const approved = await bill('C', {});
    await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${approved.id}::UUID`;
    await inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, approved.id, fx.userId));
    expect(on(await legs(await journalOf(approved.id)), fx.expenseId)).toEqual([{ cc1: FT, cc2: null, legacy: null, net: 1000 }]);

    // An item saved before derivation existed: a project and no FNO. The header FT never becomes the
    // CC1 of another FNO's project — the bill posts what it stores.
    const old = await bill('D', { cc2Id: PH });
    await sql`UPDATE supplier_invoice_items SET cc1_id = NULL WHERE supplier_invoice_id = ${old.id}::UUID`;
    await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${old.id}::UUID`;
    await inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, old.id, fx.userId));
    expect(on(await legs(await journalOf(old.id)), fx.expenseId)).toEqual([{ cc1: null, cc2: PH, legacy: null, net: 1000 }]);
  });

  const claim = async (costCentreId: string) => {
    const c = await inTx(fx, () => createClaim({
      companyId: fx.companyId, employeeId, claimDate: DATE, title: 'CCP claim', createdBy: fx.userId,
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
    userId: fx.userId, reimbursementAccountId: reimbursementId, vatInputAccountId: fx.vatInputId,
  }));
  const claimJournal = async (id: string) => String(((await sql`
    SELECT posted_je_id FROM expense_claims WHERE id = ${id}::UUID`) as Row[])[0]!.posted_je_id);

  it('expense claim: a project pick is cc2 with its FNO derived; an inactive pick is dropped and the claim posts', async () => {
    const project = await claim(PH);
    await postClaim(project);
    const p = await legs(await claimJournal(project));
    expect(on(p, fx.expenseId)).toEqual([{ cc1: HT, cc2: PH, legacy: null, net: 100 }]);
    expect(bare(p, fx.vatInputId) && bare(p, reimbursementId)).toBe(true);

    const withdrawn = await claim(INACTIVE);
    await postClaim(withdrawn);
    expect(on(await legs(await claimJournal(withdrawn)), fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 100 }]);
  });

  it('expense claim: an untyped pick, and another company\'s, are refused before anything is written', async () => {
    const untyped = await claim(UNTYPED);
    const foreign = await claim(FOREIGN);
    const before = await countRows(fx);
    await expect(postClaim(untyped)).rejects.toThrow(COST_CENTRE_NOT_A_CC1_OR_CC2);
    await expect(postClaim(foreign)).rejects.toThrow(COST_CENTRE_OUTSIDE_COMPANY);
    expect(await countRows(fx)).toEqual(before);
  });

  it('provisional capture: the predicted centre is the expense line\'s cc1', async () => {
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, cost_centre_id, posted_by)
        VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${fx.expenseId}::UUID, 'standard', ${FT}::UUID, ${fx.userId})`;
    }
    // seedBankTx appends the fixture tag, which is also the fixture supplier's name: that is the match.
    const tx = await seedBankTx(fx, { date: DATE, amount: -115, description: 'WALTONS STATIONERY' });
    const out = await inTx(fx, () => postProvisional(fx.companyId, tx, fx.userId));
    expect(out.journalEntryId, JSON.stringify(out)).toEqual(expect.any(String));
    const p = await legs(out.journalEntryId!);
    expect(on(p, fx.expenseId)).toEqual([{ cc1: FT, cc2: null, legacy: null, net: 100 }]);
    expect(bare(p, fx.vatInputId) && bare(p, fx.bankAccountId)).toBe(true);
  });

  it('GL import: a row\'s cost-centre code goes to its slot', async () => {
    const before = ((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[]).map((r) => String(r.id));
    const ref = `CCP-IMP-${fx.tag}`.slice(0, 40);
    await inTx(fx, () => importJournalEntries(fx.companyId, [
      { date: DATE, reference: ref, description: 'fno', accountCode: '6000', debit: 70, credit: 0, costCentre: 'FT' },
      { date: DATE, reference: ref, description: 'project', accountCode: '6000', debit: 30, credit: 0, costCentre: 'ph' },
      { date: DATE, reference: ref, description: 'ap', accountCode: '2100', debit: 0, credit: 100 },
    ], fx.userId, false));
    const [made] = ((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])
      .map((r) => String(r.id)).filter((id) => !before.includes(id));
    const g = await legs(made!);
    expect(on(g, fx.expenseId)).toEqual([
      { cc1: HT, cc2: PH, legacy: null, net: 30 }, { cc1: FT, cc2: null, legacy: null, net: 70 },
    ]);
    expect(bare(g, fx.apId)).toBe(true);
  });

  it('POST journal-entries: picks go to their slots; a foreign or untyped pick is a 400 that writes nothing', async () => {
    const body = (pick: string) => ({
      entryDate: DATE, description: 'CCP manual', lines: [
        { glAccountId: fx.expenseId, debit: 60, credit: 0, costCenterId: FT },
        { glAccountId: fx.expenseId, debit: 40, credit: 0, costCenterId: pick },
        { glAccountId: fx.apId, debit: 0, credit: 100 },
      ],
    });
    const ok = await callRoute(fx, token, journalEntries, body(PH));
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    const m = await legs(dataOf<{ id: string }>(ok).id);
    expect(on(m, fx.expenseId)).toEqual([
      { cc1: HT, cc2: PH, legacy: null, net: 40 }, { cc1: FT, cc2: null, legacy: null, net: 60 },
    ]);
    // A CC1 pick beside the line's own project gives way to the project's FNO (it was refused as a conflict).
    const beside = await callRoute(fx, token, journalEntries, {
      entryDate: DATE, description: 'CCP manual', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0, costCenterId: FT, cc2Id: PH },
        { glAccountId: fx.apId, debit: 0, credit: 100 },
      ],
    });
    expect(beside.statusCode, JSON.stringify(beside.body)).toBe(200);
    expect(on(await legs(dataOf<{ id: string }>(beside).id), fx.expenseId)).toEqual([{ cc1: HT, cc2: PH, legacy: null, net: 100 }]);
    const before = await countRows(fx);
    for (const [pick, message] of [[FOREIGN, COST_CENTRE_OUTSIDE_COMPANY], [UNTYPED, COST_CENTRE_NOT_A_CC1_OR_CC2]] as const) {
      const refused = await callRoute(fx, token, journalEntries, body(pick));
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(message);
    }
    expect(await countRows(fx)).toEqual(before);
  });

  it('petty cash: the pick is on the expense leg only, never on the bank or VAT leg', async () => {
    const documentId = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES (${documentId}::UUID, ${fx.companyId}::UUID, 'slip.jpg', 'image/jpeg')`;
    const out = await inTx(fx, () => postReceiptAsPettyCashJournal({
      companyId: fx.companyId, userId: fx.userId, eventId: randomUUID(), documentId,
      extracted: {
        documentType: 'receipt', vendorName: 'Waltons Stationery', date: DATE, referenceNumber: 'REC-CCP',
        currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15, totalAmount: 115, lineItems: [], rawText: '',
        confidence: 0.9, warnings: [], extractionMethod: 'vlm',
      } as never,
      resolvedGlAccountId: fx.expenseId, vatInputAccountId: fx.vatInputId, costCentreId: FT,
      fingerprint: { receiptKey: null, duplicateOf: null, confirmedBy: null },
    }));
    const p = await legs(out.journalEntry.id);
    expect(on(p, fx.expenseId)).toEqual([{ cc1: FT, cc2: null, legacy: null, net: 100 }]);
    expect(on(p, fx.vatInputId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 15 }]);
    expect(on(p, fx.bankAccountId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: -115 }]);
  });

  it('a reversal after a CC1 clear nets to zero: the contra copies what is stored, and re-derives nothing', async () => {
    // A line as the old writers left it: the legacy column AND cc1 both name FT.
    const entry = await inTx(fx, async () => {
      const e = await createJournalEntry(fx.companyId, {
        entryDate: DATE, description: 'CCP clear then reverse', lines: [
          { glAccountId: fx.expenseId, debit: 250, credit: 0, costCenterId: FT, cc1Id: FT },
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
    expect(on(await legs(contra.id), fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: FT, net: -250 }]);
    const byCc1 = (await sql`
      SELECT jl.cc1_id::TEXT AS cc1, SUM(jl.debit - jl.credit)::FLOAT8 AS net
      FROM gl_journal_lines jl
      WHERE jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${[entry.id, contra.id]}::UUID[])
        AND jl.gl_account_id = ${fx.expenseId}::UUID
      GROUP BY jl.cc1_id`) as Row[];
    expect(byCc1).toEqual([{ cc1: null, net: 0 }]);
  });
});
