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
  | 'submitted'
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
  submitted:        { key: 'submitted',        label: 'Submitted',        tone: 'success',         description: 'Filed with SARS / external authority.' },
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
  signed_off: 'approved',
  reviewed: 'approved',
  finalised: 'approved',
  finalized: 'approved',
  // Posted (in the GL — for transactional records)
  posted: 'posted',
  auto_generated: 'posted',
  completed: 'posted',
  // Submitted (sent to external party)
  submitted: 'submitted',
  filed: 'submitted',
  sent: 'submitted',
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

/** Tailwind class lookup — keeps the colour palette in one place. */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  neutral:        'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
  info:           'bg-sky-500/10 text-sky-300 border-sky-500/30',
  progress:       'bg-amber-500/10 text-amber-300 border-amber-500/30',
  attention:      'bg-red-500/10 text-red-300 border-red-500/30',
  success:        'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  'success-strong': 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  danger:         'bg-rose-500/10 text-rose-300 border-rose-500/30',
};
