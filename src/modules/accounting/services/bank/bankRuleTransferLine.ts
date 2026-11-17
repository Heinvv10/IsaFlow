/**
 * The rule sweep's TRANSFER line (WP2 row 5): an auto-post rule whose account is a BANK account moves money between
 * the company's own banks. `autoPostRuleLine` posts with `createJournalEntry` directly, past the transfer arm, so such
 * a rule posted the movement a second time beside the other bank's leg or a typed transfer. These lines go through
 * `allocateTransaction`'s transfer arm instead — the pair lock, the duplicate guard and the counterparty leg pairing —
 * and only the rule's own bookkeeping (its id and name on the line) is written here afterwards.
 *
 * A rule whose account is the swept bank ITSELF would post a journal that moves nothing: the sweep skips its lines
 * (`autoPostSkippedOwnBankContra`), the unattended twin of the 400 `allocateTransaction` answers a person.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { allocateTransaction } from './bankAllocationService';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { feedStateOf } from './bankFeedStateGuard';
import { getPeriodStatusForDate } from './bankRulesMatchingHelpers';
import { DuplicateTransferError } from './transferDuplicateGuard';
import { BankControlError } from './bankControlRefusal';
import { ApprovalRequiredError } from '../gl/approvalGate';
import { ClosedFiscalPeriodError } from '../gl/journalEntryPostingGuards';
import type { AutoPostOutcome } from './bankRuleAutoPostLine';

export interface RuleTransferLineInput {
  companyId: string; userId: string; tx: Record<string, unknown>; rule: Record<string, unknown>;
  ruleName: string; counterpartyBankId: string;
}

export async function autoPostRuleTransferLine(input: RuleTransferLineInput): Promise<AutoPostOutcome> {
  const { companyId, userId, tx, rule, ruleName, counterpartyBankId } = input;
  // The period first, from the candidate's date (a line's date is never rewritten): a line it skips takes no row lock
  // for the rest of the sweep (#1494 brk 4, with bankRuleTransferPrelock leaving it out of the pre-lock).
  const periodStatus = await getPeriodStatusForDate(companyId, fmtDate(tx.transaction_date));
  if (periodStatus !== 'open') return { kind: periodStatus === 'no_period' ? 'no_period' : 'closed_period' };
  // The same re-check autoPostRuleLine makes on the locked row: allocated (or moved) since the candidate query.
  const locked = await lockBankTransactionForUpdate(companyId, String(tx.id));
  if (!locked || String(locked.status) !== 'imported' || locked.matched_journal_line_id
      || feedStateOf(locked) !== 'posted') {
    return { kind: 'raced' };
  }

  const totalAmount = Math.abs(Number(tx.amount));
  const description = rule.description_template
    ? String(rule.description_template).replace('{description}', String(tx.description || ''))
      .replace('{amount}', totalAmount.toFixed(2))
    : undefined; // the transfer arm's own "Transfer: to/from <bank>"
  // unattended: the sweep records its own coding decision (recordAutoPosted), as the confidence gate does.
  const posted = await allocateTransaction(companyId, String(tx.id), counterpartyBankId, userId, description,
    'transfer', undefined, undefined, undefined, undefined, undefined, undefined, { unattended: true });
  // allocateTransaction clears the rule columns (a manual allocation replaces a rule's); this one IS the rule's.
  await sql`
    UPDATE bank_transactions
    SET allocation_rule_id = ${String(rule.id)}::UUID, allocation_rule_name = ${ruleName},
        suggested_gl_account_id = NULL, suggested_supplier_id = NULL, suggested_client_id = NULL,
        suggested_category = NULL, suggested_vat_code = NULL
    WHERE id = ${String(tx.id)}::UUID AND company_id = ${companyId}::UUID AND status = 'allocated'`;
  return { kind: 'posted', journalEntryId: posted.journalEntryId, vatDenied: false, nonSupplyCoerced: false };
}

/**
 * The sweep's counter for a transfer line's refusal, raised from reads before any write (its savepoint has rolled
 * back): the movement already in the ledger, or a line an enforced rule or the importer control holds. Null: not a
 * transfer refusal — the sweep's own classification decides.
 */
export function transferRuleSkip(err: unknown): 'duplicate_transfer' | 'approval_required' | 'closed_period' | null {
  if (err instanceof DuplicateTransferError) return 'duplicate_transfer';
  // The period closed between the pre-flight above and the post (an admin closing it mid-sweep): the line's savepoint
  // unwinds the draft — the same counted skip autoPostRuleLine makes of it.
  if (err instanceof ClosedFiscalPeriodError) return 'closed_period';
  if (err instanceof ApprovalRequiredError || err instanceof BankControlError) return 'approval_required';
  return null;
}
