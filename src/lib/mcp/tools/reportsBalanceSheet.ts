/**
 * `balance_sheet` v2 — a WRAP of `getBalanceSheet`, with the second equity
 * figure the first one hides.
 *
 * A balance sheet always balances. Equity is whatever makes it balance, so a
 * report that states "Assets = Liabilities + Equity" has asserted an identity
 * of its own construction and proved nothing about the books. There are two
 * equity figures and they answer different questions:
 *
 *   equityResidual    assets − liabilities. Balances by construction.
 *   equityFromLedger  the sum of the POSTED equity accounts. Nothing derived.
 *
 * The second one is not `report.totalEquity`, and that distinction is the whole
 * value of this tool. `fetchBalanceSheetData` computes retained earnings as
 * revenue less expenses to the date and injects it into the equity section, so
 * `totalEquity` equals assets − liabilities BY CONSTRUCTION. Reporting it as
 * the second opinion agreed to the cent on all three production companies and
 * read as a clean set of books.
 *
 * The equity ACCOUNTS say otherwise. **Brightsphere and Velocity Fibre each
 * carry R0.00 of posted equity**, so every cent of Brightsphere's
 * R8,394,848.60 and of Velocity's −R34,816,224.89 is derived — profit no
 * year-end close has ever posted to an equity account. `equityDifference` is
 * exactly that plug, and `retainedEarningsDerived` names it.
 *
 * This is why `equity.ledger.v1` was held unowned until a report needed both
 * figures at once.
 *
 * `asAtDate`, `compareDate` and `costCentreId` all existed on the service and
 * were simply not reachable from MCP. That is the rest of this file.
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import { buildEnvelope, figureBasis, isDetailLevel, type DetailLevel } from '@/lib/mcp/contracts';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** Anything below this is rounding, not a difference. */
const EQUITY_TOLERANCE = 0.01;

type Section = 'asset' | 'liability' | 'equity';

interface BalanceSheetRow {
  section: Section;
  accountCode: string;
  accountName: string;
  balance: number;
  priorBalance?: number;
  variance?: number;
}

interface ServiceLine {
  accountCode: string;
  accountName: string;
  balance: number;
  priorBalance?: number;
  variance?: number;
}

