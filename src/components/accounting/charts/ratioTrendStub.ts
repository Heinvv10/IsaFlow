/**
 * How a ratio-trend chart marks the current month. Apart from
 * `RatioTrendChart` so the page can print the note without importing
 * recharts, which it loads through `next/dynamic`.
 */
export const STUB_MARK = '*';
export const RATIO_TREND_STUB_NOTE = `${STUB_MARK} The current month, to date.`;
/** The note's element id, which each chart drawing a stub is described by. */
export const RATIO_TREND_STUB_NOTE_ID = 'ratio-trend-stub-note';
