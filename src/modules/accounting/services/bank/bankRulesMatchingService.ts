/**
 * Bank Rules Matching Service
 * Rule-matching and auto-application logic for bank categorisation.
 * CRUD for rules lives in bankRulesService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchVatDenialFlags } from '../gl/inputVatDenial';
import { fetchAccountNames } from '../gl/nonSupplyVatGuard';
import { fetchBankContraFlags } from '../gl/bankContraVat';
import type { RuleApplyResult } from '../../types/bank.types';
import { prepareRuleRun } from './bankRuleRun';
import { journalYearOf, YearKeyCursor } from '../core/numberYearLocks';
import { isRetryableContention } from '../core/retryableContention';
import { isHeldRowError } from '@/lib/lockTimeout';
import { applySuggestionRules } from './bankRulesSuggestionPass';
import { autoPostRuleLine } from './bankRuleAutoPostLine';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { VatPeriodLockedError } from '../gl/journalVatLockGuard';

export async function applyRules(
  companyId: string,
  bankAccountId: string,
  userId: string,
  ruleIds?: string[],
  /** bank-transactions-bulk-commit: candidate lines it could not claim before its year keys (bulkCommitRulePass). */
  opts?: { heldLineIds?: ReadonlySet<string> },
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
    const [ruleAccountVatDenied, ruleAccountNames, ruleAccountIsBank] = await Promise.all([
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
    ]);

    // The run's (rule, line) work, read once before the first journal and walked ordered lazy — by the line's year,
    // then id, then rule priority (bankRuleRun.ts). A line an earlier item posted is no longer a candidate.
    const run = bankGlAccountId ? await prepareRuleRun(companyId, bankAccountId, autoCreateRules) : null;
    const postedIds = new Set<string>();
    const heldIds = new Set<string>();
    autoPostTruncatedRules = run?.truncatedRules ?? 0;
    const cursor = new YearKeyCursor(companyId);
    for (const { ctx, tx } of run?.work ?? []) {
      const txId = String(tx.id);
      await cursor.before([journalYearOf(tx.transaction_date as string | Date)]); // single-year: nothing up front
      if (postedIds.has(txId) || heldIds.has(txId)) continue;
      // bulk-commit could not claim this line before its year keys (a peer held it): counted held, not walked.
      if (opts?.heldLineIds?.has(txId)) { heldIds.add(txId); autoPostSkippedLocked++; continue; }
      const { rule, ruleName, allocType, ruleGlAccountId, ruleSupplierId, apAccountId, arAccountId,
        supplierName, customerName } = ctx;
      let outcome;
      try {
        // Savepoint per line: a lock timeout is a REAL 55P03, which aborts
        // the transaction — without the savepoint the next candidate's
        // first statement raises 25P02 and the whole run dies after one skip.
        outcome = await withSavepoint('rule_autopost_line', () => autoPostRuleLine({
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
        // Another request is holding this row. One contended transaction must
        // not abort a run that has already posted for earlier ones — the
        // route's catch would 400 while withAuth still COMMITted them.
        // Counted and retryable; anything else is a real failure.
        //
        // The UNION, not the bank-line lock alone: a supplier rule also
        // reaches `recordSupplierBankPayment`, whose plan phase raises the
        // payment-lock timeout and the `retryable` refusal for a held bill.
        // Those surface HERE through a
        // savepoint that rolled back cleanly, so the request transaction is
        // still live and re-throwing them committed the earlier lines behind
        // the route's 400 — measured, every bill held: 400 "Action failed",
        // line A posted and committed, line B still imported.
        // createJournalEntry refuses a VAT-moving line dated in a locked
        // VAT period before its draft exists; the line's savepoint has rolled
        // back cleanly, so it is a skip like a closed period, not a failure.
        if (lineErr instanceof VatPeriodLockedError) { autoPostSkippedVatLocked++; continue; }
        // ...and every other held-row event (D11 `isHeldRowError`), the raw 55P03 above all: since migration 858
        // the line's journal number waits on the company+year number lock, bounded at 5 s, and a peer that holds
        // it longer fails the line with a raw 55P03 — through this same rolled-back savepoint.
        if (!isRetryableContention(lineErr) && !isHeldRowError(lineErr)) throw lineErr;
        autoPostSkippedLocked++;
        continue;
      }
      if (outcome.kind === 'raced') { autoPostSkippedRaced++; continue; }
      if (outcome.kind === 'no_period') { autoPostSkippedNoPeriod++; continue; }
      if (outcome.kind === 'closed_period') { autoPostSkippedClosedPeriod++; continue; }
      if (outcome.kind === 'vat_period_locked') { autoPostSkippedVatLocked++; continue; }

      entries.push({ bankTxId: txId, ruleName, journalEntryId: outcome.journalEntryId });
      postedIds.add(txId);
      if (outcome.vatDenied) autoPostVatDenied++;
      if (outcome.nonSupplyCoerced) autoPostNonSupply++;
      totalApplied++;
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

    log.info(
      'Applied bank rules',
      {
        bankAccountId,
        applied: totalApplied,
        skipped,
        autoPostRulesSkippedNoBankGl,
        autoPostSkippedClosedPeriod,
        autoPostSkippedNoPeriod,
        autoPostSkippedVatLocked,
        autoPostSkippedRaced,
        autoPostSkippedLocked,
        autoPostTruncatedRules,
        autoPostVatDenied,
        autoPostNonSupply,
      },
      'accounting',
    );
    return {
      applied: totalApplied,
      skipped,
      entries,
      autoPostRulesSkippedNoBankGl,
      autoPostSkippedClosedPeriod,
      autoPostSkippedNoPeriod,
      autoPostSkippedVatLocked,
      autoPostSkippedRaced,
      autoPostSkippedLocked,
      autoPostTruncatedRules,
      autoPostVatDenied,
      autoPostNonSupply,
    };
  } catch (err) {
    log.error('Failed to apply bank rules', { error: err }, 'accounting');
    throw err;
  }
}
