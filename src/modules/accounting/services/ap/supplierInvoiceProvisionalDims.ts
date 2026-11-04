/**
 * A slip bill's lines inherit the bank-first provisional's dimensions (R-127) when they are WRITTEN as a draft
 * (budgets P5-2b; Hein's ruling on breaker PROBE 3, moved to draft time by the coordinator's ruling on breaker
 * round 2, 2026-11-04).
 *
 * The provisional already expensed the slip on its own account and slice (say opex · FT); approving the bill posts
 * the bill's expense and reclasses the provisional's lines away. A bill line with no CC1 / CC2 / BU would post the
 * expense on the unassigned slice while the reclass credited FT. So a draft line that names no dimension (and no
 * legacy pick) takes the provisional's, BEFORE any approval request can bind the draft's digest (migration 873 hashes
 * the lines' cc1/cc2/bu): approve, Post to GL, the budget preview and the MCP dry run read the stored lines only and
 * write nothing (writing at approve broke R-035's backstop, breaker test A).
 *
 * Writers that apply it (the only ones that write lines of a bill tied to a slip): the capture line plan
 * (`capture/captureBillLines`, capture post + AI pipeline; the provisional the attach will link, read before the
 * lines are written) and MCP `update_supplier_invoice` (`supplierInvoiceDraftUpdateGuards.planLines`; the standing
 * provisional behind the bill's slip). Precedence for a blank line: the provisional's dimensions, then the
 * supplier's defaults.
 *
 * Matching, per account, failing closed (breaker C/D): every positive provisional line on the account carries the
 * SAME dimensions AND the account's blank lines sum to the provisional lines' sum (±1 cent) → every blank line
 * inherits them; otherwise a blank line inherits only from the ONE provisional line whose amount equals its posted
 * net (±1 cent), and only when no other blank line would take that same provisional line (round 4); otherwise
 * nothing. Validated (breaker B): the dimensions must be this company's active masters and
 * CC1 derivation over them must agree and add nothing; otherwise nothing is inherited.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { deriveLineDimensions } from '../gl/dimensions/dimensionDerivation';
import { DimensionRefusal, type DimensionIds } from '../gl/dimensions/dimensionTypes';
import { expenseLineNets } from './supplierInvoiceExpenseLines';

/** A provisional journal line: its account, dimensions and net (debit − credit). */
export interface ProvisionalDimLine {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  net: number;
}

/** A draft line as the matcher sees it: the account it posts to, its posted net, and whether it names nothing. */
export interface InheritLine { account: string | null; net: number; blank: boolean }

export type Dims = { cc1Id: string | null; cc2Id: string | null; buId: string | null };

const cents = (n: number): number => Math.round(n * 100);
const low = (v: string | null | undefined): string | null => (v ? v.toLowerCase() : null);
const dimsKey = (d: Dims): string => `${low(d.cc1Id) ?? ''}|${low(d.cc2Id) ?? ''}|${low(d.buId) ?? ''}`;
const hasAny = (d: Dims): boolean => Boolean(d.cc1Id || d.cc2Id || d.buId);

/** Pure: per line, the dimensions it would inherit (null: none). See the header for the rule. */
export function matchProvisionalDimensions(lines: readonly InheritLine[], provisional: readonly ProvisionalDimLine[]): Array<Dims | null> {
  const out: Array<Dims | null> = lines.map(() => null);
  const accounts = new Set(lines.filter((l) => l.blank && l.account).map((l) => low(l.account)!));
  for (const account of accounts) {
    const blanks = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.blank && low(l.account) === account);
    const cands = provisional.filter((p) => low(p.glAccountId) === account && cents(p.net) > 0);
    if (cands.length === 0) continue;
    const allSame = cands.every((c) => dimsKey(c) === dimsKey(cands[0]!));
    const blankSum = blanks.reduce((s, { l }) => s + cents(l.net), 0);
    const candSum = cands.reduce((s, c) => s + cents(c.net), 0);
    if (allSame && Math.abs(blankSum - candSum) <= 1) {
      const d = cands[0]!;
      if (hasAny(d)) for (const { i } of blanks) out[i] = { cc1Id: d.cc1Id, cc2Id: d.cc2Id, buId: d.buId };
      continue;
    }
    // Each blank line's unique candidate of its own amount; a candidate two lines would both take goes to neither.
    const hits = blanks.map(({ l, i }) => {
      const hit = cands.filter((c) => Math.abs(cents(c.net) - cents(l.net)) <= 1);
      return { i, c: hit.length === 1 ? hit[0]! : null };
    });
    for (const { i, c } of hits) {
      if (c && hasAny(c) && hits.filter((h) => h.c === c).length === 1) out[i] = { cc1Id: c.cc1Id, cc2Id: c.cc2Id, buId: c.buId };
    }
  }
  return out;
}

