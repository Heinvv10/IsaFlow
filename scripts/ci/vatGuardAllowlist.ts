/**
 * The allowlist for `check-vat-guard-coverage.ts`, in its own module so the
 * check stays under the 300-line cap as entries are argued in.
 */
import type { VatDecisionKind } from './vatGuardRules';

/**
 * Paths that decide or forward a VAT claim and are ALLOWED not to guard.
 *
 * Every entry carries the reason, because the reason is the only thing that
 * makes this list different from a list of exemptions. Two shapes qualify:
 *
 *   ATTENDED — a human (or an agent acting on one specific document they are
 *   looking at) chose this code and was shown the warning. Coercing here would
 *   silently override a considered decision, which is the failure the whole
 *   warn/coerce split exists to avoid.
 *
 *   NO CLAIM DECIDED — the file reports on, settles, or forwards a claim that
 *   something else already resolved. It picks no account.
 *
 * Adding an entry means arguing one of those two. If neither fits, the file
 * needs the guard, not a line here.
 *
 * Each entry names the KINDS it is excused for, and only those (K-072 r29): a
 * path-wide exemption let a VAT-claiming poster added to the unattended gate
 * pass, when the gate was excused only for a rate that bounds a refusal. A
 * kind the file shows outside its entry fails the check like any other.
 */
