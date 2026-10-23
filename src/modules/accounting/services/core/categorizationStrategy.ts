/**
 * Maps a categorization matcher's `matchSource` to the value persisted in
 * `bank_transactions.suggested_strategy`. Stored verbatim today, but isolating
 * the mapping keeps the persistence contract in one tested place.
 */
export type CategorizationStrategy = 'rule' | 'pattern' | 'historical' | 'llm' | 'shared_pool';

export function matchSourceToStrategy(source: CategorizationStrategy): CategorizationStrategy {
  return source;
}

/** True when a persisted strategy must be governed by the stricter LLM gate. */
export function isLlmStrategy(strategy: string | null | undefined): boolean {
  return strategy === 'llm';
}

/** True for a suggestion from the shared merchant pool: shown to a person, never auto-posted. */
export function isSharedPoolStrategy(strategy: string | null | undefined): boolean {
  return strategy === 'shared_pool';
}
