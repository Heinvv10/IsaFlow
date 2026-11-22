/**
 * The characters JS `String.prototype.trim()` strips that matter in an item code, as the `characters` argument of Postgres
 * `btrim(code, ...)`. A bare `btrim(code)` strips spaces only, so a legacy row stored as 'FIB-0002<TAB>' or with a
 * non-breaking space would not match the trimmed code the PUT / POST / upsert paths compare. Bind it as a parameter.
 */
export const ITEM_CODE_WHITESPACE = ' \t\n\v\f\r   ﻿';
