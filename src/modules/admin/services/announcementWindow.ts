/**
 * The window an announcement runs in. An announcement with no end runs until it is deleted; one with an end must end
 * strictly after it starts (an end at or before the start is never shown, and the admin list would still show it as
 * scheduled). Dates are the ISO instants the admin form sends.
 */
import { z } from 'zod';
import { UUID } from '@/lib/schemas/common';
import { isRealTimestamp } from '@/lib/validation';

/** The values system_announcements' CHECK constraints accept: anything else is a 400 here, not a 500 there. */
export const AnnouncementType = z.enum(['info', 'warning', 'maintenance', 'feature']);
export const AnnouncementTarget = z.enum(['all', 'plan', 'company']);
/** target_ids is uuid[]: a non-UUID entry is a 400, not a cast error (breaker #1405 B1). */
export const AnnouncementTargetIds = z.array(UUID).max(1000);

/**
 * An ISO instant (date, time, optional zone) Postgres reads as written. Date.parse alone is not enough: it also reads
 * JS Date strings, "+275760-..." years and rolls "2026-02-30" over to March (breaker #1405 B1).
 */
export const announcementInstant = (label: 'Start' | 'End') =>
  z.string().refine(isRealTimestamp, `${label} must be a valid date and time`);

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
