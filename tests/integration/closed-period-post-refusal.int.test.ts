/**
 * The SERVER refuses to post a document into a fiscal period that is not open,
 * and writes nothing when it refuses — proved on the real service functions,
 * against a real ledger, for the four posting paths:
 *
 *   1a. customer invoice approve        approveCustomerInvoice (its 500 rolls the request back)
 *   1b. customer invoice Post to GL     postCustomerInvoiceToGL (customer-invoices-gl.ts answers 400: COMMITS)
 *   2.  customer credit note approve    approveCreditNote (credit-notes-action)
 *   3.  supplier invoice approve        approveSupplierInvoice (supplier-invoices-action)
 *   4.  supplier credit note 'post'     approveCreditNote (supplier-credit-notes PATCH action=post)
 *
 * What "writes nothing" means here: the document is unchanged (status, journal link) and NO journal or journal line
 * exists afterwards. Other tables are not asserted.
 *
 * Strictest reading: every call but 1a runs in a transaction that is COMMITTED even though the call threw, and
 * without the routes' withJournalDateRefusal savepoint, so a refusal raised after the draft journal was written would
 * leave that draft behind and fail here. The routes are safer than this: all four wrap the call in
 * withJournalDateRefusal -> withSavepoint, which rolls back to the savepoint on ANY error, so the pre-write guards
 * (customerInvoiceGlPosting, assertCreditNoteCanPost) are a second layer, not the only one. Path 3 has no pre-write
 * guard: its refusal comes after createJournalEntry, and nothing is left because approveSupplierInvoice runs inside its
 * own savepoint ('approve_supplier_invoice').
 * 1a runs as its route does, rolled back (a plain Error answers 500), so its journal count is guaranteed by the
 * rollback and what it pins is the refusal itself. (Path 4's route also answered 500 until it mapped
 * ClosedFiscalPeriodError to 400; see tests/unit/api/supplierCreditNotePostClosedPeriod.test.ts.)
 *
 * Locally with storage configured, the invoice approve's PDF snapshot (snapshotInvoicePdf) uploads `<company>/<invoice>.pdf`,
 * which cleanup does not remove; in CI there is no storage and the upload failure is swallowed.
 * `assertNotProductionDb` refuses production only, so it still accepts a dev database: point DATABASE_URL at a disposable one.
 * The fixture company's cleanup deletes closed and locked periods, which fiscal_periods_guard_delete allows only to a
 * superuser: the integration gate's `postgres` is one; run this against a disposable database, never a dev tenant.
 *
 * getPeriodStatusForDate maps every non-'open' status to 'closed', so 'locked' and 'closing' are expected to be
 * refused exactly as 'closed' is; each is asserted, not assumed.
 *
 * NO PERIOD (no fiscal_periods or fiscal_years row covers the date): createJournalEntry creates the fiscal year on
 * demand (fiscalPeriodAutoCreate, within 10 years back / 2 forward of today), so every path POSTS and the period exists
 * afterwards — see the 'no_period' cases below, which assert it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { inTx, type Fixture } from './helpers/l1FifoFixture';
import {
  billState, commitingTx, dropWorld, invoiceState, journalsOf, ledgerCounts, noteState, refusalOf, seedDraftBill, seedDraftInvoice,
  seedDraftNote, seedWorld, type DocState, type PeriodState,
} from './helpers/closedPeriodPostFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

interface PostingPath {
  name: string;
  /** Seeds the document the call starts from; returns a reader of its state and the call itself. */
  setup(fx: Fixture): Promise<{ state: () => Promise<DocState>; call: () => Promise<unknown> }>;
  /** The state the document is in before the call, and after a successful one. */
  before: string;
  after: string;
  /** Run in a transaction committed on error (the strict reading), or rolled back as the route's 500 does. */
  commitOnError: boolean;
  /** The exact refusal for a period in `status`: error class and message, as observed. */
  refusal(status: PeriodState): RegExp;
}

// The invoice path's own check (customerInvoiceGlPosting) names 'closed' for every non-open status.
const INVOICE_REFUSAL = () => /^Error: Cannot post invoice INV-CPP-\S+ to GL — its fiscal period is closed\. Reopen the period, or date the invoice in an open one\.$/;
// assertCreditNoteCanPost: the same mapping, always 'closed'.
const NOTE_REFUSAL = () => /^ClosedFiscalPeriodError: Cannot post to closed fiscal period$/;
// postJournalEntry (the only guard on the bill path) names the period's real status.
const BILL_REFUSAL = (status: PeriodState) => new RegExp(`^ClosedFiscalPeriodError: Cannot post to ${status} fiscal period$`);

