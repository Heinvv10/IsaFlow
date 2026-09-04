/**
 * `reconcile_fixed_assets` — the register against the ledger, decomposed.
 *
 * `asset_register` reports the gap. This reports what the gap is MADE OF, with
 * the account id behind every ledger item and the journal ids behind every
 * account. On Brightsphere that turns "the difference is R5.75m" into two facts
 * a reader can act on: the R7,500 the ledger calls accumulated depreciation is
 * a single MANUAL journal from a migration-479 correction and not a
 * depreciation run at all, and every account subtyped fixed_assets that carries
 * a balance is a loan or an investment.
 *
 * THE ITEMS RECONCILE BY CONSTRUCTION AND THAT IS NOT A PROOF OF ANYTHING.
 * Every held asset and every asset-section account is reported at its own
 * amount, so they sum to the difference whatever the data says. That establishes
 * the report omitted nothing. It establishes nothing about whether an item is
 * correctly classified. The description says so in its own words, because a
 * reader never sees this file.
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import {
  reconcileFixedAssets,
  type AssetReconcilingItem,
  type AssetReconcilingDocument,
} from '@/modules/accounting/services/items/fixedAssetReconciliationService';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  figureBasis,
  isDetailLevel,
  type DetailLevel,
} from '../contracts';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** A read that consumed no ledger row has no `posted_through`. */
const NO_LEDGER_READ = '1970-01-01T00:00:00.000Z';

function itemRow(i: AssetReconcilingItem) {
  return {
    side: i.side,
    type: i.type,
    amount: i.amount,
    attribution: i.attribution,
    attributed_via: i.attributedVia,
    asset_id: i.assetId,
    asset_number: i.assetNumber,
    account_id: i.accountId,
    account_code: i.accountCode,
    account_name: i.accountName,
    account_subtype: i.accountSubtype,
    normal_balance_violated: i.normalBalanceViolated,
    posted_line_count: i.postedLineCount,
    detail: i.detail,
  };
}

function documentRow(d: AssetReconcilingDocument) {
  return {
    account_id: d.accountId,
    account_code: d.accountCode,
    journal_entry_id: d.journalEntryId,
    entry_number: d.entryNumber,
    entry_date: d.entryDate,
    source: d.source,
    description: d.description,
    amount: d.amount,
  };
}

