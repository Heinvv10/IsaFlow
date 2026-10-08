/**
 * Master-data defaults the derivation reads (brief §5.4, §6):
 *
 *   - a customer's FNO (customers.default_cc1_id) — FNO on every revenue line;
 *   - a bank / card account's default CC1 / CC2 / BU (gl_accounts.default_*) —
 *     card spend takes its cost centre and BU from the card;
 *   - a GL account's reporting ladder (report_category, statement_line,
 *     statement_group, report_class, cash_class, capex_opex) — attributes of the
 *     account, so they are derived on every line and never typed.
 *
 * None of these moves an amount. Each setter is a plan (reads, every refusal)
 * and an apply (writes, refuses nothing).
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { isBankSubtype } from '../accountSubtypes';
import { resolveDimensionRefs } from './dimensionRefResolver';
import { deriveLineDimensions } from './dimensionDerivation';
import { DimensionRefusal, type DimensionIds, type DimensionRefs } from './dimensionTypes';

export const REPORTING_ATTRIBUTES = [
  'report_category', 'statement_line', 'statement_group', 'report_class', 'cash_class', 'capex_opex',
] as const;
export type ReportingAttribute = (typeof REPORTING_ATTRIBUTES)[number];

/** Present key = set (null clears); absent key = leave unchanged. */
export type ReportingAttributePatch = Partial<Record<ReportingAttribute, string | null>>;

interface AccountRow { id: string; account_code: string; account_subtype: string | null }

async function accountsByRef(companyId: string, refs: readonly string[]): Promise<AccountRow[]> {
  const ids = refs.filter((r) => UUID_RE.test(r));
  const codes = refs.filter((r) => !UUID_RE.test(r));
  if (refs.length === 0) return [];
  return (await sql`
    SELECT id::TEXT AS id, account_code, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND (id = ANY(${ids}::UUID[]) OR account_code = ANY(${codes}::TEXT[]))
  `) as AccountRow[];
}

function pickAccount(rows: readonly AccountRow[], ref: string): AccountRow | null {
  const hits = UUID_RE.test(ref)
    ? rows.filter((r) => r.id.toLowerCase() === ref.toLowerCase())
    : rows.filter((r) => r.account_code === ref);
  return hits.length === 1 ? hits[0]! : null;
}

// ── Customer FNO ────────────────────────────────────────────────────────────

export async function planCustomerDefaultFno(
  companyId: string, customerId: string, fnoRef: string | null,
): Promise<{ customerId: string; fnoId: string | null; previousFnoId: string | null }> {
  if (!UUID_RE.test(customerId)) throw new DimensionRefusal('customer_id must be a UUID');
  const rows = (await sql`
    SELECT id::TEXT AS id, default_cc1_id::TEXT AS fno FROM customers
    WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
  `) as { id: string; fno: string | null }[];
  if (rows.length === 0) throw new DimensionRefusal('Not found');
  const fnoId = fnoRef === null ? null
    : (await resolveDimensionRefs(companyId, [{ cc1: fnoRef }], () => 'fno'))[0]?.cc1Id ?? null;
  return { customerId, fnoId, previousFnoId: rows[0]!.fno };
}

export async function applyCustomerDefaultFno(
  companyId: string, plan: { customerId: string; fnoId: string | null },
): Promise<void> {
  await sql`
    UPDATE customers SET default_cc1_id = ${plan.fnoId}::UUID, updated_at = NOW()
    WHERE id = ${plan.customerId}::UUID AND company_id = ${companyId}::UUID
  `;
}

// ── Bank / card default dimensions ──────────────────────────────────────────

export interface BankDefaultsPlan { accountId: string; accountCode: string; next: DimensionIds; previous: DimensionIds }

