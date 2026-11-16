/**
 * Bank Rules Matching Service
 * Rule-matching and auto-application logic for bank categorisation.
 * CRUD for rules lives in bankRulesService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { fetchVatDenialFlags } from '../gl/inputVatDenial';
import { fetchAccountNames } from '../gl/nonSupplyVatGuard';
import { fetchBankContraFlags } from '../gl/bankContraVat';
import type { RuleApplyResult } from '../../types/bank.types';
import {
  findMatchingTxs, MAX_RULE_CANDIDATES, type RuleAllocType,
} from './bankRulesMatchingHelpers';
import { applySuggestionRules, rulePattern } from './bankRulesSuggestionPass';
import { autoPostRuleLine } from './bankRuleAutoPostLine';
import { autoPostRuleTransferLine } from './bankRuleTransferLine';
import { sweepLineSkip } from './bankRuleSweepSkips';
import { preLockTransferPairs, transferPairKey } from './transferPairLock';
import { recordAutoPosted } from './codingDecisionLog';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { contactControlAccountIds } from './contactControlGuard';

export async function applyRules(
  companyId: string,
  bankAccountId: string,
  userId: string,
  ruleIds?: string[]
): Promise<RuleApplyResult> {
  try {
    const rules = ruleIds && ruleIds.length > 0
      ? (await sql`
          SELECT * FROM bank_categorisation_rules
          WHERE company_id = ${companyId}::UUID
            AND is_active = true
            AND id = ANY(${ruleIds}::UUID[])
          ORDER BY priority ASC
        `) as Record<string, unknown>[]
      : (await sql`
          SELECT * FROM bank_categorisation_rules
          WHERE company_id = ${companyId}::UUID AND is_active = true
          ORDER BY priority ASC
        `) as Record<string, unknown>[];

    if (rules.length === 0) return { applied: 0, skipped: 0, entries: [] };

    // bank_transactions.bank_account_id is an FK to gl_accounts(id) — the
    // "bank account" the user picked is a GL account with account_subtype='bank'.
    // The earlier code looked up bank_accounts.gl_account_id, which is a
    // separate OAuth-bank-feed registry and is empty for almost every tenant,
    // so auto-post rules silently skipped because bankGlAccountId came back
    // null. Use the bank account id directly (it IS the GL account id) and
    // verify the row exists + is bank-subtype.
    const bankAccRows = (await sql`
      SELECT id FROM gl_accounts
      WHERE id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND account_subtype = ANY(${BANK_SUBTYPES as string[]})
    `) as Record<string, unknown>[];
    const bankGlAccountId = bankAccRows[0]?.id ? String(bankAccRows[0].id) : null;

    let totalApplied = 0;
    const entries: RuleApplyResult['entries'] = [];

    const autoCreateRules = rules.filter((r: Record<string, unknown>) => Boolean(r.auto_create_entry));
    const suggestionRules = rules.filter((r: Record<string, unknown>) => !r.auto_create_entry);

    if (suggestionRules.length > 0) {
      const suggested = await applySuggestionRules(companyId, bankAccountId, suggestionRules);
      entries.push(...suggested);
      totalApplied += suggested.length;
    }

    // Auto-create JE mode — sequential (each transaction needs its own JE)
    const autoPostRulesSkippedNoBankGl = (autoCreateRules.length > 0 && !bankGlAccountId)
      ? autoCreateRules.length
      : 0;
    if (autoPostRulesSkippedNoBankGl > 0) {
      log.warn(
        'Bank account is not a valid bank-subtype GL account — skipping auto-post rules',
        { bankAccountId, skippedRules: autoPostRulesSkippedNoBankGl },
        'accounting',
      );
    }
    // Counts of auto-post attempts skipped because the transaction date
    // can't be posted. Tracked separately because the remedies differ:
    //   - closedPeriod  → re-open the period (or accept that history is sealed)
    //   - noPeriod      → create the fiscal year so a covering period exists
    // Conflating them ("everything is closed") sent users in circles when
    // their periods were all open but the year hadn't been created.
    let autoPostSkippedClosedPeriod = 0;
    let autoPostSkippedNoPeriod = 0;
    // Its journal moves a VAT figure inside a locked (filed) VAT period.
    let autoPostSkippedVatLocked = 0;
    // The rule's account is a balance-sheet header (gl/headerAccountGuard): the rule needs repointing.
    let autoPostSkippedHeaderAccount = 0;
    // A rule's refund (money in from a supplier, out to a customer) larger than the credit that contact holds: the
    // document refuses it and the line's savepoint unwinds it — a line a person has to allocate.
    let autoPostSkippedRefundCeiling = 0;
    // The rule's account is AP/AR control (contactControlGuard): posting there has no document. Name the contact.
    let autoPostSkippedControlAccount = 0;
    let autoPostRulesSkippedForeignContact = 0; // rules whose supplier/customer is not this company's
    let autoPostSkippedApprovalRequired = 0;
    let autoPostSkippedRaced = 0;
    let autoPostSkippedLocked = 0;
    let autoPostTruncatedRules = 0;
    // Lines this sweep posted GROSS because the rule asked to claim input tax on
    // an account flagged s17(2)(a). Reported, not silent: a rule set to claim on
    // an entertainment account is a configuration mistake the user must see.
    let autoPostVatDenied = 0;
    // Same shape as the line above: a rule that would have claimed VAT on an
    // account where no supply can arise is a configuration mistake the user
    // must see, not something to fix silently every sweep.
    let autoPostNonSupply = 0;

    // One query for every rule's target account. A sweep posts hundreds of
    // lines against a handful of accounts, so resolving the s17(2)(a) denial
    // inside autoPostRuleLine would be one redundant SELECT per transaction.
    const ruleAccountIds = autoCreateRules
      .map((r) => (r.gl_account_id ? String(r.gl_account_id) : ''))
      .filter(Boolean);
    const [ruleAccountVatDenied, ruleAccountNames, ruleAccountIsBank, ruleAccountIsControl] = await Promise.all([
      fetchVatDenialFlags(companyId, ruleAccountIds),
      // The non-supply guard classifies on account NAME, so the batched branch
      // needs these for the same reason and on the same one-query-per-sweep
      // budget as the denial flags beside them.
      fetchAccountNames(companyId, ruleAccountIds),
      // A transfer rule stores its counterparty BANK in gl_account_id and so
      // arrives as an ordinary `account` line. The name guard cannot see that
      // — "FNB Cheque Account" reads like any other — so the subtype comes
      // along on the same budget.
      fetchBankContraFlags(companyId, ruleAccountIds),
      contactControlAccountIds(companyId, ruleAccountIds),
    ]);

    // WP2 row 5: every transfer rule's pair, sorted, before the sweep's first journal (transferPairLock).
    const heldPairs = await preLockTransferPairs(companyId, bankGlAccountId ? autoCreateRules.flatMap((r) => {
      const acct = r.gl_account_id ? String(r.gl_account_id) : '';
      return acct && !r.supplier_id && !r.client_id && ruleAccountIsBank.get(acct) ? [[bankGlAccountId, acct] as const] : [];
    }) : []);
    let autoPostSkippedOwnBankContra = 0, autoPostSkippedDuplicateTransfer = 0; // onto the swept bank itself; already in the ledger

    for (const rule of (bankGlAccountId ? autoCreateRules : [])) {
      const pattern = rulePattern(rule);
      const field = String(rule.match_field);
      const ruleName = String(rule.rule_name);
      const ruleGlAccountId = rule.gl_account_id ? String(rule.gl_account_id) : null;
      const ruleSupplierId = rule.supplier_id ? String(rule.supplier_id) : null;
      const ruleClientId = rule.client_id ? String(rule.client_id) : null;

      // Determine allocation shape from the rule. Account/bank rules use rule.gl_account_id
      // as the contra. Supplier rules post to AP, customer rules to AR (via systemAccountResolver).
      const allocType: RuleAllocType = ruleSupplierId ? 'supplier'
        : ruleClientId ? 'customer'
        : 'account';

      if (allocType === 'account' && !ruleGlAccountId) {
        log.warn('Skipping auto-create rule with no contra account', { ruleId: rule.id, ruleName }, 'accounting');
        continue;
      }

      // Resolve AP/AR control accounts and entity names lazily (only when needed).
      let apAccountId: string | null = null;
      let arAccountId: string | null = null;
      let supplierName: string | null = null;
      let customerName: string | null = null;
      if (allocType === 'supplier' && ruleSupplierId) {
        apAccountId = await getSystemAccountId('payable', companyId);
        const supRows = (await sql`
          SELECT name FROM suppliers
          WHERE id = ${ruleSupplierId}::UUID AND company_id = ${companyId}::UUID
        `) as Record<string, unknown>[];
        supplierName = supRows.length > 0 ? String(supRows[0]!.name ?? '').trim() || `Supplier #${ruleSupplierId}` : null;
      } else if (allocType === 'customer' && ruleClientId) {
        arAccountId = await getSystemAccountId('receivable', companyId);
        const custRows = (await sql`
          SELECT name FROM customers
          WHERE id = ${ruleClientId}::UUID AND company_id = ${companyId}::UUID
        `) as Record<string, unknown>[];
        customerName = custRows.length > 0 ? String(custRows[0]!.name ?? '').trim() || `Customer #${ruleClientId}` : null;
      }

      // A rule whose contact is not this company's (a row written before the R-067/R-068 fences) posts nothing: its
      // document would name another tenant's contact. Counted per rule: it recurs until the rule is fixed.
      if ((allocType === 'supplier' && supplierName === null) || (allocType === 'customer' && customerName === null)) {
        autoPostRulesSkippedForeignContact++;
        log.warn('Skipping auto-create rule whose contact is not in this company', { ruleId: rule.id, ruleName }, 'accounting');
        continue;
      }

      const matchingTxs = await findMatchingTxs(companyId, bankAccountId, field, pattern);
      if (allocType === 'account' && ruleGlAccountId && ruleAccountIsControl.has(ruleGlAccountId.toLowerCase())) {
        autoPostSkippedControlAccount += Math.min(matchingTxs.length, MAX_RULE_CANDIDATES);
        continue;
      }
      // WP2 row 5: a rule onto ANOTHER bank account posts a transfer (bankRuleTransferLine); onto this one, nothing.
      const transferTo = allocType === 'account' && ruleGlAccountId && ruleAccountIsBank.get(ruleGlAccountId) ? ruleGlAccountId : null;
      if (transferTo === bankGlAccountId) { autoPostSkippedOwnBankContra += Math.min(matchingTxs.length, MAX_RULE_CANDIDATES); continue; }
      if (transferTo && heldPairs.has(transferPairKey(companyId, bankGlAccountId!, transferTo))) { autoPostSkippedLocked += Math.min(matchingTxs.length, MAX_RULE_CANDIDATES); continue; }

      // findMatchingTxs fetches one row past the cap; the extra row is the
      // signal that this rule matched more than one run may take.
      const capped = matchingTxs.slice(0, MAX_RULE_CANDIDATES);
      if (matchingTxs.length > MAX_RULE_CANDIDATES) autoPostTruncatedRules++;

      // Locked in id order, not the candidate query's date order: every
      // allocation path holds its row lock to the end of the request, so two
      // runs touching the same rows in opposite orders deadlock (40P01).
      const orderedTxs = [...capped].sort((a, b) => {
        const x = String(a.id), y = String(b.id);
        return x < y ? -1 : x > y ? 1 : 0;
      });

      for (const tx of orderedTxs) {
        let outcome;
        try {
          // Savepoint per line: a lock timeout is a REAL 55P03, which aborts
          // the transaction — without the savepoint the next candidate's
          // first statement raises 25P02 and the whole run dies after one skip.
          outcome = await withSavepoint('rule_autopost_line', () => transferTo
            ? autoPostRuleTransferLine({ companyId, userId, tx, rule, ruleName, counterpartyBankId: transferTo })
            : autoPostRuleLine({
            companyId, userId, tx, rule, ruleName, allocType, ruleGlAccountId,
            ruleGlAccountVatDenied: ruleGlAccountId
              ? ruleAccountVatDenied.get(ruleGlAccountId) ?? false : false,
            // `?? null` and never undefined: autoPostRuleLine reads undefined
            // as "the caller did not resolve this" and falls back to a
            // per-line lookup, which is the safe reading but not the one we
            // want when the sweep DID resolve it and the account has no name.
            ruleGlAccountName: ruleGlAccountId
              ? ruleAccountNames.get(ruleGlAccountId) ?? null : null,
            // No `?? false`. `bankContraVat` states that absent from the map
            // means "not asked about", never "not a bank", and coalescing here
            // would skip the guard instead of falling back to the per-line
            // lookup — the same reason `ruleGlAccountName` above uses `?? null`
            // for its OWN meaning of absent rather than borrowing this one.
            ruleGlAccountIsBank: ruleGlAccountId
              ? ruleAccountIsBank.get(ruleGlAccountId) : false,
            bankGlAccountId: bankGlAccountId!, apAccountId, arAccountId,
            supplierName, supplierId: ruleSupplierId ?? null, customerName,
          }));
        } catch (lineErr) {
          const skip = sweepLineSkip(lineErr); // every skip's savepoint rolled back cleanly (bankRuleSweepSkips)
          if (skip === null) throw lineErr;
          if (skip === 'vat_locked') autoPostSkippedVatLocked++;
          else if (skip === 'header_account') autoPostSkippedHeaderAccount++;
          else if (skip === 'refund_ceiling') autoPostSkippedRefundCeiling++;
          else if (skip === 'duplicate_transfer') autoPostSkippedDuplicateTransfer++;
          else if (skip === 'approval_required') autoPostSkippedApprovalRequired++;
          else autoPostSkippedLocked++;
          continue;
        }
        if (outcome.kind === 'raced') { autoPostSkippedRaced++; continue; }
        if (outcome.kind === 'no_period') { autoPostSkippedNoPeriod++; continue; }
        if (outcome.kind === 'closed_period') { autoPostSkippedClosedPeriod++; continue; }
        if (outcome.kind === 'vat_period_locked') { autoPostSkippedVatLocked++; continue; }
        if (outcome.kind === 'approval_required') { autoPostSkippedApprovalRequired++; continue; }

        entries.push({ bankTxId: String(tx.id), ruleName, journalEntryId: outcome.journalEntryId });
        await recordAutoPosted(companyId, {
          txId: String(tx.id), source: allocType === 'supplier' ? 'supplier_rule' : 'rule',
          glAccountId: allocType === 'account' ? ruleGlAccountId : null, contactId: ruleSupplierId ?? ruleClientId,
          journalEntryId: outcome.journalEntryId, target: 'own',
        });
        if (outcome.vatDenied) autoPostVatDenied++;
        if (outcome.nonSupplyCoerced) autoPostNonSupply++;
        totalApplied++;
      }
    }

    const remaining = (await sql`
      SELECT COUNT(*) AS cnt FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
        AND feed_state = 'posted'
        AND matched_journal_line_id IS NULL
        AND suggested_gl_account_id IS NULL
        AND suggested_supplier_id IS NULL
        AND suggested_client_id IS NULL
    `) as Record<string, unknown>[];
    const skipped = Number(remaining[0]?.cnt ?? 0);

    const counts = {
      autoPostRulesSkippedNoBankGl, autoPostSkippedClosedPeriod, autoPostSkippedNoPeriod, autoPostSkippedVatLocked,
      autoPostSkippedHeaderAccount, autoPostSkippedControlAccount, autoPostSkippedRefundCeiling, autoPostSkippedApprovalRequired, autoPostSkippedRaced,
      autoPostSkippedLocked, autoPostRulesSkippedForeignContact,
      autoPostTruncatedRules, autoPostVatDenied, autoPostNonSupply,
      autoPostSkippedOwnBankContra, autoPostSkippedDuplicateTransfer,
    };
    log.info('Applied bank rules', { bankAccountId, applied: totalApplied, skipped, ...counts }, 'accounting');
    return { applied: totalApplied, skipped, entries, ...counts };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
