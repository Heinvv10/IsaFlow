/**
 * The interactive preview of one pack section, and the two tiles it uses.
 *
 * Extracted from `pages/accounting/reports/report-packs.tsx`, which crossed the
 * 300-line ceiling. It is the page's own preview, NOT the printed pack: the
 * print path renders a `PackDocument` through `PackSectionView`. The two share
 * their formatters (`packMappers`, `formatPackKv`, `scorecardFigure`) rather
 * than their markup, which is what keeps a figure reading the same on both
 * without pinning them to one layout.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ManagementPandLRows, ManagementBalanceSheetRows } from '@/components/accounting/ManagementPandLRows';
import { packToTotals, packToMargins, packToBsTotals, packToBsDetail } from '@/modules/accounting/services/reports/statementRows/packMappers';
import { formatPackKv } from '@/components/accounting/packs/PackSectionView';
import { scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';
import { log } from '@/lib/logger';
import { MissingPackFieldError, packToCashFlowUnavailable, packToRatioReasons } from '@/modules/accounting/services/packs/packSectionData';
import { marginKvItem } from '@/modules/accounting/services/packs/packDocument';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';

export interface PackSection { type: string; title: string; data: Record<string, unknown> }

const fmt = (n: unknown) => typeof n === 'number' ? `R ${n.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}` : String(n ?? '—');

export function SectionCard({ section, defaultOpen }: { section: PackSection; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const d = section.data;
  const margins = packToMargins(d);

  return (
    <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-secondary)] text-left"
      >
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">{section.title}</span>
        {open ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
      </button>
      {open && (
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3 min-w-0">
          {section.type === 'income_statement' && (
            <div className="col-span-full min-w-0 space-y-3">
              <ManagementPandLRows is={packToTotals(d)} />
              {/* Both margins come from reportPackService; the pack is a
                  document people send onward and these are the two figures a
                  reader quotes back off it. */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <KVItem label="Gross Margin" value={formatPackKv(marginKvItem('Gross Margin', margins.grossMargin))} />
                <KVItem label="Net Margin" value={formatPackKv(marginKvItem('Net Margin', margins.netMargin))} />
              </div>
            </div>
          )}
          {section.type === 'balance_sheet' && (
            <div className="col-span-full min-w-0">
              <ManagementBalanceSheetRows bs={packToBsTotals(d)} detail={packToBsDetail(d)} />
            </div>
          )}
          {section.type === 'cash_flow' && <CashFlowItems d={d} />}
          {section.type === 'ratios' && <RatioItems d={d} />}
          {section.type === 'kpis' && Array.isArray((d as { scorecard?: unknown[] }).scorecard) && (
            <div className="col-span-full min-w-0 grid grid-cols-3 gap-2">
              {((d as { scorecard: KPIScorecardItem[] }).scorecard).map((item) => (
                <ScorecardTile key={item.ratioKey} item={item} />
              ))}
            </div>
          )}
          {section.type === 'commentary' && (
            <div className="col-span-full text-sm text-[var(--ff-text-secondary)]">{String(d.summary ?? '')}</div>
          )}
          {(section.type === 'waterfall' || section.type === 'trends') && (
            <div className="col-span-full text-sm text-[var(--ff-text-tertiary)] italic">
              {section.type === 'waterfall' ? 'Waterfall chart data available — render with WaterfallChart component' : 'Trend data requires multi-period historical context'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A payload from before the field existed — a response the browser cached
 * across a deploy, or a stored snapshot — has nothing marked unavailable. The
 * shared readers throw on an absent field, which other code relies on; here
 * ONLY that case becomes "nothing marked", logged once per section type.
 * Anything else still throws.
 */
const warned = new Set<string>();
function reasonsOrNone(
  d: Record<string, unknown>,
  field: string,
  read: () => Record<string, string>,
  section: string,
): Record<string, string> {
  try {
    return read();
  } catch (err) {
    // ABSENT only. A field that is present but malformed is a defect, not an
    // old payload, and the reader's refusal stands.
    if (!(err instanceof MissingPackFieldError) || d[field] !== undefined) throw err;
    if (!warned.has(section)) {
      warned.add(section);
      log.warn('SectionCard: payload predates the unavailable-reasons field; showing figures as stored', { section, field: err.field }, 'packs');
    }
    return {};
  }
}

/** [field, label]. The `unavailable` map is keyed by the FIELD name, as
 *  `reportPackService` writes it. */
const CASH_FLOW_LINES: Array<[string, string]> = [
  ['operatingCashFlow', 'Operating CF'],
  ['investingCashFlow', 'Investing CF'],
  ['financingCashFlow', 'Financing CF'],
  ['netCashFlow', 'Net Cash Flow'],
  ['openingCash', 'Opening Cash'],
  ['closingCash', 'Closing Cash'],
];

/** A line the section marks unavailable prints its REASON, never the
 *  service's stand-in number — which, for a cash flow statement that could not
 *  be read, is net profit under the label "Operating CF". */
function CashFlowItems({ d }: { d: Record<string, unknown> }) {
  const unavailable = reasonsOrNone(d, 'unavailable', () => packToCashFlowUnavailable(d), 'cash_flow');
  return (
    <>
      {CASH_FLOW_LINES.map(([field, label]) => (
        <KVItem key={field} label={label} value={unavailable[field] ?? fmt(d[field])} />
      ))}
    </>
  );
}

/** A ratio the service could not compute prints its stated reason, as the
 *  scorecard tile does. `notMeaningful` is the reasons map, not a ratio. */
function RatioItems({ d }: { d: Record<string, unknown> }) {
  const reasons = reasonsOrNone(d, 'notMeaningful', () => packToRatioReasons(d), 'ratios');
  return (
    <>
      {Object.entries(d).filter(([k]) => k !== 'notMeaningful').slice(0, 12).map(([k, v]) => (
        <KVItem
          key={k}
          label={k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
          value={reasons[k] ?? (typeof v === 'number' ? v.toFixed(2) : String(v))}
        />
      ))}
    </>
  );
}

/**
 * One KPI tile.
 *
 * `KPIScorecardItem.value` is `number | null` — null whenever the engine could
 * not compute the ratio, which is the NORMAL state for an insolvent company
 * (AN-07: every equity-divided ratio is meaningless there). This tile was
 * typed `value: number` and called `.toFixed(2)` on it, so expanding "KPI
 * Scorecard" on such a company threw and took the whole page to the error
 * boundary. The decision now comes from `scorecardFigure`, the one the deck
 * and the printed page already used.
 *
 * `not_meaningful` gets its own neutral colour rather than falling through to
 * red: an unscorable ratio is not a failing one, and red says it failed.
 */
function ScorecardTile({ item }: { item: KPIScorecardItem }) {
  const figure = scorecardFigure(item);
  const tone = item.status === 'green' ? 'border-teal-500/30 text-teal-400'
    : item.status === 'amber' ? 'border-amber-500/30 text-amber-400'
    : item.status === 'red' ? 'border-red-500/30 text-red-400'
    : 'border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)]';

  return (
    <div className={`rounded p-2 text-xs border ${tone}`}>
      <span className="block opacity-70 mb-0.5">{item.name}</span>
      {figure.scored ? (
        <>
          <span className="font-bold">{figure.value}</span>
          <span className="opacity-60 ml-1">/ {figure.target}</span>
        </>
      ) : (
        <span className="opacity-80">{figure.reason}</span>
      )}
    </div>
  );
}

function KVItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[var(--ff-text-tertiary)]">{label}</p>
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{value}</p>
    </div>
  );
}

