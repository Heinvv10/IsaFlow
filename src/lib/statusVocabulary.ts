/**
 * Canonical status vocabulary.
 *
 * Per the consultant review (docs/isaflow-go-to-market-consultant-review.md
 * §"Status Language"): every accountant-facing status across modules should
 * resolve to one of eight canonical states. This file maps every backend
 * enum value the codebase uses today to its canonical state + display
 * label + visual tone, so UI components don't reinvent the wheel per page.
 *
 * **Do NOT** change backend status string values to match — those are
 * persisted in the DB and used in service-layer comparisons. This module
 * is *display-only*: a normaliser from raw `status: string` to
 * `{ key, label, tone }`.
 *
 * If you find a backend status that doesn't have a mapping here, add it
 * rather than introducing a new ad-hoc label string. Keep status names
 * consistent across the product.
 */

export type CanonicalStatusKey =
  | 'draft'
  | 'ready_for_review'
  | 'needs_attention'
  | 'in_progress'
  | 'approved'
  | 'posted'
  | 'done'
  | 'submitted'
  | 'filed'
  | 'locked'
  | 'cancelled'
  | 'unknown';

export type StatusTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'attention'
  | 'success'
  | 'success-strong'
  | 'danger';

export interface CanonicalStatus {
  key: CanonicalStatusKey;
  label: string;
  tone: StatusTone;
  /** Short human description for tooltips. */
  description?: string;
}

const CANONICAL: Record<CanonicalStatusKey, CanonicalStatus> = {
  draft:            { key: 'draft',            label: 'Draft',            tone: 'neutral',         description: 'Not yet ready for review.' },
  ready_for_review: { key: 'ready_for_review', label: 'Ready for review', tone: 'info',            description: 'Sent to a reviewer.' },
  in_progress:      { key: 'in_progress',      label: 'In progress',      tone: 'progress',        description: 'Work has started but is not done.' },
  needs_attention:  { key: 'needs_attention',  label: 'Needs attention',  tone: 'attention',       description: 'Blocking exception detected.' },
  approved:         { key: 'approved',         label: 'Approved',         tone: 'success',         description: 'Reviewer signed off.' },
  posted:           { key: 'posted',           label: 'Posted',           tone: 'success',         description: 'Booked into the GL.' },
  done:             { key: 'done',             label: 'Done',             tone: 'success',         description: 'Terminal non-GL state — bank recon completed, AFS section generated, archive run finished, etc.' },
  submitted:        { key: 'submitted',        label: 'Submitted',        tone: 'success',         description: 'Sent to SARS or another external authority.' },
  filed:            { key: 'filed',            label: 'Filed',            tone: 'success-strong',  description: 'AFS lodged with the regulator (CIPC / SARS).' },
  locked:           { key: 'locked',           label: 'Locked',           tone: 'success-strong',  description: 'Period closed; no further edits.' },
  cancelled:        { key: 'cancelled',        label: 'Cancelled',        tone: 'danger',          description: 'Reversed or voided.' },
  unknown:          { key: 'unknown',          label: 'Unknown',          tone: 'neutral' },
};

/**
 * Maps every backend status string the codebase uses today to its canonical
 * key. Lower-cased, snake- or kebab-case, US/UK spelling variants. Add new
 * synonyms here rather than introducing ad-hoc labels.
 */
const SYNONYMS: Record<string, CanonicalStatusKey> = {
  // Drafts
  draft: 'draft',
  pending: 'draft',
  new: 'draft',
  // Reviews
  in_review: 'ready_for_review',
  partner_review: 'ready_for_review',
  awaiting_review: 'ready_for_review',
  ready_for_review: 'ready_for_review',
  ready: 'ready_for_review',
  // In progress
  in_progress: 'in_progress',
  in_flight: 'in_progress',
  processing: 'in_progress',
  calculated: 'in_progress',
  open: 'in_progress',
  active: 'in_progress',
  // Attention
  needs_attention: 'needs_attention',
  attention: 'needs_attention',
  exception: 'needs_attention',
  // Approved (reviewer signed off, not yet posted)
  approved: 'approved',
  reviewed: 'approved',
  finalised: 'approved',
  finalized: 'approved',
  // Posted (in the GL — for transactional records like JEs, payroll runs)
  posted: 'posted',
  // Done (terminal non-GL state — recon completed, AFS section generated,
  // archive/migration finished, training booked, etc.). Distinct from
  // 'posted' because none of these touch the GL.
  done: 'done',
  completed: 'done',
  finished: 'done',
  auto_generated: 'done',
  // Submitted (sent to SARS or another external authority — for VAT201,
  // EMP201, etc. NOT for AFS, which has its own 'filed' state.)
  submitted: 'submitted',
  sent: 'submitted',
  // Filed (AFS document lodged with CIPC / SARS — terminal regulator state).
  // Kept distinct from 'submitted' because AFS users know the term "Filed"
  // and re-labelling would be a UX regression.
  filed: 'filed',
  // Signed off (AFS partner-review terminal state). Kept as 'approved' for
  // now since it's semantically a sign-off; AFS UI may want a dedicated
  // "Signed off" override if precision matters per surface.
  signed_off: 'approved',
  // Locked
  locked: 'locked',
  closed: 'locked',
  // Cancelled
  cancelled: 'cancelled',
  canceled: 'cancelled',
  voided: 'cancelled',
  reversed: 'cancelled',
};

function normaliseKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Given a backend status string, return its canonical { key, label, tone }.
 * Falls back to 'unknown' for unmapped values — log a warning if you see
 * 'unknown' in production so you can add the synonym.
 */
export function resolveStatus(raw: string | null | undefined): CanonicalStatus {
  if (!raw) return CANONICAL.unknown;
  const key = SYNONYMS[normaliseKey(raw)];
  if (!key) return { ...CANONICAL.unknown, label: raw };
  return CANONICAL[key];
}

/**
 * Tailwind class lookup — keeps the colour palette in one place.
 *
 * Each tone provides both light-mode and dark-mode text colors to meet
 * WCAG AA contrast (4.5:1 for small text) in both themes.
 * Light: darker text on pale tinted background.
 * Dark:  lighter text on translucent dark background (dark: prefix).
 */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  neutral:        'bg-zinc-100 dark:bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-500/30',
  info:           'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-500/30',
  progress:       'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30',
  attention:      'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/30',
  success:        'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30',
  'success-strong': 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-300 dark:border-emerald-500/40',
  danger:         'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30',
};
