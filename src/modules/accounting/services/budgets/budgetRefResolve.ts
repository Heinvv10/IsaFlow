/**
 * Accounts and dimension members named by id OR code, for callers that write budget cells from text
 * (the MCP budget tools). Codes are matched by the Excel import's own rule (`codeIndex.ts`, which budgetImportResolve uses:
 * exact first, then trimmed when that names one item alone) over the SAME read model the import
 * resolves against, so an agent and a spreadsheet find the same account for the same code.
 *
 * Never guessed: an unknown, ambiguous, header (without its own amounts in the version), inactive (without
 * amounts) or non-income-statement account is a refusal with a reason, per reference. The read model lists
 * only what may be budgeted (active leaf revenue/expense accounts, plus any account holding amounts), so a
 * reference the model lacks is explained by one company-scoped read of the chart (`explainMissingAccounts`).
 * A budget holder's model lists only their accounts: an otherwise budgetable account outside it is
 * "outside your budget slices".
 */
import { sql, type DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { codeIndex, type Find } from './codeIndex';
import type { GridAccount, GridMember, GridReadModel } from './gridReadTypes';

export type DimensionKind = 'cc1' | 'cc2' | 'bu';

export type RefResult<T> = { ok: true; item: T } | { ok: false; reason: string };

const DIM_LABEL: Record<DimensionKind, string> = { cc1: 'CC1 cost centre', cc2: 'CC2 cost centre', bu: 'business unit' };

const clip = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

export interface RefResolver {
  /** The account a cell names (decision 18: a header only when it holds its own amounts in the version); null = not in the model. */
  account(ref: string): RefResult<GridAccount> | null;
  member(kind: DimensionKind, ref: string): RefResult<GridMember>;
}

/**
 * Resolves against `model` (one version's grid as the caller sees it). `account` answers null for a
 * reference the model does not list: the caller collects those and asks `explainMissingAccounts`.
 */
export function refResolver(model: GridReadModel): RefResolver {
  const byCode = codeIndex(model.accounts);
  const byId = new Map(model.accounts.map((a) => [a.id, a]));
  const members: Record<DimensionKind, { byCode: Find<GridMember>; byId: Map<string, GridMember> }> = {
    cc1: { byCode: codeIndex(model.dimensions.cc1), byId: new Map(model.dimensions.cc1.map((m) => [m.id, m])) },
    cc2: { byCode: codeIndex(model.dimensions.cc2), byId: new Map(model.dimensions.cc2.map((m) => [m.id, m])) },
    bu: { byCode: codeIndex(model.dimensions.bu), byId: new Map(model.dimensions.bu.map((m) => [m.id, m])) },
  };
  return {
    account(ref) {
      const found = UUID_RE.test(ref) ? byId.get(ref.toLowerCase()) : byCode(ref);
      if (found === null) return { ok: false, reason: `Account code ${clip(ref)} matches more than one account; fix the chart of accounts first, or name the account by id` };
      if (found === undefined) return null;
      if (found.isHeader && !found.ownAmounts) {
        return { ok: false, reason: `${found.code} ${found.name} is a header account: budget its sub-accounts instead (a header shows their sum)` };
      }
      return { ok: true, item: found };
    },
    member(kind, ref) {
      const index = members[kind];
      const found = UUID_RE.test(ref) ? index.byId.get(ref.toLowerCase()) : index.byCode(ref);
      if (found === null) return { ok: false, reason: `${DIM_LABEL[kind]} code ${clip(ref)} matches more than one ${DIM_LABEL[kind]}` };
      if (found === undefined) return { ok: false, reason: `${clip(ref)} is not one of this company's active ${DIM_LABEL[kind]}s` };
      return { ok: true, item: found };
    },
  };
}

/**
 * Why each reference the model does not list cannot be budgeted: unknown, ambiguous, not a revenue or
 * expense account, inactive without amounts, a header, or (an active leaf the model left out) outside the
 * caller's budget slices. One read of the company's chart for all of them.
 */
export async function explainMissingAccounts(companyId: string, refs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  const ids = refs.filter((r) => UUID_RE.test(r)).map((r) => r.toLowerCase());
  const codes = refs.filter((r) => !UUID_RE.test(r));
  const rows = (await sql`
    SELECT ga.id::text AS id, ga.account_code, ga.account_name, ga.account_type, ga.is_active,
           EXISTS (SELECT 1 FROM gl_accounts c WHERE c.company_id = ga.company_id AND c.parent_account_id = ga.id) AS is_header
      FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID
       AND (ga.id = ANY(${ids}::UUID[]) OR ga.account_code = ANY(${codes}::TEXT[]) OR btrim(ga.account_code) = ANY(${codes.map((c) => c.trim())}::TEXT[]))
  `) as DbRow[];
  for (const ref of refs) {
    const isId = UUID_RE.test(ref);
    const hits = rows.filter((r) => (isId ? String(r.id) === ref.toLowerCase() : String(r.account_code) === ref || String(r.account_code).trim() === ref.trim()));
    const exact = isId ? hits : hits.filter((r) => String(r.account_code) === ref);
    const pick = exact.length > 0 ? exact : hits;
    if (pick.length === 0) { out.set(ref, `${clip(ref)} is not an account of this company`); continue; }
    if (pick.length > 1) { out.set(ref, `Account code ${clip(ref)} matches more than one account; name the account by id`); continue; }
    const a = pick[0]!;
    const label = `${String(a.account_code)} ${String(a.account_name)}`.trim();
    if (a.account_type !== 'revenue' && a.account_type !== 'expense') {
      out.set(ref, `${label} is not a revenue or expense account; budgets are set on income statement accounts only`);
    } else if (a.is_header) {
      out.set(ref, `${label} is a header account: budget its sub-accounts instead`);
    } else if (a.is_active === false) {
      out.set(ref, `${label} is inactive with no budget in this version; a new budget there is refused`);
    } else {
      out.set(ref, `${label} is outside your budget slices`);
    }
  }
  return out;
}
