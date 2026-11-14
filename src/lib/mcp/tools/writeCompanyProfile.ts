/**
 * MCP write tool: update_company_profile — the company's VAT number, income tax number and SARS VAT category.
 *
 * The same write as Settings > Company (companyService.updateCompany via companyVatProfileService), on the TOKEN's
 * company only: no company id is read from the arguments. Owner or admin only, checked before anything else.
 * A category/alignment change moves VAT period boundaries, so it is refused when VAT returns, period locks or VAT201
 * versions exist unless acknowledge_period_change is true; the dry run runs the same refusals and the same write
 * (rolled back) and reports which periods would move.
 *
 * Every refusal is returned BEFORE the write; the write itself and anything after it throw (registry savepoint).
 */
import type { McpTool, McpToolResult } from '../types';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { WITH_ROLE_ADMITS } from '@/lib/auth/withRole';
import { changeCompanyVatProfile } from '@/modules/accounting/services/core/companyVatProfileService';
import { parseProfileArgs } from './companyProfileArgs';
import { nulArgError, ok, toolError } from './toolHelpers';

const NAME = 'update_company_profile';

function wroteNothing(data: Record<string, unknown>): McpToolResult {
  const res = ok(data);
  res.wroteNothing = true;
  res.billable = false;
  return res;
}

export const updateCompanyProfileTool: McpTool = {
  name: NAME,
  description:
    "Change the connected company's VAT number, income tax number and/or SARS VAT category, as Settings > Company does. "
    + 'vat_number: 10 digits starting with 4. income_tax_number: 10 digits starting with 0, 1, 2, 3 or 9. '
    + 'vat_category: A (bi-monthly, periods end Jan/Mar/May/Jul/Sep/Nov), B (bi-monthly, end Feb/Apr/Jun/Aug/Oct/Dec) or C (monthly); '
    + 'D and E are not supported. vat_alignment (odd = A, even = B) moves a bi-monthly company between A and B and must agree with a '
    + 'vat_category sent with it. A company that is not VAT registered takes no VAT number or category (register it in Settings first). '
    + 'A value cannot be cleared here. Owner or admin only; acts on the company your token is bound to. '
    + 'CHANGING THE CATEGORY MOVES VAT PERIOD BOUNDARIES: if the company already has VAT returns, VAT period locks (even unlocked ones) '
    + 'or VAT201 versions or a submitted legacy VAT201, the call is refused until you send acknowledge_period_change: true — filed periods are not re-cut and cannot be '
    + 'restored by changing the category back. dry_run is required: true runs every check and the write and rolls it back, returning '
    + 'before/after, the current and next VAT periods under the old and new cycle (period_impact) and the returns on file; false changes it. '
    + 'The reply carries before and after and undo_arguments (the before value of each changed field; calling again with them puts it back) '
    + 'and undo_limitations: a number that was EMPTY before cannot be emptied again, so it has no undo entry. A real change writes an audit_log row.',
  scope: 'read:vat',
  requiresScope: 'write:company',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      vat_number: { type: 'string', description: 'South African VAT number: 10 digits starting with 4.' },
      income_tax_number: { type: 'string', description: 'SARS income tax reference: 10 digits starting with 0, 1, 2, 3 or 9.' },
      vat_category: { type: 'string', enum: ['A', 'B', 'C'], description: 'A: bi-monthly (odd end months), B: bi-monthly (even end months), C: monthly.' },
      vat_alignment: { type: 'string', enum: ['odd', 'even'], description: 'Bi-monthly period end months: odd = category A, even = category B.' },
      acknowledge_period_change: {
        type: 'boolean',
        description: 'Required to move the VAT period boundaries when VAT returns, locks or VAT201 versions already exist.',
      },
      dry_run: MUTATION_ARG_SCHEMA.dry_run,
      idempotency_key: MUTATION_ARG_SCHEMA.idempotency_key,
    },
    required: ['dry_run', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!(WITH_ROLE_ADMITS.admin as readonly string[]).includes(ctx.companyRole ?? '')) {
      return toolError(`Only an owner or admin can change the company profile (your role: ${ctx.companyRole ?? 'unknown'}).`);
    }
    const nul = nulArgError(args);
    if (nul) return nul;
    const parsed = parseProfileArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);

    const outcome = await changeCompanyVatProfile(ctx.companyId, parsed.request, {
      dryRun: parsed.dryRun, acknowledgePeriodChange: parsed.acknowledgePeriodChange, asOf: new Date(),
      userId: ctx.userId, tokenJti: ctx.tokenJti,
    });
    if ('refused' in outcome) return toolError(outcome.refused);

    const periodsMoved = outcome.periodImpact?.changes_periods === true;
    const undo: Record<string, unknown> = { ...outcome.undoArguments };
    if (periodsMoved && outcome.footprint.total > 0) undo.acknowledge_period_change = true;
    const warnings: string[] = [];
    if (periodsMoved && outcome.footprint.total > 0) {
      warnings.push('The VAT period boundaries moved while returns, locks or VAT201 versions exist on the old boundaries; they are not re-cut.');
    }
    const data = {
      dry_run: parsed.dryRun,
      before: outcome.before,
      after: outcome.after,
      changed: outcome.changed,
      ...(outcome.nothingChanged ? { nothing_changed: true } : {}),
      period_impact: outcome.periodImpact,
      vat_filing_records: outcome.footprint,
      undo_arguments: undo,
      undo_limitations: outcome.undoLimitations,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    if (parsed.dryRun) return wroteNothing(data);
    return outcome.nothingChanged ? wroteNothing(data) : ok(data);
  },
};
