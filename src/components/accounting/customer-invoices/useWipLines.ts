/**
 * The edit page's WIP time-entry lines (PR S round eleven). A line that bills a time entry carries its `timeEntryId`;
 * a draft PUT that leaves one out unbills that entry (customerInvoiceWipLinks.ts), and the server will not let a line
 * take the link back. So removing such a line:
 *   - asks first, naming the time it unbills;
 *   - is never autosaved: `problem` holds autosave until Save Changes sends it, and Approve & email refuses until
 *     then (`approveRefusal`). A save the server took makes its links the new baseline.
 * An invoice that bills time its lines do not link (a grouped WIP invoice, the timesheet path) cannot unbill it from
 * here: removing a line says that time stays billed to the invoice (`note`).
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { EditLine } from './invoicePutBody';

export const WIP_REMOVAL_HOLD = 'a removed time-entry line unbills its time: Save Changes saves it';
const APPROVE_REFUSAL = 'Save Changes first: it unbills the time of the removed time-entry line';

const linksOf = (lines: readonly { timeEntryId?: string | null }[]): string[] =>
  lines.flatMap((l) => (l.timeEntryId ? [l.timeEntryId] : []));

export function useWipLines(lines: readonly EditLine[], setLines: Dispatch<SetStateAction<EditLine[]>>) {
  const [linked, setLinked] = useState<string[]>([]); // the links the server holds
  const [unlinkedBilled, setUnlinkedBilled] = useState(0);
  const [removedUnlinked, setRemovedUnlinked] = useState(false);

  /** A load landed: its lines' links, and how many billed time entries no line links. */
  const loaded = useCallback((stored: readonly EditLine[], unlinkedTimeEntries: number) => {
    setLinked(linksOf(stored));
    setUnlinkedBilled(unlinkedTimeEntries);
    setRemovedUnlinked(false);
  }, []);
  /** A save the server took (its body, as JSON): its links are what the server holds now. */
  const saved = useCallback((json: string) => {
    const body = JSON.parse(json) as { items?: { timeEntryId?: string | null }[] };
    if (body.items) setLinked(linksOf(body.items));
  }, []);

  const remove = (key: string) => {
    const line = lines.find((l) => l.key === key);
    if (!line || lines.length <= 1) return;
    if (line.timeEntryId) {
      const what = line.description ? ` ("${line.description}")` : '';
      if (!window.confirm(`This unbills ${line.quantity} h of time${what}; it can be billed again later. Remove the line?`)) return;
    } else if (unlinkedBilled > 0) {
      setRemovedUnlinked(true);
    }
    setLines((prev) => prev.filter((l) => l.key !== key));
  };

  const removedLinks = linked.some((id) => !lines.some((l) => l.timeEntryId === id));
  const entries = unlinkedBilled === 1 ? '1 time entry' : `${unlinkedBilled} time entries`;
  return {
    remove,
    loaded,
    saved,
    /** Why autosave holds (a removed time-entry line), or null. */
    problem: removedLinks ? WIP_REMOVAL_HOLD : null,
    /** Approve & email's refusal while a removed time-entry line is unsaved, or null. */
    approveRefusal: removedLinks ? APPROVE_REFUSAL : null,
    note: removedUnlinked
      ? `This invoice bills ${entries} its lines do not link (a grouped or timesheet invoice): a removed line's time stays billed to this invoice.`
      : null,
  };
}
