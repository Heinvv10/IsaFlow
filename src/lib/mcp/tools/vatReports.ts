/**
 * MCP tools around the VAT return: the reconciliation, the export, and the lock.
 *
 * `vat_reconciliation` WRAPS `reports/vatReconciliationService`, which the UI
 * already calls and which already computes the monthly GL-versus-return
 * comparison. The R1,383,192 apparent shortfall on Brightsphere was assembled
 * by hand from a Sage bank export; this is one call.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, actorForMcp, buildEnvelope, figureBasis } from '../contracts';
import { getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';
import { exportVat201, type Vat201ExportFormat } from '@/modules/accounting/services/reports/vat201ExportService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import {
  getVatPeriodLock,
  lockVatPeriod,
} from '@/modules/accounting/services/reports/vatPeriodLockService';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

function periodArgs(args: Record<string, unknown>): { start: string; end: string } | string {
  const start = strArg(args, 'period_start');
  const end = strArg(args, 'period_end');
  if (!start || !end) return 'period_start and period_end are required (YYYY-MM-DD)';
  if (start > end) return 'period_start must not be after period_end';
  return { start, end };
}

export const vatReconciliationTool: McpTool = {
  name: 'vat_reconciliation',
  description:
    'Reconciles VAT month by month across three sources: what the general ledger posted, what the invoices say, and what was actually submitted on a VAT return. Returns each month with GL revenue and VAT, invoice revenue and VAT, the submitted return where one exists, the capital-goods split, the variance between each pair, and the effective VAT rate. '
    + 'issues[] flags a month whose effective rate falls outside 14–16% (a misclassification of zero-rated or exempt supplies), a revenue or output-VAT variance above the threshold, and any month with no return submitted at all. '
    + 'USE IT FOR: "does the VAT control account agree with what we filed", and "how much VAT is sitting in the ledger that SARS has never been told about" — R1,383,192 of apparent shortfall on one company was assembled by hand from a bank export before this existed. '
    + 'LIMITS: a month with no vat_returns record shows returnOutputVat null and a variance of 0, which means NOT SUBMITTED, not "agrees". Supplier-invoice input VAT is not carried in the invoice column (invoiceInputVat is always 0) — compare glInputVat instead. It reports; it files nothing.',
  scope: 'read:vat',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const period = periodArgs(args);
    if (typeof period === 'string') return toolError(period);
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;

    const recon = await getVatReconciliation(ctx.companyId, period.start, period.end);
    // posted_through comes from the VAT report over the same range rather than
    // now(): the two read the same journals, and a figure whose provenance is
    // a clock cannot be re-derived.
    const { postedThrough } = await getVat201Report(ctx.companyId, period.start, period.end, { detail: 'summary' });

    return ok({
      periodStart: recon.periodStart,
      periodEnd: recon.periodEnd,
      totals: recon.totals,
      issues: recon.issues,
      ...buildEnvelope({
        rows: recon.months,
        rowsTotal: recon.months.length,
        // universeTotal omitted: rows ARE the months in the requested range; the report produces them rather than filtering a pool,
        // so a universe equal to rowsTotal would make the identity unfalsifiable.
        excludedRows: [],
        detail: 'standard',
        as_at: recon.periodEnd,
        posted_through: postedThrough,
        figureBasis: figureBasis('vat.output.v1'),
      }),
    });
  },
};

export const vat201ExportTool: McpTool = {
  name: 'vat201_export',
  description:
    'The VAT201 in a form you can file: the SARS field codes (F01–F16) with their values, or a CSV of the boxes. Computed from the SAME journal-derived boxes as vat_status, so the return you export is the one the 15% check was run against. '
    + 'format: "sars_payload" (the default) returns the field codes; "csv" returns a spreadsheet of every box with its base, tax, implied tax at 15% and variance, and the VAT the boxes could not place. '
    + 'rateCheck is carried through: DO NOT FILE a return whose ties is false without reading the per-box variance first — that is the check SARS runs. '
    + 'If the period has been locked by lock_vat_period, the lock is returned, and driftSinceLock is non-null when the ledger no longer computes what was filed. That is evidence that something was posted into a filed period, not an updated return. '
    + 'LIMITS: it produces the payload; it does not submit anything to SARS and does not create a vat_returns record.',
  scope: 'read:vat',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
      format: { type: 'string', enum: ['sars_payload', 'csv'] },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const period = periodArgs(args);
    if (typeof period === 'string') return toolError(period);
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    const format = (strArg(args, 'format') ?? 'sars_payload') as Vat201ExportFormat;
    return ok(await exportVat201(ctx.companyId, period.start, period.end, format));
  },
};

export const lockVatPeriodTool: McpTool = {
  name: 'lock_vat_period',
  description:
    'Records that a VAT period has been filed and stops it being changed. Stores the return that was filed — output tax, input tax, net VAT — together with the posted_through those figures were computed at, so that a later disagreement between the filed return and the ledger can be told apart from an arithmetic error. '
    + 'WHY YOU NEED IT: nothing else stops a journal being posted into a period that has already been filed. One live ledger accepts a 2022 posting made today, and the return submitted for 2022 no longer agrees with the ledger it came from, with nothing recording that it ever did. '
    + 'RUN dry_run FIRST. The dry run runs every guard the live call runs — the period must not run backwards, must not already be locked, and its 15% check is reported — and writes nothing. '
    + 'It REFUSES to lock a period whose rateCheck.ties is false unless you pass force:true, because a return that fails SARS\'s own check is not one to freeze; fix it or record explicitly that you are filing it as it stands. '
    + 'IDEMPOTENT BY THE PERIOD ITSELF: locking a period that is already locked returns the EXISTING lock and does not overwrite its figures, so a retry can never rewrite what was filed. '
    + 'LIMITS: the lock is a record that posting paths read, not a database trigger. It does not unlock — that is deliberate; a lock you can lift with one call is not a control.',
  scope: 'read:vat',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
      notes: { type: 'string', description: 'Free text recorded with the lock, e.g. the eFiling reference.' },
      force: {
        type: 'boolean',
        description: 'Lock even though the 15% check fails. Records the decision; it does not make the return correct.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['period_start', 'period_end', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // ── PRE-WRITE VALIDATION. Everything that can return toolError is here,
    // before any service that can write has been called. After the write, a
    // failure must THROW so the savepoint rolls it back.
    const period = periodArgs(args);
    if (typeof period === 'string') return toolError(period);
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;

    const existing = await getVatPeriodLock(ctx.companyId, period.start, period.end);
    const report = await getVat201Report(ctx.companyId, period.start, period.end, { detail: 'summary' });

    if (!existing && report.rateCheck.ties === false && args.force !== true) {
      return toolError(
        `This period fails SARS's 15% check: box 1 is out by ${report.rateCheck.outputVariance} and box 15 by ${report.rateCheck.inputVariance}. `
        + 'Read vat_status detail="full" to find which journals, or pass force:true to lock it as it stands.',
      );
    }

    const figures = {
      outputTax: report.totals.outputTax,
      inputTax: report.totals.inputTax,
      netVat: report.totals.netVat,
      postedThrough: report.postedThrough,
    };

    if (args.dry_run === true) {
      return {
        ...ok({
          dryRun: true,
          wouldLock: !existing,
          alreadyLocked: existing,
          figures,
          rateCheck: report.rateCheck,
          excludedRows: report.excludedRows,
        }),
        // Without this the preview is stored under the idempotency key and the
        // real call that follows is served it forever.
        wroteNothing: true,
      };
    }

    const actor = actorForMcp(ctx, 'mcp:lock_vat_period:v1');
    const result = await lockVatPeriod(
      ctx.companyId, period.start, period.end, figures,
      { userId: actor.userId, actorType: actor.actorType, tokenJti: actor.tokenJti },
      strArg(args, 'notes'),
    );

    return {
      ...ok({ locked: result.lock, created: result.created, rateCheck: report.rateCheck }),
      // A lock that already existed wrote nothing, so it must not occupy the
      // key either — the same rule as a dry run.
      ...(result.created ? {} : { wroteNothing: true }),
    };
  },
};
