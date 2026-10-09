/**
 * Rule changes vs switching auto-post on (forensic-controls step 2; breaker
 * round 2, R2-2b). With auto-post off a suggest-only rule posts nothing, so a
 * change to it applies at once; switching auto-post on is refused while such
 * a change, made by someone else and never approved, would then post money
 * (877's bank_rule_unreviewed_changes judges it, from the cutoff on).
 *
 * The two serialise on one per-company advisory lock, ALWAYS taken first:
 *   rule writers (bankRuleChangeControl: create, change, seed, merge re-point)
 *     → shared, before they read or lock a rule;
 *   the auto-post settings writer (autoPostSettingsService.applyOnce)
 *     → exclusive, before it locks the settings row.
 * So a rule change either commits before the switch-on reads the history (and
 * is judged), or classifies after the switch-on committed (and sees auto-post
 * on, so it is held).
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BankControlError } from './bankControlRefusal';

const key = (companyId: string) => `bank_rule_auto_post:${companyId}`;

export async function lockForRuleWrite(companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key(companyId)}, 0))`;
}

export async function lockForAutoPostSettings(companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key(companyId)}, 0))`;
}

type Unreviewed = { rule_id: string; rule_name: string; changed_by: string[]; changed_by_names: (string | null)[]; last_changed_at: Date | string };

/**
 * Refuses (409 AUTO_POST_RULES_UNREVIEWED), before any write, to switch
 * auto-post on under `bank_rule` while active rules carry changes nobody
 * approved that would then post money. The switcher's own changes do not
 * count (the accepted owner-alone case). Lists them in the message and the log.
 */
export async function assertNoUnreviewedRuleChanges(companyId: string, enablerId: string): Promise<void> {
  const rows = (await sql`
    SELECT u.rule_id, u.rule_name, u.changed_by, u.last_changed_at,
           ARRAY(SELECT public.approval_company_member_name(${companyId}::UUID, w) FROM unnest(u.changed_by) w) AS changed_by_names
    FROM public.bank_rule_unreviewed_changes(${companyId}::UUID, ${enablerId}) u
  `) as Unreviewed[];
  if (rows.length === 0) return;
  const when = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 16).replace('T', ' ');
  const list = rows.map((r) => `"${r.rule_name}" (changed by ${r.changed_by_names.map((n, i) => n ?? r.changed_by[i]).join(', ')}, `
    + `last ${when(r.last_changed_at)})`);
  log.warn('Switching auto-post on refused: rule changes nobody approved', {
    companyId, enablerId, rules: rows.map((r) => ({ id: r.rule_id, name: r.rule_name, changedBy: r.changed_by, at: r.last_changed_at })),
  }, 'auto-post-gate');
  throw new BankControlError('AUTO_POST_RULES_UNREVIEWED', `Auto-post was not switched on: with it on, ${rows.length === 1
    ? 'this rule' : `these ${rows.length} rules`} would post money with changes nobody approved — ${list.join('; ')}. `
    + 'Disable them first; then re-activate each one (a second person approves it), or have the changes put back. '
    + 'Then switch auto-post on again.');
}
