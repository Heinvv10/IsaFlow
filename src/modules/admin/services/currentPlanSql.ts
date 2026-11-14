/**
 * The one definition of "the plan a company is on" for feature gating: a scalar
 * subquery yielding the plan_id of the company's CURRENT subscription, to splice
 * into a query that exposes the companies row as alias `c`.
 *
 * Current = the latest LIVE subscription, ordered by created_at (never
 * updated_at, which any admin edit bumps) with id as the tiebreak. Live is:
 *   - active; or
 *   - past_due, the dunning grace window: the billing runner keeps charging it
 *     and settling returns it to active, and nothing else in the app cuts access
 *     on a failed payment, so entitlement is not cut here; or
 *   - trial whose end is still in the future. A trial's end is the later of the
 *     subscription's current_period_end (set by self-signup provisioning) and
 *     companies.trial_ends_at (what admin extend/convert write), so an extended
 *     trial stays live. A trial with neither date is NOT live: fail closed.
 * An expired trial is therefore never current, and an old onboarding trial
 * cannot resurface when a newer paying subscription is cancelled. By the same
 * rule an older ACTIVE row does resurface when a newer row is cancelled:
 * current is the latest LIVE row, not the latest row. Intended.
 * Cancelled and paused rows are never live. No live row: NULL, no plan features.
 *
 * `subscriptions` has no one-live-per-company constraint, hence the explicit
 * ordering. companies.plan_id is vestigial and never read.
 *
 * The text is a constant with no interpolated values, so splicing it through
 * sql.unsafe cannot inject anything.
 */
export const CURRENT_PLAN_ID_SQL = `(
  SELECT s.plan_id
  FROM public.subscriptions s
  WHERE s.company_id = c.id
    AND (s.status IN ('active', 'past_due')
         OR (s.status = 'trial'
             AND GREATEST(s.current_period_end, c.trial_ends_at) > NOW()))
  ORDER BY s.created_at DESC NULLS LAST, s.id DESC
  LIMIT 1
)`;
