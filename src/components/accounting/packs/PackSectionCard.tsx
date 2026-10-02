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
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ManagementPandLRows, ManagementBalanceSheetRows } from '@/components/accounting/ManagementPandLRows';
import { packToTotals, packToMargins, packToBsTotals, packToBsDetail } from '@/modules/accounting/services/reports/statementRows/packMappers';
import { formatPackKv } from '@/components/accounting/packs/PackSectionView';
import { scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';
import { log } from '@/lib/logger';
import { ratioLines, UnknownRatioError, type RatioLine } from '@/modules/accounting/services/reports/ratioPresentation';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { ProfitWaterfall } from '@/components/accounting/charts/ProfitWaterfall';
import { MissingPackFieldError, packToCashFlowUnavailable, packToWaterfallSteps } from '@/modules/accounting/services/packs/packSectionData';
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
          {section.type === 'waterfall' && <div className="col-span-full min-w-0"><BridgeChart d={d} /></div>}
          {section.type === 'trends' && (
            <div className="col-span-full text-sm text-[var(--ff-text-tertiary)] italic">
              Trend data requires multi-period historical context
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

/** The profit bridge, drawn by the component every other screen draws it with
 *  (`ProfitWaterfall`, which follows the theme). It used to print the sentence
 *  "Waterfall chart data available — render with WaterfallChart component". A
 *  saved payload whose steps are absent or are not steps shows a notice and a
 *  warning rather than throwing into the page. */
function BridgeChart({ d }: { d: Record<string, unknown> }) {
  // Read once per payload (memo), outside JSX; warned once per payload from an
  // effect — never from render, which runs on every update.
  const read = useMemo(() => readBridge(d), [d]);
  useEffect(() => {
    if (read.problem !== null) log.warn('SectionCard: the saved profit bridge is unusable', read.problem, 'packs');
  }, [read]);
  if (read.steps === null) {
    return <p className="text-sm text-[var(--ff-text-tertiary)] italic">This saved pack carries no usable profit bridge.</p>;
  }
  return <ProfitWaterfall steps={read.steps} title="Profit bridge" />;
}

function readBridge(d: Record<string, unknown>): { steps: WaterfallStep[] | null; problem: { field: string; reason: string } | null } {
  try {
    return { steps: packToWaterfallSteps(d), problem: null };
  } catch (err) {
    if (!(err instanceof MissingPackFieldError)) throw err;
    return { steps: null, problem: { field: err.field, reason: err.reason } };
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

/** Ratios, named and written by the ONE table every surface reads
 *  (`ratioPresentation`): "EBITDA 1 883 824.19", "Gross Profit Margin 45.0%",
 *  and a ratio the service could not compute prints its stated reason. The
 *  card used to split the key on its capitals and `toFixed(2)` everything, so
 *  a rand amount and a margin read alike ("Ebitda -1883824.19"). A saved
 *  payload with no reasons map simply has no reasons: the lines still read. */
function RatioItems({ d }: { d: Record<string, unknown> }) {
  // A key the label table does not know — a response cached across a deploy,
  // from a newer or older server — would throw out of `ratioLines` during
  // render and take the page with it. It is read once per payload outside JSX;
  // the document and PDF path keep throwing (fail closed), the screen does not.
  const read = useMemo(() => readRatios(d), [d]);
  useEffect(() => {
    if (read.lines === null) log.warn('SectionCard: the saved ratios carry a ratio this screen cannot name', {}, 'packs');
  }, [read]);
  if (read.lines === null) {
    return <p className="col-span-full text-sm text-[var(--ff-text-tertiary)] italic">This saved pack carries no usable ratios.</p>;
  }
  return (
    <>
      {read.lines.slice(0, 12).map((line) => (
        <KVItem key={line.key} label={line.label} value={line.text} />
      ))}
    </>
  );
}

function readRatios(d: Record<string, unknown>): { lines: RatioLine[] | null } {
  try {
    return { lines: ratioLines(d) };
  } catch (err) {
    if (!(err instanceof UnknownRatioError)) throw err;
    return { lines: null };
  }
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
  // An item whose ratio key this screen does not know (a response cached
  // across a deploy) would throw out of `scorecardFigure` during render. Read
  // once per item, outside JSX: that one tile says so, the rest still draw.
  const figure = useMemo(() => readFigure(item), [item]);
  useEffect(() => {
    if (figure === null) log.warn('SectionCard: a saved scorecard item carries a ratio this screen cannot name', {}, 'packs');
  }, [figure]);
  if (figure === null) {
    return (
      <div className="rounded p-2 text-xs border border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)]">
        <span className="block opacity-70 mb-0.5">{item.name}</span>
        <span className="opacity-80">This saved item cannot be shown.</span>
      </div>
    );
  }
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

function readFigure(item: KPIScorecardItem): ReturnType<typeof scorecardFigure> | null {
  try {
    return scorecardFigure(item);
  } catch (err) {
    if (!(err instanceof UnknownRatioError)) throw err;
    return null;
  }
}

function KVItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[var(--ff-text-tertiary)]">{label}</p>
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{value}</p>
    </div>
  );
}