/** `refs[kind] === null` clears that default; undefined leaves it unchanged. */
export async function planBankAccountDefaults(
  companyId: string, accountRef: string, refs: { [K in keyof DimensionRefs]?: string | null },
): Promise<BankDefaultsPlan> {
  const account = pickAccount(await accountsByRef(companyId, [accountRef]), accountRef);
  if (!account) throw new DimensionRefusal('Not found');
  if (!isBankSubtype(account.account_subtype)) {
    throw new DimensionRefusal(`${account.account_code} is not a bank or card account (subtype bank); defaults apply to card spend only`);
  }
  const [current] = (await sql`
    SELECT default_cc1_id::TEXT AS cc1, default_cc2_id::TEXT AS cc2, default_bu_id::TEXT AS bu
    FROM gl_accounts WHERE id = ${account.id}::UUID AND company_id = ${companyId}::UUID
  `) as { cc1: string | null; cc2: string | null; bu: string | null }[];
  const previous: DimensionIds = {
    ...(current?.cc1 ? { cc1Id: current.cc1 } : {}), ...(current?.cc2 ? { cc2Id: current.cc2 } : {}),
    ...(current?.bu ? { buId: current.bu } : {}),
  };
  const toResolve: DimensionRefs = {
    ...(refs.cc1 ? { cc1: refs.cc1 } : {}), ...(refs.cc2 ? { cc2: refs.cc2 } : {}), ...(refs.bu ? { bu: refs.bu } : {}),
  };
  const [resolved] = await resolveDimensionRefs(companyId, [toResolve], () => 'defaults');
  const pick = (kind: 'cc1' | 'cc2' | 'bu', key: keyof DimensionIds): string | undefined =>
    refs[kind] === null ? undefined : refs[kind] === undefined ? previous[key] : resolved?.[key];
  const next: DimensionIds = { cc1Id: pick('cc1', 'cc1Id'), cc2Id: pick('cc2', 'cc2Id'), buId: pick('bu', 'buId') };
  // A default CC1 that contradicts the default project's FNO would be refused on every allocation.
  await deriveLineDimensions(companyId, [next], () => 'defaults');
  return { accountId: account.id, accountCode: account.account_code, next, previous };
}

export async function applyBankAccountDefaults(companyId: string, plan: BankDefaultsPlan): Promise<void> {
  await sql`
    UPDATE gl_accounts SET default_cc1_id = ${plan.next.cc1Id ?? null}::UUID,
      default_cc2_id = ${plan.next.cc2Id ?? null}::UUID, default_bu_id = ${plan.next.buId ?? null}::UUID,
      updated_at = NOW()
    WHERE id = ${plan.accountId}::UUID AND company_id = ${companyId}::UUID
  `;
}

// ── GL account reporting ladder ─────────────────────────────────────────────

export interface ReportingAttributesItem { account: string; patch: ReportingAttributePatch }
export interface ReportingAttributesPlanRow { accountId: string; accountCode: string; patch: ReportingAttributePatch }

export const MAX_ATTRIBUTE_LENGTH = 120;

export async function planReportingAttributes(
  companyId: string, items: readonly ReportingAttributesItem[],
): Promise<ReportingAttributesPlanRow[]> {
  const refs = [...new Set(items.map((i) => i.account))];
  const rows = await accountsByRef(companyId, refs);
  const seen = new Set<string>();
  return items.map((item, i) => {
    const account = pickAccount(rows, item.account);
    if (!account) throw new DimensionRefusal(`items[${i}].account "${item.account}" is not a GL account in this company`);
    if (seen.has(account.id)) throw new DimensionRefusal(`items[${i}]: account ${account.account_code} is listed twice`);
    seen.add(account.id);
    for (const [key, value] of Object.entries(item.patch)) {
      if (value !== null && value !== undefined && value.length > MAX_ATTRIBUTE_LENGTH) {
        throw new DimensionRefusal(`items[${i}].${key} is over ${MAX_ATTRIBUTE_LENGTH} characters`);
      }
    }
    return { accountId: account.id, accountCode: account.account_code, patch: item.patch };
  });
}

export async function applyReportingAttributes(
  companyId: string, plan: readonly ReportingAttributesPlanRow[],
): Promise<void> {
  for (const row of plan) {
    const has = (k: ReportingAttribute): boolean => Object.prototype.hasOwnProperty.call(row.patch, k);
    const v = (k: ReportingAttribute): string | null => row.patch[k] ?? null;
    await sql`
      UPDATE gl_accounts SET
        report_category = CASE WHEN ${has('report_category')}::BOOLEAN THEN ${v('report_category')}::TEXT ELSE report_category END,
        statement_line  = CASE WHEN ${has('statement_line')}::BOOLEAN  THEN ${v('statement_line')}::TEXT  ELSE statement_line END,
        statement_group = CASE WHEN ${has('statement_group')}::BOOLEAN THEN ${v('statement_group')}::TEXT ELSE statement_group END,
        report_class    = CASE WHEN ${has('report_class')}::BOOLEAN    THEN ${v('report_class')}::TEXT    ELSE report_class END,
        cash_class      = CASE WHEN ${has('cash_class')}::BOOLEAN      THEN ${v('cash_class')}::TEXT      ELSE cash_class END,
        capex_opex      = CASE WHEN ${has('capex_opex')}::BOOLEAN      THEN ${v('capex_opex')}::TEXT      ELSE capex_opex END,
        updated_at = NOW()
      WHERE id = ${row.accountId}::UUID AND company_id = ${companyId}::UUID
    `;
  }
}
