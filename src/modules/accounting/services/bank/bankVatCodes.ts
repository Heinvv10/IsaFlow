/**
 * The VAT codes a bank allocation may carry, and the refusal for any other.
 *
 * The set is `RuleVatCode` (types/bank.types.ts): the same four the bank screen's pickers, the rule routes
 * (bank-rules, bank-rules-action) and the MCP tools (`VAT_CODES`, mcp/tools/allocationLine) accept. A code outside
 * it used to post: `'standard'` is the only one that splits out VAT, so `'STANDARD'` or `'std'` posted the gross with
 * no VAT line and no vat_type, silently (WP2 row 13). Absent (`undefined` / `null`) still means "no code".
 */
import type { RuleVatCode } from '../../types/bank.types';
import { BankAllocationRefusal } from './bankAllocationRefusal';

export const ALLOCATION_VAT_CODES = ['none', 'standard', 'zero_rated', 'exempt'] as const satisfies readonly RuleVatCode[];

// Both directions: a code added to RuleVatCode and not here fails the type check, as does the reverse.
type Missing = Exclude<RuleVatCode, (typeof ALLOCATION_VAT_CODES)[number]>;
const everyRuleVatCodeListed: [Missing] extends [never] ? true : never = true;
void everyRuleVatCodeListed;

export function isAllocationVatCode(code: string): code is RuleVatCode {
  return (ALLOCATION_VAT_CODES as readonly string[]).includes(code);
}

/** The refusal (400 on every route that answers BankAllocationRefusal), before the first write. */
export function assertAllocationVatCode(code: string | null | undefined, what: string): void {
  if (code === undefined || code === null || isAllocationVatCode(code)) return;
  throw new BankAllocationRefusal(
    `${what}: unknown VAT code "${code}" — use one of ${ALLOCATION_VAT_CODES.join(', ')}. Nothing was posted.`,
  );
}
