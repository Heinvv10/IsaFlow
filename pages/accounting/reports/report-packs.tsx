/**
 * Report Packs Page
 * Pack selector (Board/Management/Monthly) + preview + PDF download
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Download, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

type PackType = 'board' | 'management' | 'monthly';

interface PackSection { type: string; title: string; data: Record<string, unknown> }
interface ReportPack { type: PackType; companyName: string; period: string; generatedAt: string; sections: PackSection[] }

const PACK_CONFIGS: Array<{ type: PackType; label: string; description: string; sections: string }> = [
  { type: 'board', label: 'Board Pack', description: 'P&L, Balance Sheet, Ratios, KPIs & Commentary', sections: '5 sections' },
  { type: 'management', label: 'Management Pack', description: 'Full board pack + Cash Flow, Trends & Waterfall', sections: '8 sections' },
  { type: 'monthly', label: 'Monthly Pack', description: 'P&L, Balance Sheet, Cash Flow & Ratios', sections: '4 sections' },
];

const fmt = (n: unknown) => typeof n === 'number' ? `R ${n.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}` : String(n ?? '—');
const fmtPct = (n: unknown) => typeof n === 'number' ? `${n.toFixed(1)}%` : String(n ?? '—');

function SectionCard({ section, defaultOpen }: { section: PackSection; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const d = section.data;

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
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
          {section.type === 'income_statement' && (
            <>
              <KVItem label="Revenue" value={fmt(d.revenue)} />
              <KVItem label="Cost of Sales" value={fmt(d.costOfSales)} />
              <KVItem label="Gross Profit" value={fmt(d.grossProfit)} />
              <KVItem label="Gross Margin" value={fmtPct(d.grossMargin)} />
              <KVItem label="Operating Expenses" value={fmt(d.operatingExpenses)} />
              <KVItem label="Net Profit" value={fmt(d.netProfit)} />
              <KVItem label="Net Margin" value={fmtPct(d.netMargin)} />
            </>
          )}
          {section.type === 'balance_sheet' && (
            <>
              <KVItem label="Total Assets" value={fmt(d.totalAssets)} />
              <KVItem label="Current Assets" value={fmt(d.currentAssets)} />
              <KVItem label="Cash" value={fmt(d.cash)} />
              <KVItem label="Accounts Receivable" value={fmt(d.accountsReceivable)} />
              <KVItem label="Total Liabilities" value={fmt(d.totalLiabilities)} />
              <KVItem label="Accounts Payable" value={fmt(d.accountsPayable)} />
              <KVItem label="Total Equity" value={fmt(d.totalEquity)} />
            </>
          )}
          {section.type === 'cash_flow' && (
            <>
              <KVItem label="Operating CF" value={fmt(d.operatingCashFlow)} />
              <KVItem label="Investing CF" value={fmt(d.investingCashFlow)} />
              <KVItem label="Financing CF" value={fmt(d.financingCashFlow)} />
              <KVItem label="Net Cash Flow" value={fmt(d.netCashFlow)} />
              <KVItem label="Opening Cash" value={fmt(d.openingCash)} />
              <KVItem label="Closing Cash" value={fmt(d.closingCash)} />
            </>
          )}
          {section.type === 'ratios' && Object.entries(d).slice(0, 12).map(([k, v]) => (
            <KVItem key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())} value={typeof v === 'number' ? v.toFixed(2) : String(v)} />
          ))}
          {section.type === 'kpis' && Array.isArray((d as { scorecard?: unknown[] }).scorecard) && (
            <div className="col-span-3 grid grid-cols-3 gap-2">
              {((d as { scorecard: Array<{ name: string; value: number; target: number; status: string }> }).scorecard).map((item, i) => (
                <div key={i} className={`rounded p-2 text-xs border ${item.status === 'green' ? 'border-teal-500/30 text-teal-400' : item.status === 'amber' ? 'border-amber-500/30 text-amber-400' : 'border-red-500/30 text-red-400'}`}>
                  <span className="block opacity-70 mb-0.5">{item.name}</span>
                  <span className="font-bold">{item.value.toFixed(2)}</span>
                  <span className="opacity-60 ml-1">/ {item.target}</span>
                </div>
              ))}
            </div>
          )}
          {section.type === 'commentary' && (
            <div className="col-span-3 text-sm text-[var(--ff-text-secondary)]">{String(d.summary ?? '')}</div>
          )}
          {(section.type === 'waterfall' || section.type === 'trends') && (
            <div className="col-span-3 text-sm text-[var(--ff-text-tertiary)] italic">
              {section.type === 'waterfall' ? 'Waterfall chart data available — render with WaterfallChart component' : 'Trend data requires multi-period historical context'}
            </div>
          )}
        </div>
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

export default function ReportPacksPage() {
  const [selectedType, setSelectedType] = useState<PackType>('board');
  const [pack, setPack] = useState<ReportPack | null>(null);
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!);
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0]!);

  const loadPack = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/reports-pack?type=${selectedType}&from=${from}&to=${to}`).then(r => r.json());
      if (res.data?.pack) setPack(res.data.pack);
    } catch { /* handled by empty state */ }
    finally { setLoading(false); }
  }, [selectedType, from, to]);

  useEffect(() => { loadPack(); }, [loadPack]);

  const downloadPdf = async () => {
    setPdfLoading(true);
    try {
      const res = await apiFetch('/api/accounting/reports-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, from, to }),
      }).then(r => r.json());
      if (res.data?.pdfAvailable === false) {
        alert(res.data.message);
      }
    } catch { /* handled */ }
    finally { setPdfLoading(false); }
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
              <button onClick={downloadPdf} disabled={pdfLoading || !pack} className="ff-btn-secondary flex items-center gap-1 text-sm">
                {pdfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                PDF
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-7xl">
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
