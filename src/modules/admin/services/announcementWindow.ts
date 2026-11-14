/**
 * The window an announcement runs in. An announcement with no end runs until it is deleted; one with an end must end
 * strictly after it starts (an end at or before the start is never shown, and the admin list would still show it as
 * scheduled). Dates are the ISO instants the admin form sends.
 */
const unreadable = (v: string) => Number.isNaN(Date.parse(v));

/** The sentence to answer a 400 with, or null when `starts` and `ends` (null/undefined = no end) are a valid window. */
export function announcementWindowError(starts: string, ends: string | null | undefined): string | null {
  if (!starts || unreadable(starts)) return 'Start must be a valid date and time';
  if (ends === null || ends === undefined) return null;
  if (unreadable(ends)) return 'End must be a valid date and time';
  return Date.parse(ends) > Date.parse(starts) ? null : 'End must be after the start';
}
