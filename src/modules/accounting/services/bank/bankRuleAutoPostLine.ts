/**
 * One auto-post rule line: lock the candidate, post its journal, settle the row.
 *
 * Extracted from `bankRulesMatchingService.applyRules`, whose loop pushed that
 * file over the 300-line limit. Behaviour is unchanged - the counters the loop
 * used to increment inline are now the outcome this returns, so the caller
 * still owns the tallying.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { recordSupplierBankPayment } from '../ap/supplierAutoAllocate';
import {
  createJournalEntry,
  postJournalEntry,
  ClosedFiscalPeriodError,
} from '../gl/journalEntryService';
import { buildAutoCreateLines, getPeriodStatusForDate, type RuleAllocType } from './bankRulesMatchingHelpers';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';

const SA_VAT_RATE_PCT = 15; // Standard SA VAT rate; update if SARS changes the statutory rate

export type AutoPostOutcome =
  | { kind: 'posted'; journalEntryId: string; vatDenied: boolean; nonSupplyCoerced: boolean }
  /** The row was allocated (or removed) between the candidate query and the lock. */
  | { kind: 'raced' }
  /** Its date falls in a closed/locked period - re-open the period to post it. */
  | { kind: 'closed_period' }
  /** No fiscal period covers its date - the year has not been created. */
  | { kind: 'no_period' };

export interface AutoPostLineInput {
  companyId: string;
  userId: string;
  /** The candidate row from findMatchingTxs. */
  tx: Record<string, unknown>;
  /** The rule row being applied. */
  rule: Record<string, unknown>;
  /**
   * `vat_input_denied` for `ruleGlAccountId`, resolved ONCE per sweep by the
   * caller. A sweep posts hundreds of lines against a handful of rule accounts,
   * so reading it here would be one redundant SELECT per transaction.
   */
  ruleGlAccountVatDenied?: boolean;
  /**
   * `account_name` for `ruleGlAccountId`, resolved in the same one-per-sweep
   * query as the denial flag. The non-supply guard classifies on NAME, so the
   * batched branch below cannot run it without this — and an omitted name
   * silently disables a guard, which is why the branch falls back to the
   * per-line resolver rather than treating undefined as "nothing to check".
   */
  ruleGlAccountName?: string | null;
  ruleName: string;
  allocType: RuleAllocType;
  ruleGlAccountId: string | null;
  bankGlAccountId: string;
  apAccountId: string | null;
  arAccountId: string | null;
  supplierName: string | null;
  /**
   * The rule's supplier. Needed as well as the NAME because this path creates
   * the supplier payment DOCUMENT for the cash it posts — the name alone only
   * labels the bank row.
   */
  supplierId: string | null;
  customerName: string | null;
}

