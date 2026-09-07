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
import { PackShareButton, PackCommentary } from '@/components/accounting/packs/PackOwnerTools';
import { PresentLink } from '@/components/accounting/reportControls/PresentLink';

type PackType = 'board' | 'management' | 'monthly';

interface ReportPack { type: PackType; companyName: string; period: string; generatedAt: string; sections: PackSection[] }

const PACK_CONFIGS: Array<{ type: PackType; label: string; description: string; sections: string }> = [
  { type: 'board', label: 'Board Pack', description: 'P&L, Balance Sheet, Ratios, KPIs & Commentary', sections: '5 sections' },
  { type: 'management', label: 'Management Pack', description: 'Full board pack + Cash Flow, Trends & Waterfall', sections: '8 sections' },
  { type: 'monthly', label: 'Monthly Pack', description: 'P&L, Balance Sheet, Cash Flow & Ratios', sections: '4 sections' },
];

/** What `?print=1` means with no `pack` named. Bookmarks predating the
 *  parameter rely on it, and the download route always names one. */
const DEFAULT_PRINT_PACK = 'management';

/**
 * How long the server told us to wait, in whole seconds.
 *
 * `Retry-After` is optional and `apiResponse.tooManyRequests` does not
 * currently set one, so the absent case is the NORMAL case rather than an
 * error path — the message just drops the countdown. The header's HTTP-date
 * form is not read: this endpoint's limiter is a fixed window in seconds, and
 * guessing at a date form nothing sends would be untested code.
 */
export function retryAfterSeconds(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

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
    // Absent and WRONG are different. No `pack` at all is an old bookmark of
    // `?print=1` from before the parameter existed, and it has always meant
    // the management pack — breaking those is a regression nobody asked for.
    // A pack that is PRESENT but not a known type is a different thing: it is
    // whatever the URL said, and it used to be `String(...) as PackType`,
    // which typed a lie and sent an unknown value on to build a trend URL.
    //
    // The refusal deliberately never becomes print-ready, like the data-error
    // state in PackPrintPage: the renderer times out loudly rather than
    // photographing a page that is not the pack that was asked for. The
    // download route validates its own `id` first, so a person typing the URL
    // is the only one who reaches it — which is who the sentence is written
    // for. An empty `?pack=` counts as present and wrong: it names nothing, and
    // no bookmark carries it.
    const requested = router.query.pack ?? DEFAULT_PRINT_PACK;
    if (!isPackType(requested)) {
      return (
        <p className="p-8 text-sm text-[var(--ff-text-secondary)]">
          Unknown pack type. Choose board, management or monthly.
        </p>
      );
    }
    return (
      <PackPrintPage
        packType={requested}
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
  /** Set when the last pack request was refused for rate limiting. `seconds`
   *  is null when the server sent no Retry-After, which it currently never
   *  does — the notice then says to wait a moment rather than name a number. */
  const [rateLimited, setRateLimited] = useState<{ seconds: number | null } | null>(null);
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!);
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0]!);
  // The pack the person is LOOKING AT. A share link and its commentary are
  // both filed under (type, from, to), so a link minted here and the sentences
  // approved below are about the same document as the figures on screen.
  const packParams = { type: selectedType, from, to };

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
        const res = await apiFetch(`/api/accounting/reports-pack?type=${selectedType}&from=${from}&to=${to}`);
        if (stale) return;

        // `apiFetch` RESOLVES on a 4xx, so a 429 used to fall through to
        // .json(), produce an envelope with no `data`, and leave the screen
        // blank with no spinner and no message — indistinguishable from a
        // company with no ledger. The limit is per company and shared with
        // every other report, so a reader who exported a few packs hits it
        // without doing anything unusual.
        if (res.status === 429) {
          setRateLimited({ seconds: retryAfterSeconds(res.headers) });
          return;
        }
        setRateLimited(null);

        const body = await res.json();
        if (stale) return;
        if (body.data?.pack) setPack(body.data.pack);
        if (body.data) setUnclassified(body.data.unclassifiedAccounts ?? null);
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
              {/* The deck for the pack ON SCREEN, over the period on screen:
                  the same values the downloads and the share link carry. */}
              <PresentLink pack={selectedType} from={from} to={to} />
              <PackShareButton params={packParams} />
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-7xl">
          <DataQualityNotice unclassifiedAccounts={unclassified} />
          {rateLimited && (
            <div
              role="status"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400"
            >
              Too many report requests. {rateLimited.seconds === null
                ? 'Please try again in a moment.'
                : `Please try again in ${rateLimited.seconds} seconds.`}
            </div>
          )}
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
              <PackCommentary params={packParams} />
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
