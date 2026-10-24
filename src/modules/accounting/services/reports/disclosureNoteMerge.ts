/**
 * Generated and manual disclosure notes in one numbered list.
 *
 * Generated notes are numbered from 1 and, in a year that is not twelve months (or follows one), one
 * more than usual: the IAS 1.36 reporting-period note takes number 2 and the later notes move down
 * (disclosureNoteService). A manual note is stored under the number its author typed (the form
 * offers 8-99), so a stored 8 can land on the last generated note, and an older manual note below 8
 * can land on any. A manual note keeps its number unless a generated note (or an earlier manual note
 * that had to move) already has it; then it is shown under the next free number after it.
 * Stored numbers are never changed: saving addresses a note by its stored number, and the page deletes
 * by id, so the number a note is shown under cannot create or overwrite a row.
 */
import type { DisclosureNote } from './disclosureNoteService';

export function mergeDisclosureNotes(auto: DisclosureNote[], manual: DisclosureNote[]): DisclosureNote[] {
  const taken = new Set(auto.map((n) => n.noteNumber));
  const placed = [...manual]
    .sort((a, b) => a.noteNumber - b.noteNumber)
    .map((note) => {
      let shownAs = note.noteNumber;
      while (taken.has(shownAs)) shownAs += 1;
      taken.add(shownAs);
      return shownAs === note.noteNumber ? note : { ...note, noteNumber: shownAs };
    });
  return [...auto, ...placed].sort((a, b) => a.noteNumber - b.noteNumber);
}
