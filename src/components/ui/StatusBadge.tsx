/**
 * StatusBadge — single shared status-pill component for every accountant-
 * facing surface. Wraps the canonical vocabulary in src/lib/statusVocabulary.ts.
 *
 * Use this instead of inlining `<span className="bg-amber-500/10 …">{status}</span>`
 * in pages — the central map keeps pill colour, label spelling, and synonyms
 * consistent across the product.
 *
 * Usage:
 *   <StatusBadge status={record.status} />
 *   <StatusBadge status={'auto_generated'} size="sm" />
 *   <StatusBadge status="approved" override={{ label: 'Locked & filed' }} />
 */

import type { CanonicalStatus } from '@/lib/statusVocabulary';
import { resolveStatus, STATUS_TONE_CLASSES } from '@/lib/statusVocabulary';

interface StatusBadgeProps {
  status: string | null | undefined;
  /** Override any field of the canonical resolution — e.g. tighter wording per page. */
  override?: Partial<Pick<CanonicalStatus, 'label' | 'tone' | 'description'>>;
  size?: 'sm' | 'md';
  /** Extra Tailwind classes — appended to the tone classes. */
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<StatusBadgeProps['size']>, string> = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2 py-0.5',
};

export function StatusBadge({ status, override, size = 'md', className }: StatusBadgeProps) {
  const resolved = resolveStatus(status);
  const label = override?.label ?? resolved.label;
  const tone = override?.tone ?? resolved.tone;
  const title = override?.description ?? resolved.description;

  return (
    <span
      className={`uppercase tracking-wide font-semibold rounded border inline-flex items-center ${SIZE_CLASSES[size]} ${STATUS_TONE_CLASSES[tone]} ${className ?? ''}`}
      title={title}
      data-status={resolved.key}
    >
      {label}
    </span>
  );
}