const PATHS: PostingPath[] = [
  {
    name: '1a customer invoice approve (approveCustomerInvoice)',
    before: 'draft', after: 'approved', commitOnError: false, refusal: INVOICE_REFUSAL,
    async setup(fx) {
      const id = await seedDraftInvoice(fx);
      return { state: () => invoiceState(fx, id), call: () => approveCustomerInvoice(fx.companyId, id, fx.userId) };
    },
  },
  {
    name: '1b customer invoice Post to GL (postCustomerInvoiceToGL)',
    before: 'approved', after: 'approved', commitOnError: true, refusal: INVOICE_REFUSAL,
    async setup(fx) {
      const id = await seedDraftInvoice(fx, 'approved'); // in the AR population, no journal yet
      return { state: () => invoiceState(fx, id), call: () => postCustomerInvoiceToGL(fx.companyId, id, fx.userId) };
    },
  },
  {
    name: '2 customer credit note approve (approveCreditNote)',
    before: 'draft', after: 'approved', commitOnError: true, refusal: NOTE_REFUSAL,
    async setup(fx) {
      const id = await seedDraftNote(fx, 'customer');
      return { state: () => noteState(fx, id), call: () => approveCreditNote(fx.companyId, id, fx.userId) };
    },
  },
  {
    name: '3 supplier invoice approve (approveSupplierInvoice)',
    before: 'draft', after: 'approved', commitOnError: true, refusal: BILL_REFUSAL,
    async setup(fx) {
      const id = await seedDraftBill(fx);
      return { state: () => billState(fx, id), call: () => approveSupplierInvoice(fx.companyId, id, fx.userId, { allowLateInputClaim: true }) };
    },
  },
  {
    name: "4 supplier credit note 'post' (approveCreditNote)",
    before: 'draft', after: 'approved', commitOnError: true, refusal: NOTE_REFUSAL,
    async setup(fx) {
      const id = await seedDraftNote(fx, 'supplier');
      return { state: () => noteState(fx, id), call: () => approveCreditNote(fx.companyId, id, fx.userId, { autoApply: 'fifo' }) };
    },
  },
];

const REFUSED: PeriodState[] = ['closed', 'locked', 'closing'];

describeIfDb('posting into a fiscal period that is not open', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) await dropWorld(fx);
    fx = null;
  }, 120000);

  async function run(path: PostingPath, period: PeriodState) {
    assertNotProductionDb('This test creates a company and posts documents.');
    fx = await seedWorld(period, DATABASE_URL!);
    const { state, call } = await path.setup(fx);
    expect(await state()).toMatchObject({ status: path.before, journalId: null });
    expect(await ledgerCounts(fx)).toEqual({ journals: 0, lines: 0 });
    const f = fx;
    const refusal = await refusalOf(path.commitOnError ? commitingTx(f, call) : inTx(f, call));
    return { refusal, state, counts: await ledgerCounts(f), doc: await state() };
  }

  describe.each(PATHS)('$name', (path) => {
    it.each(REFUSED)('refuses a %s period with its exact error, leaves the document as it was, writes no journal', async (period) => {
      const out = await run(path, period);
      expect(out.refusal).toMatch(path.refusal(period));
      expect(out.doc).toEqual({ status: path.before, journalId: null });
      expect(out.counts).toEqual({ journals: 0, lines: 0 });
    }, 60000);

    it('control: an open period posts it, with one balanced posted journal', async () => {
      const out = await run(path, 'open');
      expect(out.refusal).toBeNull();
      expect(out.doc.status).toBe(path.after);
      expect(out.doc.journalId).not.toBeNull();
      expect(await journalsOf(fx!)).toEqual([{ status: 'posted', balanced: true, periodStatus: 'open' }]);
    }, 60000);

    // Observed, not designed here: no covering row is not a refusal. createJournalEntry creates the fiscal year
    // (fiscalPeriodAutoCreate), so the post succeeds, into a year and period that did not exist and are now open.
    it('no_period: posts, and the fiscal year is created on demand (open)', async () => {
      const out = await run(path, 'no_period');
      expect(out.refusal).toBeNull();
      expect(out.doc.status).toBe(path.after);
      expect(out.doc.journalId).not.toBeNull();
      expect(await journalsOf(fx!)).toEqual([{ status: 'posted', balanced: true, periodStatus: 'open' }]);
    }, 60000);
  });
});
