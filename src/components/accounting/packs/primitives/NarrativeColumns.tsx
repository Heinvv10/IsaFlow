/**
 * Board commentary, two columns side by side: prose on the left, the action
 * panel on the right.
 *
 * THE GATE: board commentary is `approved` (a human signed it off) or
 * `derived` (deterministic code) — never unapproved model output. This
 * component renders `narrative.body` and `narrative.actions` ONLY when
 * `status === 'approved'`. A `draft` narrative renders NOTHING — no body, no
 * actions, no fallback to draft text — and a `pending` narrative renders a
 * visible placeholder instead of its (also unapproved) body. Do not widen
 * this to show draft text when approved text is missing; that is the exact
 * failure this component exists to prevent.
 */
import type { PackNarrative } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface NarrativeColumnsProps {
  narrative: PackNarrative;
}

export function NarrativeColumns({ narrative }: NarrativeColumnsProps) {
  if (narrative.status === 'pending') {
    return (
      <div className="pack-narrative-columns">
        <p className="pack-narrative-pending">Commentary pending approval.</p>
      </div>
    );
  }

  if (narrative.status !== 'approved') {
    // 'draft' — unapproved model output. Render nothing.
    return null;
  }

  return (
    <div className="pack-narrative-columns">
      <div className="pack-narrative-body">{narrative.body}</div>
      {narrative.actions.length > 0 && (
        <ul className="pack-narrative-actions">
          {narrative.actions.map((action, index) => (
            <li key={index}>{action}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
