// pages/accounting/afs/report-templates.tsx
// AFS Report Template Preview — view SA Companies Act compliant report wording

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import { FileText, Loader2, AlertCircle, Copy, Check } from 'lucide-react';

// ── Types ─────��─────────────────────────────────��───────────────────────────

interface TemplateResponse {
  reportType: string;
  entityType: string;
  framework: string;
  templates: {
    practitionerReport: string;
    directorsResponsibility: string;
    directorsReport: string;
    generalInformation: string;
  };
}

type ReportType = 'compilation' | 'accounting_officer' | 'review' | 'audit';
type EntityType = 'pty' | 'cc' | 'trust';
type Framework = 'ifrs_smes' | 'full_ifrs';

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  compilation: 'Compilation (ISRS 4410)',
  accounting_officer: 'Accounting Officer (s58)',
  review: 'Independent Review (ISRE 2400)',
  audit: 'Audit (ISA 700)',
};

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  pty: 'Private Company (Pty)',
  cc: 'Close Corporation (CC)',
  trust: 'Trust',
};

const FRAMEWORK_LABELS: Record<Framework, string> = {
  ifrs_smes: 'IFRS for SMEs',
  full_ifrs: 'Full IFRS',
};

// ── Main Page ───────────────────────���───────────────────────────────────────

export default function ReportTemplatesPage() {
  const [reportType, setReportType] = useState<ReportType>('compilation');
  const [entityType, setEntityType] = useState<EntityType>('pty');
  const [framework, setFramework] = useState<Framework>('ifrs_smes');
  const [data, setData] = useState<TemplateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(
        `/api/accounting/afs/report-templates?type=${reportType}&entity_type=${entityType}&framework=${framework}`,
      );
      const json = await res.json();
      setData(json.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [reportType, entityType, framework]);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <AppLayout>
      <PageHeader
        title="Report Templates"
        subtitle="SA Companies Act & IFRS-compliant report wording"
        icon={FileText}
      />

      {/* Controls */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-400">Report Type</label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
          >
            {Object.entries(REPORT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-400">Entity Type</label>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as EntityType)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
          >
            {Object.entries(ENTITY_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-400">Framework</label>
          <select
            value={framework}
            onChange={(e) => setFramework(e.target.value as Framework)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
          >
            {Object.entries(FRAMEWORK_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="flex items-center gap-2 py-8 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading templates...
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Template Sections */}
      {data && !loading && (
        <div className="space-y-6">
          <TemplateSection
            title="Practitioner Report"
            subtitle={REPORT_TYPE_LABELS[reportType]}
            text={data.templates.practitionerReport}
            copied={copied === 'practitioner'}
            onCopy={() => copyToClipboard(data.templates.practitionerReport, 'practitioner')}
          />

          <TemplateSection
            title="Directors' Responsibility Statement"
            text={data.templates.directorsResponsibility}
            copied={copied === 'responsibility'}
            onCopy={() => copyToClipboard(data.templates.directorsResponsibility, 'responsibility')}
          />

          <TemplateSection
            title="Directors' Report"
            text={data.templates.directorsReport}
            copied={copied === 'directors'}
            onCopy={() => copyToClipboard(data.templates.directorsReport, 'directors')}
          />

          <TemplateSection
            title="General Information"
            text={data.templates.generalInformation}
            copied={copied === 'general'}
            onCopy={() => copyToClipboard(data.templates.generalInformation, 'general')}
          />
        </div>
      )}
    </AppLayout>
  );
}

// ── Template Section Card ───────────────────────────────────────────────────

function TemplateSection({
  title,
  subtitle,
  text,
  copied,
  onCopy,
}: {
  title: string;
  subtitle?: string;
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/50">
      <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && <p className="text-xs text-zinc-400">{subtitle}</p>}
        </div>
        <button
          onClick={onCopy}
          className="flex items-center gap-1 rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-700"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-green-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-zinc-300">
        {text}
      </pre>
    </div>
  );
}
