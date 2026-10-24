/**
 * Pure rules for the coding decision log (migration 903). No imports, no I/O.
 */

/** `categorization_decisions.suggestion_source`. `shared_pool`: the shared merchant pool (sharedPool/). */
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
 * What a person's MATCH coded the line to: the journal it was matched to, read off that journal's other lines
 * (their GL accounts) and the supplier / customer payment it records (their contact). The suggested target
 * when the journal carries it, else the journal's one account / contact, else null (several, none named).
 */
export function matchedTarget(suggested: CodingTarget, glAccountIds: string[], contactIds: string[]): CodingTarget {
  const pick = (want: string | null, have: string[]): string | null =>
    have.find((h) => same(want, h)) ?? (have.length === 1 ? have[0]! : null);
  return { glAccountId: pick(suggested.glAccountId, glAccountIds), contactId: pick(suggested.contactId, contactIds) };
}

/**
 * A rule's "category" is the rule's free-text name, typed by a user and often naming a person or
 * counterparty, so the log never stores it (data minimisation: PR 2 mines this table).
 */
export function isRuleSource(source: SuggestionSource): boolean {
  return source === 'rule' || source === 'supplier_rule';
}

/**
 * The decision-log source for a value of `bank_transactions.suggested_strategy` (migration 493); anything
 * unrecognised (or a line whose suggestion came from somewhere that set no strategy) is `none`.
 */
export function sourceFromStrategy(strategy: string | null | undefined): SuggestionSource {
  return strategy === 'rule' || strategy === 'pattern' || strategy === 'historical' || strategy === 'llm'
    || strategy === 'shared_pool'
    ? strategy : 'none';
}

/** A rule suggestion that names a supplier and no GL account is a supplier rule. */
export function ruleSource(glAccountId: string | null, supplierId: string | null): SuggestionSource {
  return supplierId && !glAccountId ? 'supplier_rule' : 'rule';
}
