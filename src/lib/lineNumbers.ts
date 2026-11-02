/**
 * The number a row had in the list the user was looking at. A form that drops blank rows before it sends, or a
 * spreadsheet the page filters to its valid rows, changes every later row's array position; a refusal that says
 * "Line 3" must still mean the third row on screen. Rows are named by number, never by their text: the message
 * reaches error capture, and a description is customer text.
 */

/** `claimed` when it is a positive safe integer (the sender's own count), else `fallback` (the array position). */
export function shownPosition(claimed: unknown, fallback: number): number {
  return Number.isSafeInteger(claimed) && (claimed as number) > 0 ? (claimed as number) : fallback; // isSafeInteger is false for a string
}

/** The rows `keep` accepts, each stamped with its 1-based position in the FULL list. */
export function numberLines<T extends object>(lines: readonly T[], keep: (line: T) => boolean): (T & { lineNo: number })[] {
  return lines.flatMap((line, i) => (keep(line) ? [{ ...line, lineNo: i + 1 }] : []));
}
