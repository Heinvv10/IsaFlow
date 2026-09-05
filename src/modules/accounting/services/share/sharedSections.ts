/**
 * Which pack sections a shared link carries, and which it only names.
 *
 * The omitted sections are stripped SERVER-SIDE, before the props are built, so
 * "Not included on shared links." is a statement about the document rather than
 * a rendering choice. Leaving the data in `__NEXT_DATA__` while declining to
 * draw it would make the sentence false to anyone who opened view-source.
 *
 * One list, imported by both the page that strips and the view that draws the
 * note, because two lists are two chances for the page to ship data the view
 * has promised is absent.
 */
import type { PackSection, ReportPack } from '@/modules/accounting/services/reports/reportPackService';

/**
 * `kpis`, `waterfall` and `trends` hold arrays and prose, not top-level
 * numbers, so drawing them needs a shape per section.
 *
 * `ratios` is here for a different reason: `calculateExtendedRatios` returns
 * true ratios and rand amounts in one flat blob with nothing marking which is
 * which, so any single formatter is wrong for half of it — two decimals prints
 * "Ebitda -1819000.00", money prints a current ratio of -0.58 as "(1)". The
 * owner's own pack page has the same defect. WS2's PackDocument carries typed
 * format tags per figure; this view consumes it after merge and all four
 * sections come back then.
 */
export const OMITTED_SECTIONS: ReadonlySet<string> = new Set(['kpis', 'waterfall', 'trends', 'ratios']);

/** The pack's own `commentary` section holds a GENERATED summary. A shared link
 *  shows approved text only, so that blob is stripped too — it is simply not
 *  named as omitted, because approved commentary can still appear under it. */
const DATA_STRIPPED_SECTIONS: ReadonlySet<string> = new Set([...OMITTED_SECTIONS, 'commentary']);

/** A section on a shared link: `data` is absent for everything not drawn. */
export type SharedPackSection = Omit<PackSection, 'data'> & { data?: Record<string, unknown> };

export interface SharedReportPack extends Omit<ReportPack, 'sections'> {
  sections: SharedPackSection[];
}

/** Drops the data of every section a shared link does not draw, keeping the
 *  section's `type` and `title` so the reader still sees what the pack contains
 *  and what they are not being shown. */
export function stripOmittedSections(pack: ReportPack): SharedReportPack {
  return {
    ...pack,
    sections: pack.sections.map(({ type, title, data }) =>
      DATA_STRIPPED_SECTIONS.has(type) ? { type, title } : { type, title, data },
    ),
  };
}
