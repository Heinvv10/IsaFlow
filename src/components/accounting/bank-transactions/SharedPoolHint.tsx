/**
 * "Common at other ISAFlow clients" — shown under a bank line's selection while it is still the shared
 * merchant pool's suggestion (suggested_strategy 'shared_pool'). Learning loop PR 2, decision 8: a pool
 * suggestion is always labelled as such and never auto-posted; once a person picks something else the
 * hint goes away.
 */

export const SHARED_POOL_HINT = 'Common at other ISAFlow clients';

export interface SharedPoolHintProps {
  suggestedStrategy?: string | null;
  suggestedGlAccountId?: string | null;
  selectedEntityId?: string | null;
}

export function isSharedPoolSelection(p: SharedPoolHintProps): boolean {
  return p.suggestedStrategy === 'shared_pool' && !!p.suggestedGlAccountId && p.selectedEntityId === p.suggestedGlAccountId;
}

export function SharedPoolHint(props: SharedPoolHintProps) {
  if (!isSharedPoolSelection(props)) return null;
  return (
    <span
      data-testid="shared-pool-hint"
      className="block mt-0.5 text-[10px] leading-tight text-sky-400"
      title="Suggested because other ISAFlow clients code this merchant this way. Check it before you allocate; it is never posted automatically."
    >
      {SHARED_POOL_HINT}
    </span>
  );
}
