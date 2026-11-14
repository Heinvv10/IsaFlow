/**
 * The window an announcement runs in. An announcement with no end runs until it is deleted; one with an end must end
 * strictly after it starts (an end at or before the start is never shown, and the admin list would still show it as
 * scheduled). Dates are the ISO instants the admin form sends.
 */
/** Every targeted user reads both in the banner: title is varchar(200); the message is capped to something a bar can hold. */
export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_MESSAGE_MAX = 2000;

/** The first message a failed zod parse carries (form-level, else the first field's), for a 400. */
export function firstValidationMessage(error: { issues: ReadonlyArray<{ message: string }> }): string {
  return error.issues[0]?.message ?? 'Invalid input';
}

/** What a 400 says when the write-time guard refuses a pair the pre-check read as fine. */
export const WINDOW_ORDER_ERROR = 'End must be after the start';

const unreadable = (v: string) => Number.isNaN(Date.parse(v));

/** The sentence to answer a 400 with, or null when `starts` and `ends` (null/undefined = no end) are a valid window. */
export function announcementWindowError(starts: string, ends: string | null | undefined): string | null {
  if (!starts || unreadable(starts)) return 'Start must be a valid date and time';
  if (ends === null || ends === undefined) return null;
  if (unreadable(ends)) return 'End must be a valid date and time';
  return Date.parse(ends) > Date.parse(starts) ? null : WINDOW_ORDER_ERROR;
}