/** The dimension sets that may be inherited: active masters of the company, and CC1 derivation agrees and adds nothing. */
async function inheritable(companyId: string, sets: readonly Dims[]): Promise<Set<string>> {
  const centres = [...new Set(sets.flatMap((d) => [d.cc1Id, d.cc2Id]).filter((v): v is string => v !== null))];
  const units = [...new Set(sets.map((d) => d.buId).filter((v): v is string => v !== null))];
  const active = new Set<string>();
  if (centres.length > 0) {
    for (const r of (await sql`SELECT id::TEXT AS id FROM cost_centres WHERE company_id = ${companyId}::UUID AND is_active
                                 AND id = ANY(${centres}::UUID[])`) as DbRow[]) active.add(String(r.id).toLowerCase());
  }
  if (units.length > 0) {
    for (const r of (await sql`SELECT id::TEXT AS id FROM business_units WHERE company_id = ${companyId}::UUID AND is_active
                                 AND id = ANY(${units}::UUID[])`) as DbRow[]) active.add(String(r.id).toLowerCase());
  }
  const ok = new Set<string>();
  for (const d of sets) {
    const ids = [d.cc1Id, d.cc2Id, d.buId].filter((v): v is string => v !== null);
    if (!ids.every((v) => active.has(v.toLowerCase()))) continue;
    const asLine: DimensionIds = { ...(d.cc1Id ? { cc1Id: d.cc1Id } : {}), ...(d.cc2Id ? { cc2Id: d.cc2Id } : {}), ...(d.buId ? { buId: d.buId } : {}) };
    try {
      const [derived] = await deriveLineDimensions(companyId, [asLine]);
      const same = dimsKey({ cc1Id: derived?.cc1Id ?? null, cc2Id: derived?.cc2Id ?? null, buId: derived?.buId ?? null }) === dimsKey(d);
      if (same) ok.add(dimsKey(d));
    } catch (err) {
      if (!(err instanceof DimensionRefusal)) throw err;
    }
  }
  return ok;
}

/** A draft line the writers hand over (capture plan, MCP update plan). */
type DraftLine = DimensionIds & { glAccountId?: string | null; lineTotal: number; costCenterId?: string | null };

/**
 * The draft lines with the provisional's dimensions on the blank ones that match (validated), and which took them.
 * `defaultExpenseId`: the account a line with none posts to (null: such a line matches nothing). `eligible`: only these
 * lines may inherit (a capture re-plan, `capture/captureSlipReplan`); all lines when absent.
 */
export async function inheritSlipDimensions<T extends DraftLine>(
  companyId: string, lines: readonly T[], header: { subtotal: number; totalAmount: number; taxRate: number },
  provisional: readonly ProvisionalDimLine[], defaultExpenseId: string | null, eligible?: readonly boolean[],
): Promise<{ lines: T[]; inherited: boolean[] }> {
  const none = { lines: [...lines], inherited: lines.map(() => false) };
  if (provisional.length === 0 || lines.length === 0) return none;
  // Each line's posted net exactly as `buildExpenseLines` allocates it (rounded, residual on the last line), in the
  // order the caller hands the lines over: the posting order (`SUPPLIER_INVOICE_LINE_ORDER_BY`) for a stored bill.
  const nets = expenseLineNets(lines, header);
  const matched = matchProvisionalDimensions(lines.map((l, i) => ({
    account: l.glAccountId || defaultExpenseId, net: nets[i] ?? 0,
    blank: (eligible ? eligible[i] === true : true) && !l.cc1Id && !l.cc2Id && !l.buId && !l.costCenterId,
  })), provisional);
  const sets = [...new Map(matched.filter((d): d is Dims => d !== null).map((d) => [dimsKey(d), d])).values()];
  if (sets.length === 0) return none;
  const ok = await inheritable(companyId, sets);
  const inherited = matched.map((d) => d !== null && ok.has(dimsKey(d)));
  return {
    inherited,
    lines: lines.map((l, i) => {
      const d = matched[i];
      if (!inherited[i] || !d) return l;
      return { ...l, ...(d.cc1Id ? { cc1Id: d.cc1Id } : {}), ...(d.cc2Id ? { cc2Id: d.cc2Id } : {}), ...(d.buId ? { buId: d.buId } : {}) };
    }),
  };
}

/** A provisional journal's lines, all but its bank line, as `ProvisionalDimLine`s (company-scoped). */
export async function provisionalDimLines(companyId: string, jeId: string, bankAccountId: string): Promise<ProvisionalDimLine[]> {
  const rows = (await sql`
    SELECT gl_account_id::TEXT AS gl_account_id, cc1_id::TEXT AS cc1_id, cc2_id::TEXT AS cc2_id, bu_id::TEXT AS bu_id,
           (debit - credit)::TEXT AS net
      FROM gl_journal_lines
     WHERE journal_entry_id = ${jeId}::UUID AND company_id = ${companyId}::UUID AND gl_account_id <> ${bankAccountId}::UUID
  `) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), cc1Id: r.cc1_id ? String(r.cc1_id) : null, cc2Id: r.cc2_id ? String(r.cc2_id) : null,
    buId: r.bu_id ? String(r.bu_id) : null, net: Number(r.net),
  }));
}
