/**
 * PackDocument to slides. Pure, so what lands in PowerPoint is assertable
 * without opening PowerPoint.
 *
 * Tables carry FORMATTED strings (the deck is read, not recalculated) and use
 * the same formatters the screen and the PDF use, so a figure cannot read one
 * way on a slide and another way on the page it came from.
 *
 * Charts carry RAW numbers, because a native PowerPoint chart the reader can
 * edit is the whole point of exporting to pptx rather than pasting an image.
 *
 * NOTHING IN THIS FILE COMPUTES A FIGURE — packDeckModel.test.ts fails if a
 * number is printed that the pack did not produce.
 */
import { formatMoney } from '@/lib/format/money';
import { NON_FIGURE_KINDS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { PackBlock, PackDocument } from './packDocument';
import { formatPackKv, NO_FIGURE } from './packKvFormat';
import { PACK_LABELS } from './packSections';

export interface DeckTitleSlide { kind: 'title'; title: string; subtitle: string; footnote: string }
export interface DeckTableRow { label: string; value: string; emphasis: boolean }
export interface DeckTableSlide { kind: 'table'; title: string; rows: DeckTableRow[] }
export interface DeckChartSeries { name: string; values: number[] }
export interface DeckChartSlide { kind: 'chart'; title: string; categories: string[]; series: DeckChartSeries[] }
export interface DeckTextSlide { kind: 'text'; title: string; body: string }
export type DeckSlide = DeckTitleSlide | DeckTableSlide | DeckChartSlide | DeckTextSlide;

/** The rows a reader's eye stops on. Bolded, not recalculated. */
const EMPHASIS_KINDS: ReadonlySet<string> = new Set(['total', 'grand']);

/** A scored ratio reads "<value> / <target>"; one that could not be scored
 *  prints the service's own reason INSTEAD, as the screen's scorecard does. */
function scorecardValue(item: KPIScorecardItem): string {
  if (item.value === null) return item.reason ?? NO_FIGURE;
  return `${item.value.toFixed(2)} / ${item.target}`;
}

function slidesForBlock(title: string, block: PackBlock): DeckSlide[] {
  switch (block.kind) {
    case 'statement':
      return [{
        kind: 'table',
        title,
        // A `section` row carries the band total that its own subtotal row
        // prints; keeping both would show every band twice.
        rows: block.rows
          .filter((row) => !NON_FIGURE_KINDS.has(row.kind))
          .map((row) => ({
            label: row.label,
            value: formatMoney(row.actual, { cents: true }),
            emphasis: EMPHASIS_KINDS.has(row.kind),
          })),
      }];

    case 'kv':
      return [{
        kind: 'table',
        title,
        rows: block.items.map((item) => ({ label: item.label, value: formatPackKv(item), emphasis: false })),
      }];

    case 'scorecard':
      return [{
        kind: 'table',
        title,
        rows: block.items.map((item) => ({ label: item.name, value: scorecardValue(item), emphasis: false })),
      }];

    case 'waterfall':
      return [{
        kind: 'chart',
        title,
        categories: block.steps.map((s) => s.label),
        // `value` is the movement the service produced. Never `end - start`:
        // that is the same figure re-derived, and a rounding difference
        // between the two is a figure the pack never published.
        series: [{ name: 'Movement', values: block.steps.map((s) => s.value) }],
      }];

    case 'trend':
      // Revenue only — the series the printed page plots, so the deck and the
      // page cannot show a reader two different twelve-month charts.
      return [{
        kind: 'chart',
        title,
        categories: block.points.map((p) => p.label),
        series: [{ name: 'Revenue', values: block.points.map((p) => p.revenue) }],
      }];

    case 'text':
      return [{ kind: 'text', title, body: block.text }];

    default: {
      const unreachable: never = block;
      throw new Error(`No deck slide is defined for pack block ${JSON.stringify(unreachable)}.`);
    }
  }
}

export function buildPackDeck(document: PackDocument): DeckSlide[] {
  const title: DeckTitleSlide = {
    kind: 'title',
    title: document.companyName,
    subtitle: PACK_LABELS[document.packType],
    footnote: document.period,
  };
  const body = document.sections.flatMap((section) =>
    section.blocks.flatMap((block) => slidesForBlock(section.title, block)),
  );
  return [title, ...body];
}
