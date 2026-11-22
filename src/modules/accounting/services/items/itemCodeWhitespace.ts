/**
 * Every character JS `String.prototype.trim()` strips, as the `characters` argument of Postgres `btrim(code, ...)`. A bare
 * `btrim(code)` strips spaces only, so a legacy row stored as 'FIB-0002<TAB>', with a non-breaking space or an ideographic
 * space would not match the trimmed code the PUT / POST / upsert paths compare. Built from the code points (0..0xFFFF whose
 * character trims to empty) so no invisible character sits in the source. Bind it as a parameter.
 */
export const ITEM_CODE_WHITESPACE: string = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i))
  .filter((c) => c.trim() === '')
  .join('');
