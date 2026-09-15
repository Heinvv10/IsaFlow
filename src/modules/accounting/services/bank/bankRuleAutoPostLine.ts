/**
 * One auto-post rule line: lock the candidate, allocate it, report the outcome.
 *
 * Extracted from `bankRulesMatchingService.applyRules`, whose loop pushed that
 * file over the 300-line limit. The counters the loop used to increment inline
 * are the outcome this returns, so the caller still owns the tallying.
 *
 * The line posts through `allocateTransaction` — THE SAME controlled bank
 * allocation a person performs on the screen — and not through a journal of
 * its own. Every journal this path generates carries a `source` on the
 * kernel's generated-journal blacklist (`auto_supplier_payment`,
 * `auto_payment`, `auto_bank_recon`), so a bare `postJournalEntry` here was
 * refused on every line as a direct operation on a generated journal, and the
 * sweep posted nothing. Going through the allocation gives each line the same
 * intent, receipt (`control_operation_effects`), change events, payment
 * document and `parentControl` as the attended path, and the same refusals:
 * every one the controlled path raises (approval policy, unverified
 * beneficiary, closed period, lockdown, filed VAT period, permission, or any
 * other business refusal) becomes a per-line outcome — see
 * `bankRuleAutoPostRefusal.ts` — with the line LEFT UNPOSTED. What a refused
 * line prepared (its intent, its change event) is unwound by
 * `allocateTransaction`'s own `bank_allocation_adapter` savepoint (runPlan)
 * before the error reaches this catch; the sweep's per-line savepoint is for
 * the lock timeout that aborts the transaction. Never posted around the rule.
 */

import { classifyAutoPostRefusal, type AutoPostRefusal } from './bankRuleAutoPostRefusal';
import type { RuleAllocType } from './bankRulesMatchingHelpers';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { allocateTransaction } from './bankAllocationService';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { feedStateOf } from './bankFeedStateGuard';

export type AutoPostOutcome =
  | { kind: 'posted'; journalEntryId: string; vatDenied: boolean; nonSupplyCoerced: boolean }
  /** The row was allocated (or removed) between the candidate query and the lock. */
  | { kind: 'raced' }
  | AutoPostRefusal;

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
  /**
   * Whether the rule's contra account IS a bank account. Pre-resolved by the
   * sweep; undefined means "look it up per line", never "not a bank".
   */
  ruleGlAccountIsBank?: boolean;
  ruleName: string;
  allocType: RuleAllocType;
  ruleGlAccountId: string | null;
  supplierName: string | null;
  /** The rule's supplier: the party the controlled allocation creates the payment document for. */
  supplierId: string | null;
  customerName: string | null;
  customerId: string | null;
}

export async function autoPostRuleLine(input: AutoPostLineInput): Promise<AutoPostOutcome> {
  const {
    companyId, userId, tx, rule, ruleName, allocType, ruleGlAccountId,
    supplierName, supplierId, customerName, customerId,
  } = input;

  // findMatchingTxs read every candidate in one query, possibly seconds
  // ago. Lock the row and re-check before posting anything for it: a UI
  // allocation committed in between would otherwise get a second journal
  // posted on top of it.
  const locked = await lockBankTransactionForUpdate(companyId, String(tx.id));
  if (!locked || String(locked.status) !== 'imported' || locked.matched_journal_line_id
      || feedStateOf(locked) !== 'posted') {
    return { kind: 'raced' };
  }

  // No period pre-flight of its own: the controlled allocation refuses a
  // closed period, a lockdown and a filed VAT period BEFORE its write
  // (`executeBankAllocation`), with the kernel's own classes, and the catch
  // below turns each into the per-line outcome. One rule, one owner.
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
    ruleGlAccountIsBank: input.ruleGlAccountIsBank,
    denialContext,
    guardContext: { bankTxId: String(tx.id), ruleName, glAccountId: ruleGlAccountId ?? undefined },
  });

  // A party allocation carries no VAT code: settling a bill or an invoice
  // moves the control account gross — the tax was claimed on the document.
  // Only an account rule splits, and only with the code the guards allowed.
  const partyId = allocType === 'supplier' ? supplierId : allocType === 'customer' ? customerId : undefined;
  const contraAccountId = allocType === 'account' ? ruleGlAccountId : null;
  try {
    const result = await allocateTransaction(
      companyId, String(tx.id), contraAccountId, userId, entryDesc, allocType,
      partyId ?? undefined, allocType === 'account' ? vatCode : undefined,
      undefined, undefined, undefined, undefined,
      { rule: { id: String(rule.id), name: ruleName } },
    );
    return { kind: 'posted', journalEntryId: result.journalEntryId, vatDenied, nonSupplyCoerced };
  } catch (err) {
    // A refusal becomes this line's outcome; a fault (pg, or an integrity
    // failure that already poisoned the request) propagates and aborts the run.
    const refusal = classifyAutoPostRefusal(err);
    if (!refusal) throw err;
    return refusal;
  }
}