export const reconcileFixedAssetsTool: McpTool = {
  name: 'reconcile_fixed_assets',
  description:
    'Reconciles the fixed asset register to the general ledger as at a date and DECOMPOSES the difference into itemised reconciling items, each carrying the id of the asset or the GL account behind it. '
    + 'Use it to answer "why does the balance sheet disagree with the asset register", not merely "by how much". asset_register reports the same two totals without the items. '
    + 'Returns registerNetBookValue (cost less accumulated depreciation from the assets table), glNetBookValue (posted balances of every account subtyped fixed_assets or accumulated_depreciation), difference = register less GL, and one row per asset and per account. Each row contributes its own amount to the difference. '
    + 'THE TWO SIDES ARE INDEPENDENTLY DERIVED: the register comes from the assets table and the ledger from posted journal lines, so the difference can genuinely be non-zero. '
    + 'WHAT A ZERO DIFFERENCE DOES AND DOES NOT PROVE. READ THIS BEFORE RELYING ON IT. It is NECESSARY AND NOT SUFFICIENT. The items sum to the difference by construction — every asset and every account is reported — so a zero says the two totals happen to agree, NOT that the register and the ledger describe the same assets. Two errors that cancel satisfy it exactly. Treat a zero as an invitation to INSPECT THE ITEMS, never as a conclusion about the accounts. '
    + 'WHAT TO INSPECT. normal_balance_violated marks a cost account carrying a CREDIT balance, or an accumulated-depreciation account carrying a DEBIT one: the sign is opposite to what the subtype implies, so the account is unlikely to be property, plant and equipment. On these books that flag catches millions of rands of loan and investment accounts subtyped fixed_assets, which any single total would present as PPE. The tool REPORTS them; it does not reclassify anything and does not change the chart of accounts. '
    + 'register_linkage_available is false when NO asset and no asset category in the company records a GL account — the state of every production company today. When it is false, every item is attribution "unlinked" because there is no data by which a link could be made, not because a link was checked and failed, and no part of the ledger can be attributed to a specific asset. '
    + 'ACCOUNT SELECTION is by SUBTYPE, never by account name — choosing a bucket by name is how two default_expense accounts became cost of sales and overstated gross profit by R562,428. There is NO is_active filter: a deactivated account with a live balance is still on the balance sheet. '
    + 'An asset disposed on or before as_at is not carrying amount; it appears in excludedRows with the book value it was still carrying, never silently dropped — as disposed_before_as_at when a journal posted for it, and as disposal_not_posted_to_ledger when none did. '
    + 'READ unposted_disposals. A disposal the register recorded and the ledger never heard about is the one register-versus-ledger break that can NEVER move the difference: the asset is out of the register carrying amount and the journal is absent from the ledger, so both sides are zero and the arithmetic closes over a real loss. unposted_disposal_gain_loss is profit or loss that never reached the income statement and unposted_disposal_book_value is cost less depreciation never removed from the balance sheet. Production holds exactly one disposal and it is in this list: Brightsphere COMP-0001, sold 2026-04-12 for R8,000 against a R15,000 book value, a R7,000 loss with no journal. It cannot post on ANY tenant — posting a disposal resolves the system account role disposal_profit_loss and no company has an account carrying that subtype, so the posting throws before it writes. Fixing that is a chart-of-accounts change; this tool reports it and changes nothing. '
    + 'READ disclosures BEFORE TRUSTING A ZERO. Accounts are selected by SUBTYPE, so an account typed asset that carries NONE is in neither side of this reconciliation — and because the items and the totals come from the same subtype-filtered query, its balance could never make the difference non-zero. Every such account is listed in disclosures with its id and balance, and unsubtyped_account_balance totals them: Velocity Fibre has 58 holding R32,747,547.38, including PPE cost and accumulated-depreciation accounts. They are DISCLOSURES and not excludedRows on purpose — an exclusion is a row that belonged to this report and was withheld, while these were never in its universe, and most of them are debtors or cash rather than fixed assets. This tool cannot tell which is which, because nothing here is inferred from an account NAME. A difference of zero alongside a non-zero unsubtyped_account_balance is not a reconciliation; set the subtype with update_gl_account and re-run. '
    + 'This report makes NO completeness claim (universeTotal is absent) because its rows are PRODUCED by the reconciliation rather than selected from a pool; a universe here could only be synthesized from the numbers it would be checked against, and a claim that cannot fail is worse than none. '
    + 'detail: "summary" returns the totals only, "standard" (default) returns one row per reconciling item, "full" returns one row per journal entry posted to the asset-section accounts — capped at 50 entries per account, most recent first — and is paginated; call again with cursor until next_cursor is null. Follow a journal_entry_id with list_journals or audit_trail, and an asset_id with list_fixed_assets. '
    + 'It reports the gap; it does not repair it, does not run depreciation and posts nothing.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'Reporting date, YYYY-MM-DD. Defaults to today.' },
      detail: {
        type: 'string',
        enum: ['summary', 'standard', 'full'],
        description: 'summary = totals only; standard (default) = reconciling items; full = the journals behind the accounts.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'detail=full only. Default 200.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';
    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());

    // Decoded BEFORE the query: a read tool has no savepoint, so nothing may
    // throw once the query has run.
    // TWO parts, because a journal entry is NOT unique in this list: the rows
    // are grouped by (account, journal entry), so one journal touching both the
    // cost account and the accumulated-depreciation account appears twice. A
    // cursor keyed on the journal id alone resolved to the FIRST occurrence, and
    // page 2 then re-served every row in between — a reader summing the pages
    // double-counts.
    const rawCursor = strArg(args, 'cursor');
    let after: { accountId: string; journalEntryId: string } | null = null;
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor, 2);
      if (!decoded) return toolError('invalid cursor');
      after = { accountId: decoded.parts[0]!, journalEntryId: decoded.parts[1]! };
    }

    // companyId from ctx ONLY.
    const rec = await reconcileFixedAssets(ctx.companyId, asAt);

    const isFull = detail === 'full';
    const rowsTotal = isFull ? rec.documentsTotal : rec.items.length;

    let page: Array<ReturnType<typeof itemRow> | ReturnType<typeof documentRow>>;
    let nextCursor: string | null = null;
    if (isFull) {
      const docs = rec.documents;
      let start = 0;
      if (after !== null) {
        const at = docs.findIndex(
          (d) => d.accountId === after.accountId && d.journalEntryId === after.journalEntryId,
        );
        // A cursor naming a row that is no longer here is REFUSED, not silently
        // restarted at page 1. `findIndex` returning -1 used to become index 0,
        // so a stale cursor re-served the whole report as if it were the next
        // page — every other refusal in this file is explicit and this one has
        // to be too.
        if (at === -1) return toolError('invalid cursor: it names a row this report no longer contains — start again without a cursor');
        start = at + 1;
      }
      const limit = clampLimit(args, 200, 500);
      const slice = docs.slice(start, start + limit);
      const last = slice[slice.length - 1];
      if (last && start + limit < docs.length) {
        nextCursor = encodeCursor({ parts: [last.accountId, last.journalEntryId] });
      }
      page = slice.map(documentRow);
    } else {
      page = rec.items.map(itemRow);
    }

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : page,
      rowsTotal,
      detail,
      as_at: asAt,
      posted_through: rec.postedThrough ?? NO_LEDGER_READ,
      next_cursor: nextCursor,
      excludedRows: rec.excludedRows,
      // universeTotal is DELIBERATELY ABSENT. These rows are PRODUCED by the
      // reconciliation, not selected out of a pool, so any universe would have
      // to be synthesized from `rowsTotal + excludedRows` — the very identity
      // buildEnvelope checks it against, which could then never fail. An absent
      // completeness claim is honest; one that cannot fail reads as
      // verification and is worse than none. CONTRACTS.md §1.
      figureBasis: figureBasis('ppe.register.v1'),
    });

    return ok({
      ...envelope,
      register_cost: rec.registerCost,
      register_accumulated_depreciation: rec.registerAccumulatedDepreciation,
      register_net_book_value: rec.registerNetBookValue,
      gl_cost: rec.glCost,
      gl_accumulated_depreciation: rec.glAccumulatedDepreciation,
      gl_net_book_value: rec.glNetBookValue,
      difference: rec.difference,
      itemsTotal: rec.itemsTotal,
      unexplainedDifference: rec.unexplainedDifference,
      linked_item_count: rec.linkedItemCount,
      unlinked_item_count: rec.unlinkedItemCount,
      register_linkage_available: rec.registerLinkageAvailable,
      contra_normal_balance_count: rec.contraNormalBalanceCount,
      contra_normal_balance_total: rec.contraNormalBalanceTotal,
      documents_total: rec.documentsTotal,
      // Facts about accounts this report could NOT draw from, stated OUTSIDE
      // the completeness identity because they were never in its universe —
      // the universe is defined by subtype and these have none.
      unsubtyped_account_count: rec.unsubtypedAccountCount,
      unsubtyped_account_balance: rec.unsubtypedAccountBalance,
      // A break that can NEVER move `difference`, so it has to be reported
      // beside it: a disposed asset is out of the register's carrying amount
      // and an unposted disposal is absent from the ledger, so both sides are
      // zero and the arithmetic closes over a real recorded loss.
      unposted_disposal_count: rec.unpostedDisposalCount,
      unposted_disposal_gain_loss: rec.unpostedDisposalGainLoss,
      unposted_disposal_book_value: rec.unpostedDisposalBookValue,
      unposted_disposals: rec.unpostedDisposals.map((d) => ({
        asset_id: d.assetId,
        asset_number: d.assetNumber,
        name: d.name,
        disposal_id: d.disposalId,
        disposal_date: d.disposalDate,
        proceeds: d.proceeds,
        book_value_at_disposal: d.bookValueAtDisposal,
        gain_loss: d.gainLoss,
        disposal_record_missing: d.disposalRecordMissing,
      })),
      disclosures: rec.unsubtypedAccounts.map((d) => ({
        account_id: d.accountId,
        account_code: d.accountCode,
        account_name: d.accountName,
        is_active: d.isActive,
        balance: d.balance,
        reason: d.reason,
        detail: d.detail,
      })),
      // The two sides name DIFFERENT figures on purpose. Collapsing them into
      // one "PPE" would destroy the only thing that can detect the break.
      ledgerFigureBasis: figureBasis('ppe.ledger.v1'),
    });
  },
};
