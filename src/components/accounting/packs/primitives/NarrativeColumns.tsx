/**
 * Spec §4.A page 4: two columns side by side. The commentary — or the visible
 * placeholder standing in for it — on the left, and the board's action panel
 * on the right.
 *
 * THE ACTION PANEL DOES NOT DEPEND ON THE COMMENTARY. It used to: the
 * `pending` branch returned the placeholder and nothing else, so a pack whose
 * commentary nobody had approved printed page 4 as one italic line at 1.0%
 * fill on a sheet of its own. The panel's items come from the matters model,
 * which exists whether or not anyone has written commentary, so the page now
 * carries content either way and the pack stays twelve pages (R-P57).
 *
 * TWO SOURCES, TWO COLUMNS, BOTH LABELLED. `narrative.actions` are the
 * APPROVER's own action items and belong with their prose; `boardActions` are
 * DERIVED from the matters. R7's whole point is that a reader can tell signed
 * text from machine text, so they are never merged into one list.
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
  /** Spec §4.A page 4's narrow column — see `boardActionItems`. Absent on
   *  every other narrative block in the pack. */
  boardActions?: string[];
}

/** What each rendered status tells the reader about where the words came
 *  from. Keyed by the two statuses that render a body, so adding a third
 *  renderable status is a compile error here rather than an unlabelled
 *  paragraph on a board pack. */
const SOURCE_LABEL: Record<'approved' | 'derived', string> = {
  approved: 'Approved commentary',
  derived: 'Derived from the figures — not reviewed commentary',
};

/** The derived right-hand column. Headed and sourced, so a reader can see it
 *  was not written by whoever signed the commentary beside it. */
function BoardActionPanel({ actions }: { actions: string[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="pack-narrative-actions">
      <h3 className="pack-narrative-actions-heading">For the board</h3>
      <span className="pack-narrative-source">{SOURCE_LABEL.derived}</span>
      <ul>
        {actions.map((action, index) => (
          <li key={index}>{action}</li>
        ))}
      </ul>
    </div>
  );
}

export function NarrativeColumns({ narrative, boardActions = [] }: NarrativeColumnsProps) {
  if (narrative.status === 'pending') {
    return (
      <div className="pack-narrative-columns is-pending">
        {/* The placeholder STAYS. Filling the action panel must never become
         *  a way to stop saying that commentary is owed and unwritten.
         *
         *  `is-pending` is what stops it reserving two thirds of the measure
         *  to say it: one italic line does not need a 2fr column, and the
         *  action panel beside it does need more than 1fr. See packPrint.css. */}
        <p className="pack-narrative-pending">Commentary pending approval.</p>
        <BoardActionPanel actions={boardActions} />
      </div>
    );
  }

  if (narrative.status !== 'approved' && narrative.status !== 'derived') {
    // 'draft' — unapproved model output. Render nothing, INCLUDING the action
    // panel: a page carrying only the panel would read as a page whose
    // commentary is fine rather than one whose commentary is unapproved.
    return null;
  }

  // ONE COLUMN WHERE THERE IS NOTHING TO PUT IN THE SECOND. The grid is
  // 2fr 1fr on every narrative block in the pack, and only page 4 has an
  // action panel to fill the 1fr: on pages 5, 6, 8 and 10 the derived
  // caption was set into two thirds of the measure with a third of the sheet
  // blank beside it, which is what a fixed template looks like when the
  // content it was drawn for is absent. Same collapse `is-pending` already
  // does in the other direction.
  const single = boardActions.length === 0;
  return (
    <div className={`pack-narrative-columns is-${narrative.status}${single ? ' is-single' : ''}`}>
      <div className="pack-narrative-body">
        <span className="pack-narrative-source">{SOURCE_LABEL[narrative.status]}</span>
        {narrative.body}
        {narrative.actions.length > 0 && (
          // The APPROVER's own action items, under their own prose — not in
          // the derived panel beside it, which they did not write.
          <ul className="pack-narrative-approved-actions">
            {narrative.actions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ul>
        )}
      </div>
      <BoardActionPanel actions={boardActions} />
    </div>
  );
}
