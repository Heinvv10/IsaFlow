/**
 * vat_exceptions — VAT-gaps batch item 3. Read-only wrap of
 * `reports/vatExceptionsService.getVatExceptions`: every pre-filing exception
 * type, marked blocking or non-blocking, with its count and its items
 * (journal ids/numbers, invoice numbers, amounts) — the same figures
 * `lock_vat_period` and eFiling's `evaluateEfilingGate` refuse on, and the
 * ones `vatGateOverrideService` lets an owner/admin override for a lock or a
 * manual mark-submitted (never for ISV filing, which has no override).
 *
 * Also carries the override HISTORY for the period (vat_gate_overrides,
 * `listVatGateOverrides`) and the declared-elsewhere list — both already part
 * of the same picture an operator reviews before locking or filing.
 */
import type { McpTool } from '../types';
import { buildEnvelope, figureBasis } from '../contracts';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { listVatGateOverrides } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

interface ExceptionCategory {
  type: string;
  blocking: boolean;
  count: number;
  items: unknown[];
}

export const vatExceptionsTool: McpTool = {
  name: 'vat_exceptions',
  description:
    'The pre-filing VAT exceptions for a period — every type, each marked blocking or non-blocking, with its count and its items (journal ids/numbers, invoice numbers, amounts). '
    + 'BLOCKING types (refuse lock_vat_period and manual mark-submitted unless an owner/admin overrides with a reason; ALWAYS refuse SARS ISV filing, no override): uncodedGlLines, invoiceTaxCodeIssues, invoiceGlMismatches, vatOnBalanceSheetLines, vatNonSupplyLines, controlRecon (its own reconExceptions, from output/input variance), unpostedInvoiceVat, and unsupportedInputVat (input VAT that DISAGREES with what supports it — amount_mismatch or document_over_claimed, the return\'s figures would be wrong — or document_unlinked, Hein 2026-09-26: a document WAS linked, evidencing the claim, and no longer is, with nothing else supporting it). '
    + 'NON-BLOCKING (informational — visible, never hidden): declaredElsewhereVat (marked "VAT declared outside IsaFlow", mark_vat_declared_elsewhere) and inputVatWithoutTaxInvoice — a claim supported only by a bank line or a VAT adjustment ("no tax invoice on file"), or with no document link at all or an unreadable document VAT (Hein, 2026-09-26 — a RECORD is missing, not a wrong figure; holding the tax invoice is the vendor\'s legal responsibility and it may live outside IsaFlow, so these no longer block). '
    + 'totalExceptions is the SAME number lock_vat_period and eFiling check. '
    + 'overrideHistory lists every recorded override for this exact period (vat_gate_overrides), newest first — who overrode what, when, and the exception counts at the time. '
    + 'controlRecon ties the FILED ledger VAT201 (fields 5/10) to the GL VAT control account movement; its own output/input variance is what reconExceptions counts. '
    + 'degradedData true means a source query failed and every total here is UNDER-counted — do not treat this as clean.',
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
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    if (start > end) return toolError('period_start must not be after period_end');

    const [report, overrideHistory] = await Promise.all([
      getVatExceptions(ctx.companyId, start, end),
      listVatGateOverrides(ctx.companyId, start, end),
    ]);

    const categories: ExceptionCategory[] = [
      { type: 'uncodedGlLines', blocking: true, count: report.uncodedGlLineCount, items: report.uncodedGlLines },
      { type: 'invoiceTaxCodeIssues', blocking: true, count: report.invoiceTaxCodeIssueCount, items: report.invoiceTaxCodeIssues },
      { type: 'invoiceGlMismatches', blocking: true, count: report.invoiceGlMismatchCount, items: report.invoiceGlMismatches },
      { type: 'vatOnBalanceSheetLines', blocking: true, count: report.vatOnBalanceSheetCount, items: report.vatOnBalanceSheetLines },
      { type: 'vatNonSupplyLines', blocking: true, count: report.vatNonSupplyCount, items: report.vatNonSupplyLines },
      { type: 'unpostedInvoiceVat', blocking: true, count: report.unpostedInvoiceVatCount, items: report.unpostedInvoiceVat },
      { type: 'unsupportedInputVat', blocking: true, count: report.unsupportedInputVatCount, items: report.unsupportedInputVat },
      { type: 'declaredElsewhereVat', blocking: false, count: report.declaredElsewhereVatCount, items: report.declaredElsewhereVat },
      // Also carries no_document / unreadable_document_vat rows (Hein,
      // 2026-09-26): a missing record, not a wrong figure.
      { type: 'inputVatWithoutTaxInvoice', blocking: false, count: report.inputVatWithoutTaxInvoiceCount, items: report.inputVatWithoutTaxInvoice },
    ];

    return ok({
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      totalExceptions: report.totalExceptions,
      categories,
      controlRecon: report.controlRecon,
      overrideHistory,
      degradedData: report.degradedData,
      degradedSources: report.degradedSources,
      ...buildEnvelope({
        rows: categories,
        rowsTotal: categories.length,
        excludedRows: [],
        detail: 'standard',
        as_at: report.periodEnd,
        posted_through: report.periodEnd,
        figureBasis: figureBasis('vat.output.v1'),
      }),
    });
  },
};
