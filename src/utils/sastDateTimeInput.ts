/**
 * An `<input type="datetime-local">` holds a wall-clock string with no zone ("2026-11-14T10:00"); the API holds an
 * instant (ISO, UTC). The admin site is run from South Africa and its tables show SAST (formatDisplayDateTime), so the
 * input is read and written as SAST too: UTC+2 all year, no daylight saving, so a fixed offset is exact.
 *
 * Slicing an ISO string into the input (UTC clock time read as local) and `new Date(input)` on the way back (browser
 * zone) made every edit-and-save move an announcement by the offset: 2 hours earlier each time.
 */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const INPUT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** The instant `iso` as the SAST wall clock a datetime-local input takes; '' for empty or unreadable. */
export function isoToSastInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms + SAST_OFFSET_MS).toISOString().slice(0, 16);
}

/** The ISO (UTC) instant of a datetime-local value read as SAST; '' for empty or unreadable. */
export function sastInputToIso(input: string | null | undefined): string {
  const m = input ? INPUT.exec(input) : null;
  if (!m) return '';
  const ms = Date.parse(`${m[1]}T${m[2]}:00.000Z`);
  return Number.isNaN(ms) ? '' : new Date(ms - SAST_OFFSET_MS).toISOString();
}
