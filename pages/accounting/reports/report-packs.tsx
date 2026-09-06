/**
 * Report Packs Page
 * Pack selector (Board/Management/Monthly) + preview + PDF download
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Download, Loader2, Presentation } from 'lucide-react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import {
  DataQualityNotice,
  type UnclassifiedWarning,
} from '@/components/accounting/DataQualityNotice';
import { log } from '@/lib/logger';
import { useRouter } from 'next/router';
import { isPrintRender } from '@/lib/pdf/printRenderQuery';
import { isPackType } from '@/modules/accounting/services/packs/packSections';
import { PackPrintPage } from '@/components/accounting/packs/PackPrintPage';
import { SectionCard, type PackSection } from '@/components/accounting/packs/PackSectionCard';

type PackType = 'board' | 'management' | 'monthly';

interface ReportPack { type: PackType; companyName: string; period: string; generatedAt: string; sections: PackSection[] }

const PACK_CONFIGS: Array<{ type: PackType; label: string; description: string; sections: string }> = [
  { type: 'board', label: 'Board Pack', description: 'P&L, Balance Sheet, Ratios, KPIs & Commentary', sections: '5 sections' },
  { type: 'management', label: 'Management Pack', description: 'Full board pack + Cash Flow, Trends & Waterfall', sections: '8 sections' },
  { type: 'monthly', label: 'Monthly Pack', description: 'P&L, Balance Sheet, Cash Flow & Ratios', sections: '4 sections' },
];

/**
 * The page has two entirely separate lives: the interactive screen below, and
 * the printed pack the PDF renderer photographs. They are sibling components
 * rather than one component with an early return — each owns its own hooks,
 * and an early return above `ReportPacksScreen`'s hooks would break the rules
 * of hooks the moment the branch changed.
 */
export default function ReportPacksPage() {
  const router = useRouter();

  if (isPrintRender(router)) {
    const pack = router.query.pack;
    // Validated, not cast. `pack` is whatever the URL says; it used to be
    // `String(...) as PackType`, which typed a lie and sent an unknown value
    // on to build a trend URL. Like the data-error state in PackPrintPage,
    // this deliberately never becomes print-ready: the renderer times out
    // loudly rather than photographing a page that is not the pack asked for.
    // The download route validates its own `id` first, so this is reachable
    // only by a person typing the URL — which is who the sentence is for.
    if (!isPackType(pack)) {
      return (
        <p className="p-8 text-sm text-[var(--ff-text-secondary)]">
          Unknown pack type. Choose board, management or monthly.
        </p>
      );
    }
    return (
      <PackPrintPage
        packType={pack}
        from={String(router.query.from ?? '')}
        to={String(router.query.to ?? '')}
      />
    );
  }

  return <ReportPacksScreen />;
}

function ReportPacksScreen() {
  const [selectedType, setSelectedType] = useState<PackType>('board');
  const [pack, setPack] = useState<ReportPack | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<'pdf' | 'pptx' | null>(null);
  const [unclassified, setUnclassified] = useState<UnclassifiedWarning | null>(null);
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!);
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0]!);

  /**
   * The pack fetch, with the LATEST request winning.
   *
   * There was no sequencing: a reader who switched from Board to Management,
   * or nudged a date, had two requests in flight, and whichever the server
   * answered last won. A full-GL aggregation for a wide period easily outlives
   * a narrow one, so the screen settled on the pack the reader had already
   * moved off — showing Board figures under a Management heading, with the
   * download buttons pointed at Management. Nothing on the page said so.
   *
   * Each run marks itself stale on cleanup, so only the newest effect can
   * write state. `loading` is set on the way in, not derived, so the spinner
   * covers the whole of the newest request rather than clearing when an older
   * one lands.
   */
  useEffect(() => {
    let stale = false;
    setLoading(true);

    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/reports-pack?type=${selectedType}&from=${from}&to=${to}`).then(r => r.json());
        if (stale) return;
        if (res.data?.pack) setPack(res.data.pack);
        if (res.data) setUnclassified(res.data.unclassifiedAccounts ?? null);
      } catch (err) {
        if (stale) return;
        log.error('Failed to load report pack', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!stale) setLoading(false);
      }
    })();

    return () => { stale = true; };
  }, [selectedType, from, to]);

  /**
   * Fetch a generated document and hand it to the browser. The server names
   * the file (Content-Disposition); `fallbackName` is only reached when the
   * blob arrives without one, since an `<a download>` needs some name.
   */
  const downloadFile = async (url: string, fallbackName: string, failure: string) => {
    const res = await apiFetch(url);
    await assertOk(res, failure);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fallbackName;
    a.click();
    URL.revokeObjectURL(objectUrl);
  };

  const download = async (format: 'pdf' | 'pptx') => {
    setDownloading(format);
    try {
      await downloadFile(
        `/api/accounting/packs/${selectedType}/${format}?from=${from}&to=${to}`,
        `report-pack-${selectedType}-${from}-to-${to}.${format}`,
        `${format.toUpperCase()} generation failed`,
      );
    } catch (err) {
      log.error('Failed to download report pack', { format, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDownloading(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Report Packs</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Board, Management & Monthly financial packs</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ff-input text-sm" />
              <span className="text-[var(--ff-text-secondary)]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="ff-input text-sm" />
              <button onClick={() => void download('pdf')} disabled={downloading !== null || !pack} className="ff-btn-secondary flex items-center gap-1 text-sm">
                {downloading === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                PDF
              </button>
              <button onClick={() => void download('pptx')} disabled={downloading !== null || !pack} className="ff-btn-secondary flex items-center gap-1 text-sm">
                {downloading === 'pptx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Presentation className="h-4 w-4" />}
                PowerPoint
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-7xl">
          <DataQualityNotice unclassifiedAccounts={unclassified} />
          {/* Pack Type Selector */}
          <div className="grid grid-cols-3 gap-4">
            {PACK_CONFIGS.map(cfg => (
              <button
                key={cfg.type}
                onClick={() => setSelectedType(cfg.type)}
                className={`rounded-lg border p-4 text-left transition-colors ${selectedType === cfg.type ? 'border-teal-500 bg-teal-500/10' : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] hover:border-teal-500/50'}`}
              >
                <p className="font-semibold text-[var(--ff-text-primary)]">{cfg.label}</p>
                <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{cfg.description}</p>
                <p className="text-xs text-teal-400 mt-2">{cfg.sections}</p>
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
          ) : pack ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
                  {pack.companyName} — {PACK_CONFIGS.find(c => c.type === pack.type)?.label}
                </h2>
                <span className="text-xs text-[var(--ff-text-tertiary)]">{pack.period}</span>
              </div>
              {pack.sections.map((section, i) => (
                <SectionCard key={section.type} section={section} defaultOpen={i === 0} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}

/**
 * Opts this page out of Next's automatic static optimisation, which is what
 * populates `router.query` on the SERVER render too.
 *
 * Without it the server renders with an empty query and picks
 * `ReportPacksScreen`, while the client's first pass reads `?print=1` off
 * `window.location` and picks `PackPrintPage` — two different trees, so React
 * fails hydration. In dev that paints the error overlay across every page of
 * the rendered PDF; in production it silently discards the server tree. It
 * also made `PackPrintPage` mount once with empty `from`/`to` props, firing a
 * wasted pack fetch and a 400 on the trend endpoint before the real query
 * arrived. Server-rendering the page removes the ambiguous window entirely:
 * `router.isReady` is true from the first client render.
 */
export async function getServerSideProps() {
  return { props: {} };
}
