/**
 * The journal `lines` argument and its pre-write checks, shared by create_draft_journal and
 * create_recurring_journal so a template is held to exactly the rules a draft journal is.
 *
 * Every check here is a READ: account ownership, dimension resolution and the VAT-code funnel. A refusal is
 * returned as text for the tool to answer with, before anything is written.
 */
import type { McpToolContext } from '../types';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { JournalLineInput, VatType } from '@/modules/accounting/types/gl.types';
import type { DimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { resolveLineVatCode } from './allocationVatGuard';
import { guardUuidList } from './toolHelpers';
import { DIMENSION_LINE_PROPERTIES, dimensionWarningsOrRefusal, itemsWithDimensions, parseDimensionRefs } from './dimensionArgs';

/**
 * The VAT treatments a manual line may carry — the same set an allocation
 * stamps on its lines (gl.types VatType). Without one, a manual line on a VAT
 * control account is an "uncoded GL VAT line" and BLOCKS the VAT201, so a
 * correcting journal that mirrors an allocation (e.g. moving a reversal into
 * the period it corrects) could never be filed. Opt-in per line: omitted, the
 * line stays uncoded exactly as before.
 */
export const JOURNAL_LINE_VAT_TYPES: readonly VatType[] = [
  'standard', 'zero_rated', 'exempt', 'capital_goods', 'export', 'imported', 'reverse_charge', 'bad_debt',
];

/** Schema of one journal line. */
export const JOURNAL_LINE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    account_id: { type: 'string', description: 'GL account UUID' },
    debit: { type: 'number', minimum: 0 },
    credit: { type: 'number', minimum: 0 },
    description: { type: 'string' },
    vat_type: {
      type: 'string',
      enum: [...JOURNAL_LINE_VAT_TYPES],
      description:
        'VAT treatment of this line, as an allocation would stamp it. Set it on a VAT Input/'
        + 'Output line AND on the base line it belongs to; a VAT-account line without it is '
        + 'reported by vat_exceptions as uncoded and blocks the VAT201. Omit for non-VAT lines.',
    },
    ...DIMENSION_LINE_PROPERTIES,
  },
  required: ['account_id'],
  additionalProperties: false,
} as const;

function parseLines(raw: unknown): { lines: JournalLineInput[]; dims: (DimensionRefs | undefined)[] } | string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: JournalLineInput[] = [];
  const dims: (DimensionRefs | undefined)[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const glAccountId = typeof o.account_id === 'string' ? o.account_id : '';
    const debit = Number(o.debit ?? 0);
    const credit = Number(o.credit ?? 0);
    if (!glAccountId || !Number.isFinite(debit) || !Number.isFinite(credit)) return null;
    let vatType: VatType | undefined;
    if (o.vat_type !== undefined && o.vat_type !== null) {
      if (typeof o.vat_type !== 'string' || !(JOURNAL_LINE_VAT_TYPES as readonly string[]).includes(o.vat_type)) {
        return `lines[${i}].vat_type must be one of: ${JOURNAL_LINE_VAT_TYPES.join(', ')}`;
      }
      vatType = o.vat_type as VatType;
    }
    const lineDims = parseDimensionRefs(o, `lines[${i}]`);
    if (typeof lineDims === 'string') return lineDims;
    dims.push(lineDims);
    lines.push({
      glAccountId,
      debit,
      credit,
      description: typeof o.description === 'string' ? o.description : undefined,
      ...(vatType ? { vatType } : {}),
    });
  }
  return { lines, dims };
}

/**
 * Parse and check `lines`: shape, account ids that are UUIDs and this company's accounts, cc1/cc2/bu resolved (CC1
 * derived from CC2, conflicts refused), the company's cost-of-sales project rule, and every coded line through the
 * s17(2)(a) / non-supply funnel. Returns the lines with their dimension ids and any warnings, or the refusal text.
 */
export async function checkJournalLines(
  ctx: McpToolContext, raw: unknown, toolName: string,
): Promise<{ lines: JournalLineInput[]; warnings: string[] } | string> {
  const parsedLines = parseLines(raw);
  if (typeof parsedLines === 'string') return parsedLines;
  if (!parsedLines) return 'lines must be a non-empty array of {account_id, debit, credit}';
  const { dims } = parsedLines;
  let { lines } = parsedLines;
  // accountsBelongToCompany casts every one of these to ::UUID, so a typo
  // there fails the ownership check itself rather than the posting.
  const badLine = guardUuidList(lines.map((l) => l.glAccountId), (i) => `lines[${i}].account_id`);
  if (badLine) return badLine.content[0]!.text;
  // Ownership: every line's GL account must belong to the token's company —
  // a foreign account_id would book cross-company (and silently unbalance
  // this company's own trial balance via the RLS-hidden joined row).
  if (!(await accountsBelongToCompany(ctx.companyId, lines.map((l) => l.glAccountId)))) {
    return 'One or more account_id values are not GL accounts in your company.';
  }
  // cc1/cc2/bu per line: resolved, CC1 derived from CC2, conflicts refused — pre-write.
  const withDims = await itemsWithDimensions(ctx.companyId, lines, dims, (i) => `lines[${i}]`);
  if (typeof withDims === 'string') return withDims;
  lines = withDims;
  const cos = await dimensionWarningsOrRefusal(ctx.companyId, lines, (i) => `lines[${i}]`);
  if (typeof cos === 'string') return cos;
  // A coded line is a VAT claim the agent is asserting, unattended: run it
  // through the same s17(2)(a) / non-supply / bank-transfer funnel every MCP
  // allocation goes through. REFUSE rather than coerce — the journal carries
  // its VAT amount on an explicit line, so silently relabelling the code
  // would leave that amount describing a claim the code now denies.
  for (const [i, line] of lines.entries()) {
    if (!line.vatType) continue;
    const guarded = await resolveLineVatCode(
      ctx.companyId, '', { allocType: 'account', contraAccountId: line.glAccountId, vatCode: line.vatType },
      toolName,
    );
    if (guarded.vatCoerced) {
      return `lines[${i}].vat_type ${line.vatType} is not claimable on that account `
        + `(${guarded.vatCoerced.reason}) — use no vat_type, or book it to a supply account.`;
    }
  }
  return { lines, warnings: cos.warnings };
}
