/**
 * Pure rules for the coding decision log (migration 903). No imports, no I/O.
 */

/** `categorization_decisions.suggestion_source`. `shared_pool` is reserved for pooled suggestions (PR 2). */
export type SuggestionSource = 'rule' | 'pattern' | 'historical' | 'llm' | 'supplier_rule' | 'shared_pool' | 'none';

export type DecisionOutcome = 'pending' | 'accepted' | 'recoded' | 'rejected' | 'undone';

export interface CodingTarget {
  glAccountId: string | null;
  contactId: string | null;
}

const same = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * A person's allocation against ISAFlow's suggestion: `accepted` when it lands on a target the suggestion
 * named (its GL account, or the supplier / customer a rule named), otherwise `recoded`. A split allocation
 * passes no single target and is always `recoded`.
 */
export function decideAllocationOutcome(suggested: CodingTarget, final: CodingTarget): 'accepted' | 'recoded' {
  return same(suggested.glAccountId, final.glAccountId) || same(suggested.contactId, final.contactId)
    ? 'accepted' : 'recoded';
}

/**
 * The decision-log source for a value of `bank_transactions.suggested_strategy` (migration 493); anything
 * unrecognised (or a line whose suggestion came from somewhere that set no strategy) is `none`.
 */
export function sourceFromStrategy(strategy: string | null | undefined): SuggestionSource {
  return strategy === 'rule' || strategy === 'pattern' || strategy === 'historical' || strategy === 'llm'
    ? strategy : 'none';
}

/** A rule suggestion that names a supplier and no GL account is a supplier rule. */
export function ruleSource(glAccountId: string | null, supplierId: string | null): SuggestionSource {
  return supplierId && !glAccountId ? 'supplier_rule' : 'rule';
}
