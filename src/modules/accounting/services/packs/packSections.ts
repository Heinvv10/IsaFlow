/**
 * What a pack's sections are called, which way up they print, and which API
 * paths the printed page is allowed to call.
 *
 * The titles are IFRS for SMEs names, not the screen's plain-English labels:
 * a pack is a document a director forwards to a bank, and "Balance Sheet" on
 * a page headed "IFRS for SMEs" is a finding waiting to happen. The screen
 * keeps its own labels — only the pack is renamed.
 */
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

export const PACK_LABELS: Record<PackType, string> = {
  board: 'Board Pack',
  management: 'Management Pack',
  monthly: 'Monthly Pack',
};

const IFRS_TITLES = {
  income_statement: 'Statement of Comprehensive Income',
  balance_sheet: 'Statement of Financial Position',
  cash_flow: 'Statement of Cash Flows',
  ratios: 'Financial Ratios',
  kpis: 'KPI Scorecard',
  waterfall: 'Profit Bridge',
  trends: 'Twelve-Month Trend',
  commentary: 'Commentary',
} as const satisfies Record<string, string>;

/**
 * The section types a pack can contain. Derived from the title map rather than
 * from `getPackTemplate`, whose configs widen their `type` to `string` — and
 * packSections.test.ts already fails when reportPackService emits a section
 * with no entry above, so the two lists cannot drift apart unnoticed.
 */
export type PackSectionType = keyof typeof IFRS_TITLES;

export function isPackSectionType(sectionType: string): sectionType is PackSectionType {
  return sectionType in IFRS_TITLES;
}

/** The pack's title for a section. `fallback` is the service's own title and
 *  is only reached by a section type added upstream without an entry above —
 *  which packSections.test.ts fails on. */
export function packSectionTitle(sectionType: string, fallback: string): string {
  return (IFRS_TITLES as Record<string, string>)[sectionType] ?? fallback;
}

/** Sections whose content is a chart wide enough to need the page turned. */
const LANDSCAPE = new Set(['waterfall', 'trends']);

export function isLandscapeSection(sectionType: string): boolean {
  return LANDSCAPE.has(sectionType);
}

export const PACK_DATA_API = '/api/accounting/reports-pack';

export function packTrendApiPath(packType: PackType): string {
  return `/api/accounting/packs/${packType}/trend`;
}

/**
 * The exact API pathnames the printed pack page fetches — and therefore the
 * exact set the print token authorises. One list, read by the page (to build
 * its URLs) and by the download route (to mint the token), so the two cannot
 * drift into a 401 that shows up as an empty chart.
 */
export function packPrintApiPaths(packType: PackType): string[] {
  return [PACK_DATA_API, packTrendApiPath(packType)];
}