interface AllowedEntry {
  kinds: VatDecisionKind[];
  reason: string;
}
export const ALLOWED: Record<string, AllowedEntry> = {
  // ── ATTENDED ──────────────────────────────────────────────────────────────
  'src/modules/accounting/services/gl/vatLateClaimSplit.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'Attended by construction: the late-claim split runs only when a human-initiated '
    + 'caller opts in (allowLateInputClaim; MCP only with an explicit allow_late_input_claim), '
    + 'and every unattended poster keeps the lock refusal (vat-late-claim-unattended.int.test.ts). '
    + 'It decides no claim of its own: it copies each vat_type the original posting already '
    + 'carried onto the companion, after qualifiesForLateClaim has refused output VAT, input '
    + 'reductions and non-supply or input-denied accounts.',
  },
  'src/modules/accounting/services/gl/vatLateClaimRules.ts': {
    kinds: ['rate_constant'],
    reason: 'This IS the late-claim guard (qualifiesForLateClaim). The rate is the VAT201\'s own, '
    + 'used only to REFUSE a claim that does not fit its base; it predicts no VAT and posts nothing.',
  },
  'src/modules/accounting/services/ar/customerInvoiceGlPosting.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'No claim decided: the file holds postCustomerInvoiceToGL alone, and its only vat_type '
    + 'write is `standard` on the invoice\'s own VAT Output leg (2026-10-05), a LABEL on the '
    + 'tax_amount the invoice already carries. The account is the fixed vat_output system account, '
    + 'nobody picks one, and the code is box-neutral — the VAT201 read the uncoded leg as standard '
    + 'before it (tests/integration/customer-invoice-vat-code-backfill.int.test.ts). It was moved '
    + 'out of customerPaymentAllocationService so this entry does not excuse payment-allocation code. '
    + 'The entry still excuses any vat_type write in THIS file, so keep the file to this one poster.',
  },
  'src/modules/accounting/services/ar/creditNoteApproveService.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'No claim decided: its only vat_type write is `standard` on the credit note\'s own '
    + 'VAT leg (2026-09-25), a LABEL on the tax_amount the credit note already carries. The '
    + 'accounts are fixed system accounts (vat_output / vat_input), nobody picks one, and the '
    + 'code is box-neutral — the VAT201 read the uncoded leg as standard before it '
    + '(tests/integration/credit-note-vat-code-backfill.int.test.ts). A credit note REDUCES '
    + 'VAT on either side; it never turns a claim on.',
  },
  'src/modules/accounting/services/reports/vatInputSupport.ts': {
    kinds: ['rate_constant'],
    reason: 'Report code: the pre-filing input-VAT support check. The rate bounds the VAT a '
    + 'bank line can support (rate/(1+rate) of the money) so an over-claim is REPORTED; it '
    + 'posts nothing and decides no claim.',
  },
  'src/modules/accounting/services/reports/vatLateClaimBasis.ts': {
    kinds: ['rate_constant'],
    reason: 'Report code: it derives the VAT201 boxes (the 15% base check) including late claims. '
    + 'It posts nothing and decides no claim.',
  },
  'src/modules/accounting/services/bank/bankVatInclusive.ts': {
    kinds: ['rate_constant', 'vat_inclusive_split'],
    reason: 'No claim decided: the VAT-inclusive split moved verbatim out of bankAllocationService '
    + '(R-035 PR6 round 4, its line cap). Pure arithmetic on a code its attended caller already chose; '
    + 'it picks no account and posts nothing.',
  },
  'src/modules/accounting/services/bank/bankSplitJournal.ts': {
    kinds: ['vat_inclusive_split'],
    reason: 'The journal lines of splitAllocateTransaction, moved out of bankAllocationService (line cap, PR #711): '
    + 'the same attended path. The split modal warns and the user\'s vat code stands; the MCP split refuses a code '
    + 'its guard would change before the service runs (writeBankSplit). Decides no claim of its own.',
  },
  'src/modules/accounting/services/bank/bankAllocationService.ts': {
    kinds: ['vat_field_on_a_posting_path', 'allocate_call', 'vat_inclusive_split'],
    reason: 'THE attended path. The bank screen shows the s17(2)(a) and non-supply '
    + 'warnings and the user\'s choice stands. Its unattended callers guard '
    + 'BEFORE calling it; moving a coercion in here would turn every attended '
    + 'override into a no-op.',
  },
  'src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'Attended: someone approves one specific invoice, and the tax amount comes '
    + 'from the captured document rather than being predicted. '
    + 'BillLineItemsTable now warns on a taxed line coded to a non-supply '
    + 'account, which it did not before — but be precise about what that '
    + 'covers: `approveSupplierInvoice` posts ONE combined VAT line from the '
    + 'stored header `taxAmount`, not per line, so the screen warns on the '
    + 'creation path (where the header is the sum of the lines) and does not '
    + 'verify what approval ultimately posts on an invoice captured elsewhere. '
    + 'Since K-072 r30-r31 no capture path predicts a VAT (a bill, receipt journal '
    + 'or claim line whose VAT was not read carries 0 and says so), and since r32 '
    + 'the MCP approve and post_journal tools refuse a captured draft whose VAT '
    + 'is not, to the cent, the VAT read off its document (none only where the '
    + 'document says no VAT applies and prints no VAT number, r34) — those are not attended.',
  },
  'src/modules/accounting/services/expense/expenseClaimService.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'Attended: `postClaimToGl` has one caller, `expense-claims/[id]/post`, '
    + 'reached by a person clicking Post to GL on one claim they approved a '
    + 'moment earlier — and the approve endpoint returns INPUT_VAT_DENIED_ADVICE, '
    + 'which the detail page now renders (ClaimHeaderBanners), so the human who '
    + 'chose the coding was shown the s17(2)(a) warning before the ledger write. It decides NO claim of its own: it picks no account, holds '
    + 'no rate, and forwards `line.vatAmount` that the capture route resolved '
    + 'through `resolveVatCodeForAccount` and the line PATCH warns on. Its only '
    + 'vat_type writes are `deniedVatTypeForLine` (claimVatAdvice, a wrapper over '
    + 'inputVatDenial), which LABELS a zero-VAT leg `no_vat` and never turns a '
    + 'claim on, and `standard` on the VAT Input leg itself (2026-09-25) — a label on '
    + 'the tax the claim lines already carry, box-neutral because the VAT201 reads an '
    + 'uncoded input leg as standard; it claims nothing that was not claimed before.',
  },

  'pages/api/accounting/bank-match-confirm.ts': {
    kinds: ['allocate_call'],
    reason: 'Attended API action on one transaction the user is looking at.',
  },
  'pages/api/accounting/bank-transactions-action.ts': {
    kinds: ['allocate_call'],
    reason: 'Attended API action on one transaction the user is looking at.',
  },
  'pages/api/accounting/bank-transactions-manual.ts': {
    kinds: ['allocate_call'],
    reason: 'Attended API action on one transaction the user is looking at.',
  },

  'src/modules/accounting/services/gl/glImportExecuteService.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'GL import: `vatCode` comes from the file a user uploaded and confirmed. '
    + 'THE WEAKEST "attended" claim on this list — nobody is shown a per-line '
    + 'warning, the codes come from a document rather than a considered '
    + 'decision, and it writes in bulk. That is the same shape as the MCP bulk '
    + 'allocation tool, which turned out to have posted every non-supply line '
    + 'in production. A blind reviewer checked the screen — `gl-import.tsx` is '
    + 'a column mapper with no preview and no per-row VAT display — and called '
    + 'it a fifth candidate for COERCION rather than a fourth attended path. '
    + 'On that reading this entry is a stay of execution, not a verdict.',
  },

  // ── NO CLAIM DECIDED ──────────────────────────────────────────────────────
  'src/modules/accounting/services/ar/writeOffService.ts': {
    kinds: ['vat_field_on_a_posting_path'],
    reason: 'Posts a bad-debt write-off with the fixed code `bad_debt` (VAT201 box '
    + '17). Not an account-dependent claim — the code does not vary with which '
    + 'account the write-off hits.',
  },
  'src/modules/accounting/services/reports/drcVatService.ts': {
    kinds: ['rate_constant'],
    reason: 'Reports on already-posted balances. Chooses no account\'s claim.',
  },
  'src/modules/accounting/services/reports/vat201ReportService.ts': {
    kinds: ['rate_constant'],
    reason: 'Reports on already-posted balances. Chooses no account\'s claim.',
  },
  'src/modules/accounting/services/reports/vatBoxBasis.ts': {
    kinds: ['rate_constant'],
    reason: 'Derives VAT201 box totals from posted journals. Chooses no claim.',
  },
  'src/modules/accounting/services/ap/supplierBankPaymentService.ts': {
    kinds: ['allocate_call'],
    reason: 'allocType supplier — VAT routes to the AP control account, never a '
    + 'user-chosen GL account, so no guard could fire by construction.',
  },
  'src/modules/accounting/services/ar/receiptMatchConfirmService.ts': {
    kinds: ['allocate_call'],
    reason: 'allocType customer — VAT routes to the AR control account. Same reason.',
  },
  'src/modules/accounting/services/core/ocrPreTaxTotal.ts': {
    kinds: ['rate_constant'],
    reason: 'The rate only BOUNDS the VAT an inclusive total can contain, so that the '
    + 'capture gate REFUSES unattended posting and approval when the VAT read '
    + 'exceeds it or shows the total is pre-tax (K-072 r28-r29). It computes no '
    + 'VAT, picks no account and forwards no claim: a refusal sends the document '
    + 'to a person.',
  },
};
