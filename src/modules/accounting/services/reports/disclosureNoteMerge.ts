/**
 * Generated and manual disclosure notes in one numbered list.
 *
 * Generated notes are numbered from 1 and, in a year that is not twelve months (or follows one), one
 * more than usual: the IAS 1.36 reporting-period note takes number 2 and the later notes move down
 * (disclosureNoteService). A manual note is stored under the number its author chose (the form
 * offers 8-99), so a stored 8 can land on the last generated note. Manual notes never take a
 * generated number: one at or below the highest number already used moves to the next free number
 * after it, and the manual notes that follow it keep their order. Stored numbers are not touched;
 * the manual note's id, not its number, is what the page deletes by.
 */
import type { DisclosureNote } from './disclosureNoteService';

export function mergeDisclosureNotes(auto: DisclosureNote[], manual: DisclosureNote[]): DisclosureNote[] {
  let used = auto.reduce((highest, n) => Math.max(highest, n.noteNumber), 0);
  const placed = [...manual]
    .sort((a, b) => a.noteNumber - b.noteNumber)
    .map((note) => {
      used = Math.max(note.noteNumber, used + 1);
      return used === note.noteNumber ? note : { ...note, noteNumber: used };
    });
  return [...auto, ...placed];
}
