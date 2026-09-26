/**
 * mark_vat_declared_elsewhere — mark or unmark issued customer invoices /
 * approved bills "VAT declared outside IsaFlow / historical import"
 * (migration 705, reports/vatDeclaredElsewhereService).
 *
 * REPLACES posting to the GL, which is unsafe for an imported document: it
 * may already carry its VAT in the GL under a different entry, or have
 * declared it under the old system, and posting now could double it. This
 * tool never posts a journal and never changes a VAT201 field — it only
 * moves the document(s) between vatUnpostedInvoices.ts's BLOCKING list and
 * the non-blocking "declared elsewhere" list.
 *
 * Owner/admin only. MCP carries no role on its context, so it is read fresh
 * from company_users (getCompanyRoleForUser, same pattern as lock_vat_period's
 * exceptions override) and the service enforces it again regardless.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, actorForMcp } from '../contracts';
import {
  markVatDeclaredElsewhereBulk, unmarkVatDeclaredElsewhere,
  VatDeclaredElsewhereForbiddenError, type VatDocKind,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';
import { getCompanyRoleForUser } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { guardUuidList, ok, strArg, toolError } from './toolHelpers';

function invoiceIdsArg(args: Record<string, unknown>): string[] | string {
  const raw = args.invoice_ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    return 'invoice_ids must be a non-empty array of at most 200 UUIDs';
  }
  if (!raw.every((v) => typeof v === 'string')) return 'invoice_ids must all be strings';
  return raw as string[];
}

export const markVatDeclaredElsewhereTool: McpTool = {
  name: 'mark_vat_declared_elsewhere',
  description:
    'Marks (or unmarks) issued customer invoices / approved bills "VAT declared outside IsaFlow / historical import" (migration 705). '
    + 'A marked document leaves vat_status/vat_reconciliation\'s BLOCKING unposted-invoice-VAT list and appears instead in a non-blocking "declared elsewhere" list — still visible, never hidden. '
    + 'NEVER posts to the GL and NEVER changes a VAT201 field — for that, use post_journal on the document\'s own entry. '
    + 'OWNER/ADMIN ONLY: refused for any other role, even with a reason. '
    + 'action: "mark" requires a reason; "unmark" restores the block and also requires a reason. '
    + 'RUN dry_run FIRST — it reports which ids exist in this company and are eligible, without writing anything.',
  scope: 'read:vat',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['mark', 'unmark'] },
      kind: { type: 'string', enum: ['customer', 'supplier'], description: 'customer invoice or supplier bill' },
      invoice_ids: { type: 'array', items: { type: 'string' }, description: 'Up to 200 invoice/bill ids, same company.' },
      reason: { type: 'string', description: 'Required for both mark and unmark.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['action', 'kind', 'invoice_ids', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const action = args.action === 'unmark' ? 'unmark' : args.action === 'mark' ? 'mark' : null;
    if (!action) return toolError('action must be "mark" or "unmark"');
    const kind = args.kind === 'supplier' ? 'supplier' : args.kind === 'customer' ? 'customer' : null;
    if (!kind) return toolError('kind must be "customer" or "supplier"');
    const invoiceIds = invoiceIdsArg(args);
    if (typeof invoiceIds === 'string') return toolError(invoiceIds);
    const bad = guardUuidList(invoiceIds, (i) => `invoice_ids[${i}]`);
    if (bad) return bad;
    const reason = strArg(args, 'reason');
    if (!reason) return toolError('reason is required');

    const actor = actorForMcp(ctx, `mcp:mark_vat_declared_elsewhere:v1`);

    if (args.dry_run === true) {
      return {
        ...ok({ dryRun: true, action, kind, wouldAffect: invoiceIds.length, invoiceIds }),
        wroteNothing: true,
      };
    }

    // The role check inside the service runs BEFORE any write, on every call,
    // deterministically for this actor — so a forbidden role always fails on
    // the FIRST id, before anything is written, and is safe to answer as a
    // toolError. A per-id refusal (not found / not currently marked) for a
    // LATER id in the batch can follow ids that already wrote successfully —
    // that failure MUST rethrow so the savepoint rolls back the whole batch,
    // per the write convention (only pre-write validation returns toolError).
    const role = (await getCompanyRoleForUser(ctx.companyId, actor.userId)) ?? '';
    try {
      if (action === 'mark') {
        const results = await markVatDeclaredElsewhereBulk(
          ctx.companyId, kind as VatDocKind, invoiceIds, { userId: actor.userId, role }, reason,
        );
        return ok({ action, results });
      }
      const results = [];
      for (const id of invoiceIds) {
        results.push(await unmarkVatDeclaredElsewhere(ctx.companyId, kind as VatDocKind, id, { userId: actor.userId, role }, reason));
      }
      return ok({ action, results });
    } catch (err) {
      if (err instanceof VatDeclaredElsewhereForbiddenError) return toolError(err.message);
      throw err;
    }
  },
};
