/**
 * Board commentary, two columns side by side: prose on the left, the action
 * panel on the right.
 *
 * THE GATE: board commentary is `approved` (a human signed it off) or
 * `derived` (deterministic code) — never unapproved model output. This
 * component renders `narrative.body` and `narrative.actions` ONLY for those
 * two statuses. A `draft` narrative renders NOTHING — no body, no actions,
 * no fallback to draft text, and nothing hidden by CSS either, so there is
 * no DOM node for a stylesheet edit or a "print backgrounds" setting to
 * bring back — and a `pending` narrative renders a visible placeholder
 * instead of its (also unapproved) body. Do not widen this to show draft
 * text when approved text is missing; that is the exact failure this
 * component exists to prevent.
 *
 * AND THE TWO ADMITTED STATUSES ARE LABELLED APART. R7 admits derived text
 * precisely because it is deterministic, not because it is signed — so a
 * reader of the printed page must be able to see which one they are reading.
 * The source line below is content, not decoration: it prints the same words
 * whether or not `packPrint.css` loaded.
 */
import type { PackNarrative } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface NarrativeColumnsProps {
  narrative: PackNarrative;
}

/** What each rendered status tells the reader about where the words came
 *  from. Keyed by the two statuses that render a body, so adding a third
 *  renderable status is a compile error here rather than an unlabelled
 *  paragraph on a board pack. */
const SOURCE_LABEL: Record<'approved' | 'derived', string> = {
  approved: 'Approved commentary',
  derived: 'Derived from the figures — not reviewed commentary',
};

export function NarrativeColumns({ narrative }: NarrativeColumnsProps) {
  if (narrative.status === 'pending') {
    return (
      <div className="pack-narrative-columns">
        <p className="pack-narrative-pending">Commentary pending approval.</p>
      </div>
    );
  }

  if (narrative.status !== 'approved' && narrative.status !== 'derived') {
    // 'draft' — unapproved model output. Render nothing.
    return null;
  }

  return (
    <div className={`pack-narrative-columns is-${narrative.status}`}>
      <div className="pack-narrative-body">
        <span className="pack-narrative-source">{SOURCE_LABEL[narrative.status]}</span>
        {narrative.body}
      </div>
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
