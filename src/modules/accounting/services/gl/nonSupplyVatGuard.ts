/**
 * Posting-time guard: no VAT on an account where no supply can arise.
 *
 * WHY IT EXISTS, AND WHY A REPORT WAS NOT ENOUGH
 * ----------------------------------------------
 * Velocity Fibre `49784360 Salaries & Wages` was allocated VAT-exclusive 29
 * times through the bank screen — every salary payment split 15% to VAT Input,
 * R400 388,14 of input tax on something that is not a supply. That was found
 * by `reports/vatNonSupplyExceptions`, which reports after the fact.
 *
 * Then the ledger was rebuilt on 2026-09-05 and it happened AGAIN: 34 posted
 * lines, R1 580 144,13 of salary, **R237 021,60** of manufactured input tax,
 * written the same day, same `auto_bank_recon` source. A detector that reports
 * a defect a re-import faithfully recreates is not a control. This is.
 *
 * THE SHAPE, AND WHY IT MIRRORS inputVatDenial
 * ---------------------------------------------
 * Deliberately the same two-function split as `inputVatDenial.ts`, for a
 * DIFFERENT reason — read both before merging them.
 *
 * There, the attended path only warns because s17(2)(a)(i) genuinely lets some
 * vendors claim entertainment input tax and only the user knows whether that is
 * them. Here there is no such proviso: a salary is never a supply. What stays
 * the user's call instead is the CLASSIFICATION — it is matched on account
 * NAME, and a handful of real names are ambiguous. Casual labour supplied
 * through a broker IS a taxable supply and production carries
 * `COS - Casual wages - EX2009`; so are "Investment Property" rental, "Payroll
 * Software" and engineering "Technical Drawings". Coercing those on the
 * attended path would silently strip a legitimate claim, which is the failure
 * this module exists to avoid the mirror image of.
 *
 * So: attended paths WARN and the user's choice stands. The unattended ones —
 * the rule sweep and the categorisation suggestions, where nobody is watching —
 * COERCE to `none` and report it. Same division of labour, so a reader who
 * knows one file knows the other.
 *
 * A WARNING IS NOT A GATE, AND THAT IS A KNOWN LIMIT. The entertainment
 * warning has shipped since 2026-09-01 and Velocity still carries 151
 * standard-rated Entertainment lines. If the attended path needs to REFUSE
 * rather than warn, that is an acknowledgement flow — a 409 plus the UI
 * confirm that answers it — and it must ship as both halves or not at all.
 * It is not built here.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { VAT_CODE_NONE, shouldWarnOnNonSupply } from './nonSupplyAccounts';
import type { NonSupplyReason } from './nonSupplyAccounts';

// The advisory half lives in the pure module so the bank screens can import it
// without pulling the database client into the browser bundle. Re-exported
// here so a server caller has one import for both halves.
export {
  VAT_CODE_NONE, NON_SUPPLY_ADVICE, NON_SUPPLY_LABEL, shouldWarnOnNonSupply,
} from './nonSupplyAccounts';

export interface NonSupplyResolution {
  /** The code the journal must actually be posted with. */
  vatCode: string;
  /** True when the guard overrode what the caller asked for. */
  coerced: boolean;
  /** Why it was overridden, or null when nothing changed. */
  reason: NonSupplyReason | null;
}

export interface NonSupplyContext {
  companyId: string;
  bankTxId?: string;
  ruleName?: string;
  glAccountId?: string;
}

/**
 * Resolve the vat code for an UNATTENDED post. Coerces a claim on a
 * non-supply account to `none` and logs it, so a scheduled run cannot invent
 * input tax on something that was never a supply.
 *
 * `coerced` is false when nothing was claimed in the first place — a missing
 * code becomes `none` because that is what it already meant, not because the
 * guard fired. Callers report on `coerced`, so conflating the two would put a
 * warning on every untaxed line in the sweep.
 */
export function applyNonSupplyGuard(
  accountName: string | null | undefined,
  requestedVatCode: string | null | undefined,
  context: NonSupplyContext,
): NonSupplyResolution {
  const requested = requestedVatCode || VAT_CODE_NONE;
  const reason = shouldWarnOnNonSupply(accountName, requested);
  if (reason === null) {
    return { vatCode: requested, coerced: false, reason: null };
  }
  log.warn(
    'Refused input tax on an account where no supply can arise — coerced to none',
    { ...context, accountName, reason, requestedVatCode: requested },
    'nonSupplyVatGuard',
  );
  return { vatCode: VAT_CODE_NONE, coerced: true, reason };
}

/**
 * Batched name lookup: one query for a whole rule sweep, mirroring
 * `fetchVatDenialFlags` beside it. A sweep posts hundreds of lines against a
 * handful of rule accounts, so resolving the name per line would be one
 * redundant SELECT per transaction.
 */
export async function fetchAccountNames(
  companyId: string,
  glAccountIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(glAccountIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = (await sql`
    SELECT id, account_name
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  return new Map(rows.map((r) => [String(r.id), String(r.account_name ?? '')]));
}

/**
 * Single-account form, for the one caller that has an id and no name:
 * `autoPostRuleLine`'s per-line fallback, taken when the sweep did not
 * pre-resolve. Its own SELECT rather than a chain inside
 * `resolveVatCodeForAccount`, because that resolver also writes the
 * categorisation SUGGESTIONS a human reviews — coercing there would decide
 * for them silently. See the note in inputVatDenial.ts.
 */
export async function resolveNonSupplyForAccount(
  companyId: string,
  glAccountId: string | null | undefined,
  requestedVatCode: string | null | undefined,
  context: Omit<NonSupplyContext, 'companyId'> = {},
): Promise<NonSupplyResolution> {
  const requested = requestedVatCode || VAT_CODE_NONE;
  if (!glAccountId) return { vatCode: requested, coerced: false, reason: null };

  const rows = (await sql`
    SELECT account_name FROM gl_accounts
    WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];

  const name = rows[0]?.account_name;
  return applyNonSupplyGuard(
    name === null || name === undefined ? null : String(name),
    requested,
    { companyId, glAccountId, ...context },
  );
}