function rowsFor(section: Section, lines: readonly ServiceLine[]): BalanceSheetRow[] {
  return lines.map((l) => ({
    section,
    accountCode: l.accountCode,
    accountName: l.accountName,
    balance: l.balance,
    ...(l.priorBalance === undefined ? {} : { priorBalance: l.priorBalance }),
    ...(l.variance === undefined ? {} : { variance: l.variance }),
  }));
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

const DESCRIPTION = [
  'Balance sheet as at a date, with BOTH equity figures rather than the one that always agrees.',
  'equityResidual is assets less liabilities and balances by construction — it is not evidence of anything. equityFromLedger is the sum of the POSTED equity-account balances, with nothing derived added to it.',
  'Note that totalEquity is NOT the second figure: this report computes retained earnings as revenue less expenses to the date and injects it into the equity section, so totalEquity equals equityResidual by construction and agreeing with it proves nothing.',
  'equityDifference is equityResidual − equityFromLedger, and retainedEarningsDerived is the same number named for what it is: profit that no year-end close has posted to an equity account. equityReconciles says whether it is within a cent. On two production companies the equity accounts carry R0.00 and the ENTIRE equity figure is that plug — R8,394,848.60 on one, −R34,816,224.89 on the other.',
  'compare_date adds a prior-date column with per-account priorBalance and variance, and BOTH equity figures for the prior date as well.',
  'cost_centre_id restricts every figure to one cost centre.',
  'equityReconciles is only informative BECAUSE equityFromLedger is now queried from the equity accounts rather than injected. An earlier version compared totalEquity against the residual and returned true on all three production companies — a tautology, since totalEquity equals the residual by construction. Like every self-checking identity here, a true is necessary and not sufficient: two errors that cancel satisfy it, so treat it as a precondition for inspecting the numbers rather than as a conclusion about the books.',
  'rows are the account lines of all three sections flattened, each labelled with its section. detail "summary" returns the totals and no rows.',
].join(' ');

export const balanceSheetTool: McpTool = {
  name: 'balance_sheet',
  description: DESCRIPTION,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' },
      compare_date: {
        type: 'string', format: 'date',
        description: 'YYYY-MM-DD. Adds a prior-date column and its own two equity figures.',
      },
      cost_centre_id: { type: 'string', description: 'Restrict every figure to one cost centre.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // Casts are validated BEFORE the query: a read tool runs with no savepoint,
    // so a 22007 or 22P02 raised after it aborts the whole request transaction
    // and the registry's own refund write then fails with 25P02.
    const bad = guardCastableArgs(args, {
      date: ['as_at', 'compare_date'],
      uuid: ['cost_centre_id'],
    });
    if (bad) return bad;

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const compareDate = strArg(args, 'compare_date');
    if (compareDate !== undefined && compareDate >= asAt) {
      // 'YYYY-MM-DD' compares correctly as text. A comparative dated on or
      // after the reporting date is not a comparative, and silently accepting
      // one produces variances with the sign reversed.
      return toolError('compare_date must be earlier than as_at');
    }
    const costCentreId = strArg(args, 'cost_centre_id');

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';

    // companyId from ctx ONLY.
    const report = await getBalanceSheet(ctx.companyId, asAt, costCentreId, compareDate);
    const equity = await getEquityBases(ctx.companyId, asAt, costCentreId);
    const priorEquity =
      compareDate === undefined
        ? null
        : await getEquityBases(ctx.companyId, compareDate, costCentreId);
    const postedThrough = await getLedgerPostedThrough(ctx.companyId, asAt);

    const rows: BalanceSheetRow[] = [
      ...rowsFor('asset', report.assets),
      ...rowsFor('liability', report.liabilities),
      ...rowsFor('equity', report.equity),
    ];

    const equityResidual = round2(report.totalAssets - report.totalLiabilities);
    // The POSTED equity accounts, not report.totalEquity — which carries the
    // injected retained-earnings plug and therefore equals the residual by
    // construction.
    const equityFromLedger = round2(equity.posted);
    const equityDifference = round2(equityResidual - equityFromLedger);

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      detail,
      as_at: asAt,
      posted_through: postedThrough,
      // Every line the service returned is served; nothing is classified out,
      // so the universe is exactly what was reported.
      universeTotal: rows.length,
    });

    const prior =
      report.compareDate === undefined
        ? {}
        : {
            compare_date: report.compareDate,
            priorTotalAssets: report.priorTotalAssets,
            priorTotalLiabilities: report.priorTotalLiabilities,
            priorTotalEquity: report.priorTotalEquity,
            // Both figures on the prior date too. A comparative that carries
            // only the residual reintroduces the defect on the column nobody
            // checks.
            priorEquityResidual: round2(
              (report.priorTotalAssets ?? 0) - (report.priorTotalLiabilities ?? 0),
            ),
            priorEquityFromLedger: round2(priorEquity?.posted ?? 0),
            priorRetainedEarningsDerived: round2(priorEquity?.derivedRetainedEarnings ?? 0),
          };

    return ok({
      ...envelope,
      totalAssets: report.totalAssets,
      totalLiabilities: report.totalLiabilities,
      totalEquity: report.totalEquity,
      equityResidual,
      equityFromLedger,
      equityDifference,
      // The same number as equityDifference, named for what it actually is.
      retainedEarningsDerived: round2(equity.derivedRetainedEarnings),
      equityReconciles: Math.abs(equityDifference) < EQUITY_TOLERANCE,
      cost_centre_id: costCentreId ?? null,
      // Named separately because they are two different figures with two
      // different owners, and the envelope carries one basis.
      equityFigureBasis: {
        residual: figureBasis('equity.residual.v1'),
        ledger: figureBasis('equity.ledger.v1'),
      },
      ...prior,
    });
  },
};
