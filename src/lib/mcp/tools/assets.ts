/**
 * MCP read tools: fixed assets.
 *
 * `asset_register` is the one that proves something. A register on its own
 * repeats whatever the `assets` table says; reconciling it to the ledger is
 * what shows that on these books the two disagree in both directions at once —
 * a register carrying R15,000 for a computer sold in April, against a GL
 * carrying R7,500 of accumulated depreciation and no asset cost at all, which
 * is a negative net book value on the balance sheet.
 *
 * It also lists the GL accounts it counted rather than only their total,
 * because on Brightsphere every account subtyped `fixed_assets` that carries a
 * balance is a loan or investment account. A single total would present
 * −R4.8m of intercompany loans as property, plant and equipment and look
 * unremarkable doing it.
 */
import type { McpTool } from '../types';
import {
  getAssetRegister,
  getAssetGlReconciliation,
} from '@/modules/accounting/services/items/assetRegisterService';
import { buildEnvelope, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { clampLimit, guardCastableArgs, ok, strArg } from './toolHelpers';
import { fmtDate } from '@/lib/fmtDate';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

export const listFixedAssetsTool: McpTool = {
  name: 'list_fixed_assets',
  description:
    'List the fixed assets on the register as at a date: asset number, name, category, status, purchase date and price, accumulated depreciation and net book value. ' +
    'An asset DISPOSED on or before as_at is not carrying amount and is excluded from the rows and the totals — it appears in excludedRows as disposed_before_as_at with the book value it was still carrying, because "there is one asset and it was sold" and "there are no assets" are different facts. Assets bought after as_at do not appear at all. ' +
    'This is the SUBLEDGER, not the balance sheet. The figures come from the assets table and are whatever was last written there; they are not derived from journal entries and nothing here proves the ledger agrees. Call asset_register to compare the two — on these books they differ. ' +
    'Depreciation shown is the accounting (policy) figure on the asset record, not the SARS wear-and-tear allowance, and it is only as current as the last depreciation run.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'number', description: 'Default 100, max 500.' },
      offset: { type: 'number' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['as_at'] });
    if (guard) return guard;

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const detail = detailOf(args);
    const offsetRaw = Number(args.offset);
    const page = await getAssetRegister(ctx.companyId, asAt, {
      limit: clampLimit(args, 100, 500),
      offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0,
    });

    const excludedRows: ExcludedRow[] = page.disposed.map((a) => ({
      id: a.id,
      reason: 'disposed_before_as_at',
      detail: `Disposed on ${a.disposalDate}${a.disposalAmount === null ? '' : ` for ${a.disposalAmount.toFixed(2)}`}; not carrying amount at ${asAt}.`,
      amount: a.netBookValue,
      documentNumber: a.assetNumber,
    }));

    const rows = page.rows.map((a) => ({
      id: a.id,
      asset_number: a.assetNumber,
      name: a.name,
      category: a.category,
      status: a.status,
      purchase_date: a.purchaseDate,
      purchase_price: a.purchasePrice,
      accumulated_depreciation: a.accumulatedDepreciation,
      net_book_value: a.netBookValue,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: page.rowsTotal,
      // getAssetRegister already counts the universe in its own query —
      // COUNT(*) over every asset acquired on or before as_at, disposed
      // included — so take that rather than rebuild it from the two halves
      // being checked. The old expression was wrong twice: it could not fail,
      // and `disposed` is filtered from the PAGE while rowsTotal is the global
      // count, so the synthesized universe drifted with the offset.
      universeTotal: page.universeTotal,
      detail,
      as_at: asAt,
      // The register is not built from journal rows; there is nothing honest to
      // pin it to, and now() would prove nothing. asset_register carries the
      // ledger's own posted_through.
      posted_through: NO_LEDGER_ROWS,
      excludedRows,
    });

    return ok({ ...envelope, totals: page.totals });
  },
};

export const assetRegisterTool: McpTool = {
  name: 'asset_register',
  description:
    'Reconcile the fixed asset register to the general ledger as at a date, and report the gap. This is the assurance call: it returns the register carrying amount, the GL carrying amount, and the difference between them, with the individual GL accounts behind each side. ' +
    'The GL side is selected by account SUBTYPE — fixed_assets for cost, accumulated_depreciation for the contra — never by account name, because choosing a bucket by name is how two default_expense accounts became cost of sales and overstated gross profit by R562,428. It applies NO is_active filter: a deactivated account with a balance is still on the balance sheet. ' +
    'READ THE ACCOUNT LIST, NOT JUST THE TOTAL. On these books every account subtyped fixed_assets that carries a balance is an intercompany loan or investment account, so the total presents millions of rands of loans as property, plant and equipment. The list is what makes that visible. ' +
    'reconciled is true only when the difference is exactly zero. A non-zero difference does not tell you which side is wrong — a register that was never posted to the GL, depreciation journalised against no asset, or an account with the wrong subtype all produce one. It reports the gap; it does not repair it, does not run depreciation, and does not post anything.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['as_at'] });
    if (guard) return guard;

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const rec = await getAssetGlReconciliation(ctx.companyId, asAt);

    const account = (a: {
      accountId: string; accountCode: string; accountName: string;
      subtype: string; balance: number; isActive: boolean;
    }) => ({
      account_id: a.accountId,
      account_code: a.accountCode,
      account_name: a.accountName,
      subtype: a.subtype,
      balance: a.balance,
      is_active: a.isActive,
    });

    return ok({
      as_at: asAt,
      posted_through: rec.postedThrough ?? NO_LEDGER_ROWS,
      reconciliation: {
        register_cost: rec.registerCost,
        register_accumulated_depreciation: rec.registerAccumulatedDepreciation,
        register_net_book_value: rec.registerNetBookValue,
        gl_cost: rec.glCost,
        gl_accumulated_depreciation: rec.glAccumulatedDepreciation,
        gl_net_book_value: rec.glNetBookValue,
        difference: rec.difference,
        reconciled: rec.difference === 0,
        cost_accounts: rec.costAccounts.map(account),
        accumulated_depreciation_accounts: rec.accumulatedDepreciationAccounts.map(account),
      },
    });
  },
};
