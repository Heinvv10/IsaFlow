/**
 * Cost-centre picks on the paths that post a STORED document or template
 * (gl/dimensions/costCentrePick, PR #688 round 4):
 *
 *   AP bill approve · AP Post to GL · recurring journal · recurring template
 *
 * A bill posts what it stores, in historical-copy mode, so nothing derives or
 * checks an FNO after the pick is placed. There the pick brings its own FNO:
 *  - a header PROJECT on a line with no CC1 posts cc1 = the project's FNO, the
 *    pair a new assignment derives (it posted the project with no CC1);
 *  - on a line that has a CC1 the project is placed only when its FNO is that
 *    CC1; otherwise it is dropped — never stored as a contradicting pair;
 *  - a header CC1 beside an item project gives way to the stored, derived FNO.
 * Every drop is on the posting result as `warnings`; an untyped pick is a 400
 * that writes nothing. A recurring journal or template line's costCenterId is
 * a pick too (it was written to the legacy column, invisible to reports).
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createRecurringJournal, runRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { createRecurringTemplate, executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import { COST_CENTRE_NOT_A_CC1_OR_CC2 } from '@/modules/accounting/services/gl/dimensions/costCentrePick';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { countRows, type LateFixture } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import { bareOn, dropPickFixture, legsOn, seedPickFixture, type PickFixture } from './helpers/costCentrePickFixture';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import recurringJournalsAction from '../../pages/api/accounting/recurring-journals-action';
import recurringTransactionsExecute from '../../pages/api/accounting/recurring-transactions-execute';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
const OCCUPIED = (code: string) => `Line 1: cost centre ${code} was not applied — the line already carries its own CC1 or project.`;
const INACTIVE = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const CONFLICT = 'Line 1: project PH was not applied — it belongs to another FNO than the line\'s CC1.';
let p: PickFixture;
let fx: LateFixture;
let n = 0;

describeIfDb('cost-centre picks on stored documents and templates', () => {
  beforeAll(async () => { p = await seedPickFixture('CCD', process.env.DATABASE_URL!); fx = p.fx; }, 120000);
  afterAll(async () => { await dropPickFixture(p); }, 120000);

  /** A draft bill of R1 000 + VAT whose HEADER names `header`, with `item` on its one line. */
  const bill = (header: string, item: Record<string, unknown> = {}) => inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: `CCD-${++n}-${fx.tag}`.slice(0, 50), invoiceDate: DATE, costCenterId: header,
    items: [{ description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: fx.expenseId, ...item }],
  }, fx.userId));
  const journalOf = async (billId: string) => String(((await sql`
    SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${billId}::UUID`) as Row[])[0]!.gl_journal_entry_id);
  const approve = (id: string) => inTx(fx, () => approveSupplierInvoice(fx.companyId, id, fx.userId));
  /** Post to GL — the second posting path — of a bill that is already approved. */
  const postToGl = async (id: string) => {
    await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    return inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, id, fx.userId));
  };
  const expense = async (billId: string) => legsOn(p, await journalOf(billId), fx.expenseId);

  it('a header CC1 is the expense line\'s cc1, on both posting paths; the AP and VAT legs carry nothing', async () => {
    const a = await bill(p.FT);
    expect((await approve(a.id)).warnings).toBeUndefined();
    expect(await expense(a.id)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 1000 }]);
    const je = await journalOf(a.id);
    expect(await bareOn(p, je, fx.apId) && await bareOn(p, je, fx.vatInputId)).toBe(true);
    const b = await bill(p.FT);
    expect((await postToGl(b.id)).warnings).toBeUndefined();
    expect(await expense(b.id)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 1000 }]);
  });

  it('a header PROJECT posts with its FNO as the CC1, on both posting paths (round-4 REPRO 1)', async () => {
    const a = await bill(p.PH);
    expect((await approve(a.id)).warnings).toBeUndefined();
    expect(await expense(a.id)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 1000 }]);
    const b = await bill(p.PH);
    await postToGl(b.id);
    expect(await expense(b.id)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 1000 }]);
  });

  it('a header project beside an item CC1: placed when its FNO is that CC1, dropped and reported when it is another', async () => {
    const same = await bill(p.PH, { cc1Id: p.HT });
    expect((await approve(same.id)).warnings).toBeUndefined();
    expect(await expense(same.id)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 1000 }]);
    // Item FT, header project under HT: never stored as (FT, PH).
    const other = await bill(p.PH, { cc1Id: p.FT });
    expect((await approve(other.id)).warnings).toEqual([CONFLICT]);
    expect(await expense(other.id)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 1000 }]);
    const viaPost = await bill(p.PH, { cc1Id: p.FT });
    expect((await postToGl(viaPost.id)).warnings).toEqual([CONFLICT]);
    expect(await expense(viaPost.id)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 1000 }]);
  });

  it('a header CC1 beside an item project gives way to the stored FNO, and says so (round-3 REPRO 2)', async () => {
    const derived = await bill(p.FT, { cc2Id: p.PH });
    expect((await approve(derived.id)).warnings).toEqual([OCCUPIED('FT')]);
    expect(await expense(derived.id)).toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 1000 }]);
    // An item saved before derivation existed (a project, no FNO) posts what it stores.
    const old = await bill(p.FT, { cc2Id: p.PH });
    await sql`UPDATE supplier_invoice_items SET cc1_id = NULL WHERE supplier_invoice_id = ${old.id}::UUID`;
    expect((await postToGl(old.id)).warnings).toEqual([OCCUPIED('FT')]);
    expect(await expense(old.id)).toEqual([{ cc1: null, cc2: p.PH, legacy: null, net: 1000 }]);
  });

  it('an inactive header pick is dropped and the route says so; an untyped one is a 400 that writes nothing', async () => {
    const withdrawn = await bill(p.INACTIVE);
    const state = await callRoute(fx, p.token, supplierInvoicesAction, { action: 'approve', invoiceId: withdrawn.id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(dataOf<{ warnings?: string[] }>(state).warnings).toEqual([INACTIVE]);
    expect(await expense(withdrawn.id)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 1000 }]);

    const untyped = await bill(p.UNTYPED);
    const before = await countRows(fx);
    const refused = await callRoute(fx, p.token, supplierInvoicesAction, { action: 'approve', invoiceId: untyped.id });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(COST_CENTRE_NOT_A_CC1_OR_CC2);
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${untyped.id}::UUID`) as Row[];
    expect(row).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });

  const recurring = (pick: string) => inTx(fx, () => createRecurringJournal(fx.companyId, {
    templateName: `CCD ${++n} ${fx.tag}`, frequency: 'monthly', nextRunDate: '2026-07-15', lines: [
      { glAccountId: fx.expenseId, debit: 700, credit: 0, costCenterId: pick },
      { glAccountId: fx.apId, debit: 0, credit: 700 },
    ] }, fx.userId));

  it('a recurring journal: a template line\'s pick is in its slot, never the legacy column (round-4 REPRO 2)', async () => {
    const fno = await recurring(p.FT);
    const run = await inTx(fx, () => runRecurringJournal(fx.companyId, fno.id, fx.userId));
    expect(run.warnings).toBeUndefined();
    expect(await legsOn(p, run.journalId, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 700 }]);
    const project = await recurring(p.PH);
    const viaRoute = await callRoute(fx, p.token, recurringJournalsAction, { action: 'generate', id: project.id });
    expect(viaRoute.statusCode, JSON.stringify(viaRoute.body)).toBe(200);
    expect(await legsOn(p, dataOf<{ journalId: string }>(viaRoute).journalId, fx.expenseId))
      .toEqual([{ cc1: p.HT, cc2: p.PH, legacy: null, net: 700 }]);

    const withdrawn = await recurring(p.INACTIVE);
    const warned = await callRoute(fx, p.token, recurringJournalsAction, { action: 'generate', id: withdrawn.id });
    expect(dataOf<{ warnings?: string[] }>(warned).warnings).toEqual([INACTIVE]);

    const untyped = await recurring(p.UNTYPED);
    const before = await countRows(fx);
    const refused = await callRoute(fx, p.token, recurringJournalsAction, { action: 'generate', id: untyped.id });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(COST_CENTRE_NOT_A_CC1_OR_CC2);
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT next_run_date::TEXT AS d, run_count FROM recurring_journals WHERE id = ${untyped.id}::UUID`) as Row[];
    expect(row).toMatchObject({ d: '2026-07-15', run_count: 0 });
  });

  const template = (pick: string) => inTx(fx, () => createRecurringTemplate(fx.companyId, fx.userId, {
    name: `CCD tpl ${++n} ${fx.tag}`, entityType: 'journal_entry', frequency: 'monthly', nextRunDate: '2026-07-15',
    templateData: { description: 'CCD template', lines: [
      { glAccountId: fx.expenseId, debit: 90, credit: 0, costCenterId: pick },
      { glAccountId: fx.apId, debit: 0, credit: 90 },
    ] },
  } as never));

  it('a recurring journal TEMPLATE: the same rule, and an untyped pick is a 400 that writes nothing', async () => {
    const fno = await template(p.FT);
    const out = await inTx(fx, () => executeRecurring(fx.companyId, fno.id, fx.userId));
    expect(out.warnings).toBeUndefined();
    expect(await legsOn(p, out.entityId, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 90 }]);
    const withdrawn = await template(p.INACTIVE);
    expect((await inTx(fx, () => executeRecurring(fx.companyId, withdrawn.id, fx.userId))).warnings).toEqual([INACTIVE]);

    const untyped = await template(p.UNTYPED);
    const before = await countRows(fx);
    const refused = await callRoute(fx, p.token, recurringTransactionsExecute, { templateId: untyped.id });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(COST_CENTRE_NOT_A_CC1_OR_CC2);
    expect(await countRows(fx)).toEqual(before);
  });
});