export async function autoPostRuleLine(input: AutoPostLineInput): Promise<AutoPostOutcome> {
  const {
    companyId, userId, tx, rule, ruleName, allocType, ruleGlAccountId,
    bankGlAccountId, apAccountId, arAccountId, supplierName, supplierId, customerName,
  } = input;

  // findMatchingTxs read every candidate in one query, possibly seconds
  // ago. Lock the row and re-check before posting anything for it: a UI
  // allocation committed in between would otherwise get a second journal
  // posted on top of it, and the UPDATE below would relink the row to it.
  const locked = await lockBankTransactionForUpdate(companyId, String(tx.id));
  if (!locked || String(locked.status) !== 'imported' || locked.matched_journal_line_id) {
    return { kind: 'raced' };
  }

  // fmtDate, never toISOString: on a UTC+2 host the latter shifted the entry
  // date back a day, so a transaction on the 1st auto-posted into the PREVIOUS
  // month — a different VAT period — and the open-period check below then ran
  // against that wrong period too.
  const entryDate = fmtDate(tx.transaction_date);

  // Pre-flight: skip transactions whose date can't post. Without this,
  // createJournalEntry would insert a draft JE row, postJournalEntry
  // would reject it, and the draft would dangle in the GL forever.
  const periodStatus = await getPeriodStatusForDate(companyId, entryDate);
  if (periodStatus !== 'open') {
    return { kind: periodStatus === 'no_period' ? 'no_period' : 'closed_period' };
  }

  const totalAmount = Math.abs(Number(tx.amount));
  const isDeposit = Number(tx.amount) > 0;
  const entryDesc = rule.description_template
    ? String(rule.description_template)
        .replace('{description}', String(tx.description || ''))
        .replace('{amount}', totalAmount.toFixed(2))
    : allocType === 'supplier'
      ? (isDeposit ? `Refund from ${supplierName}` : `Payment to ${supplierName}`)
    : allocType === 'customer'
      ? (isDeposit ? `Receipt from ${customerName}` : `Refund to ${customerName}`)
    : `Bank: ${tx.description || 'Categorised by rule'}`;

  // The same resolver the screen's allocateTransaction uses. A rule may not
  // claim input tax against an account that denies it (s17(2)(a)): every rule
  // pointing at Staff Welfare carried vat_code='standard', and this path split
  // each restaurant charge 15% exclusive on the strength of it.
  const requestedVatCode = String(rule.vat_code || 'none');
  const denialContext = { companyId, bankTxId: String(tx.id), ruleName, glAccountId: ruleGlAccountId };
  // The sweep resolves every rule account ONCE and passes it in. A caller that
  // omits it (undefined, as opposed to an explicit null meaning "no default")
  // gets the lookup done here instead: this guard is a statutory one, and a
  // caller forgetting to pass an argument must not silently turn it off.
  const { vatCode, denied: vatDenied, nonSupplyCoerced } = await resolveRuleVatCode({
    allocType,
    companyId,
    requestedVatCode,
    glAccountId: ruleGlAccountId,
    ruleGlAccountVatDenied: input.ruleGlAccountVatDenied,
    ruleGlAccountName: input.ruleGlAccountName,
    denialContext,
    guardContext: { bankTxId: String(tx.id), ruleName, glAccountId: ruleGlAccountId ?? undefined },
  });
  const hasVat = vatCode === 'standard';
  const netAmount = hasVat ? Math.round((totalAmount * 100 / (100 + SA_VAT_RATE_PCT)) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
  // Supplier payment is a money-out from this bank → vat_input on the AP side.
  // Customer receipt is a money-in to this bank → vat_output on the AR side.
  const vatAccountKey: 'vat_input' | 'vat_output' = allocType === 'supplier' ? 'vat_input'
    : allocType === 'customer' ? 'vat_output'
    : (isDeposit ? 'vat_output' : 'vat_input');
  const mapVatType = vatCode === 'standard' ? 'standard' as const
    : vatCode === 'zero_rated' ? 'zero_rated' as const
    : vatCode === 'exempt' ? 'exempt' as const
    : undefined;

  const source: import('../../types/gl.types').GLEntrySource = allocType === 'supplier'
    ? 'auto_supplier_payment'
    : allocType === 'customer'
    ? 'auto_payment'
    : 'auto_bank_recon';
  // The rule's name is NOT the account. Storing it here is what made the Bank
  // Transactions "Account" column show "ROMANS PIZZA" for a purchase that posted
  // to Staff Welfare. The counterparty label stays the supplier/customer for
  // those types; an account-type rule stores the account it posts to, and the
  // rule's own name goes to allocation_rule_name.
  const allocEntityName = allocType === 'supplier' ? supplierName!
    : allocType === 'customer' ? customerName!
    : await accountLabel(companyId, ruleGlAccountId);

  const lines = await buildAutoCreateLines({
    allocType, totalAmount, netAmount, vatAmount, hasVat, vatAccountKey,
    vatType: mapVatType, isDeposit,
    bankGlAccountId: bankGlAccountId!, ruleGlAccountId, apAccountId, arAccountId,
    entryDesc, companyId,
  });

  const je = await createJournalEntry(companyId, {
    entryDate,
    description: entryDesc,
    source,
    lines,
  }, userId);
  try {
    await postJournalEntry(companyId, je.id, userId);
  } catch (err) {
    // The pre-flight above should have caught closed periods, but the
    // fiscal-period state can flip between the pre-flight and the post
    // (rare race; admin closing a period mid-apply). On that path we
    // hard-delete the draft we just inserted instead of leaving it
    // dangling, then report the skip. Anything else re-throws.
    if (err instanceof ClosedFiscalPeriodError) {
      await sql`
        DELETE FROM gl_journal_entries
        WHERE id = ${je.id}::UUID
          AND company_id = ${companyId}::UUID
          AND status = 'draft'
      `;
      return { kind: 'closed_period' };
    }
    throw err;
  }

  const bankLineRows = (await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankGlAccountId}::UUID
      AND jl.company_id = ${companyId}::UUID
    LIMIT 1
  `) as Record<string, unknown>[];

  if (bankLineRows[0]) {
    await sql`
      UPDATE bank_transactions
      SET status = 'allocated', matched_journal_line_id = ${bankLineRows[0].id}::UUID,
          allocation_type = ${allocType},
          allocated_entity_name = ${allocEntityName},
          allocation_rule_id = ${String(rule.id)}::UUID,
          allocation_rule_name = ${ruleName},
          suggested_gl_account_id = NULL,
          suggested_supplier_id = NULL,
          suggested_client_id = NULL,
          suggested_category = NULL,
          suggested_vat_code = NULL,
          updated_at = NOW()
      WHERE id = ${tx.id}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  // THE DOCUMENT FOR THE CASH, on the path with no human in the loop.
  //
  // This function posts its OWN journal rather than calling
  // `allocateTransaction`, so the payment document that path creates was never
  // created here: a rule sweep debited Accounts Payable hundreds of times and
  // left no supplier payment behind any of it. Every one of those lines is
  // cash on the control account that no document, and therefore no report and
  // no apply tool, can reach.
  //
  // `!isDeposit` gates it for the same reason it gates the attended path: a
  // refund is money coming back IN and is not a payment.
  //
  // NOT caught. It writes, and a caught write is a partial commit reported as
  // a success — see ap/supplierAutoAllocate.ts. The sweep's own savepoint
  // unwinds this line and leaves the rest of the batch alone.
  if (allocType === 'supplier' && supplierId && !isDeposit) {
    await recordSupplierBankPayment({
      companyId,
      supplierId,
      bankTxId: String(tx.id),
      bankAccountId: bankGlAccountId,
      journalEntryId: je.id,
      amount: totalAmount,
      paymentDate: entryDate,
      description: entryDesc,
      userId,
    });
  }

  return { kind: 'posted', journalEntryId: je.id, vatDenied, nonSupplyCoerced };
}

/** "<code> <name>" for a GL account, or null when the rule carries no account. */
async function accountLabel(companyId: string, glAccountId: string | null): Promise<string | null> {
  if (!glAccountId) return null;
  const rows = (await sql`
    SELECT account_code, account_name FROM gl_accounts
    WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  return rows[0] ? `${String(rows[0].account_code)} ${String(rows[0].account_name)}` : null;
}
