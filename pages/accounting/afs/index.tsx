// pages/accounting/afs/index.tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Plus, Loader2, AlertCircle, Clock, CheckCircle, Lock } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import type { AfsDocument, DocumentStatus } from '@/modules/accounting/services/afs/afsTypes';
import { AfsCreateModal, type AfsCreateValues } from '@/components/accounting/afs/AfsCreateModal';

const STATUS_CONFIG: Record<DocumentStatus, { label: string; colour: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft',           colour: 'bg-zinc-100 text-zinc-700',     icon: <Clock className="w-3 h-3" /> },
  in_review:      { label: 'In Review',       colour: 'bg-blue-100 text-blue-700',     icon: <Clock className="w-3 h-3" /> },
  partner_review: { label: 'Partner Review',  colour: 'bg-yellow-100 text-yellow-700', icon: <Clock className="w-3 h-3" /> },
  signed_off:     { label: 'Signed Off',      colour: 'bg-green-100 text-green-700',   icon: <CheckCircle className="w-3 h-3" /> },
  filed:          { label: 'Filed',           colour: 'bg-purple-100 text-purple-700', icon: <Lock className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.colour}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function pickNextAfsYear(documents: AfsDocument[]): number {
  // Pick the most recent fiscal year not already used by an AFS doc.
  // Prevents the duplicate-year 409 by guessing intelligently before asking.
  const used = new Set(
    documents
      .filter(d => d.documentType === 'afs' && d.fiscalYear != null)
      .map(d => d.fiscalYear as number),
  );
  const thisYear = new Date().getFullYear();
  for (let candidate = thisYear; candidate >= thisYear - 10; candidate--) {
    if (!used.has(candidate)) return candidate;
  }
  return thisYear;
}

export default function AfsIndexPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<AfsDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const typeFilter = typeof router.query.type === 'string' ? router.query.type : '';
  const visibleDocuments = useMemo(
    () => typeFilter ? documents.filter(d => (d as { documentType?: string }).documentType === typeFilter) : documents,
    [documents, typeFilter]
  );

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/afs', { credentials: 'include' });
      const json = await res.json() as { data?: { documents?: AfsDocument[] }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to load documents');
      setDocuments(json.data?.documents ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AFS documents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  const handleCreateAfs = useCallback(async (values: AfsCreateValues): Promise<string | null> => {
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/accounting/afs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType: 'afs',
          reportingFramework: values.reportingFramework,
          fiscalYear: values.fiscalYear,
        }),
      });
      const json = await res.json() as { data?: { document?: AfsDocument }; error?: { message?: string } };
      if (!res.ok) return json.error?.message ?? 'Failed to create document';
      if (json.data?.document) setDocuments(prev => [json.data!.document!, ...prev]);
      setShowCreateModal(false);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Failed to create AFS document';
    } finally {
      setIsCreating(false);
    }
  }, []);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <PageHeader
          icon={FileText}
          title="Annual Financial Statements"
          subtitle="IFRS-compliant AFS bundle generation and review"
          actions={
            <button
              onClick={() => setShowCreateModal(true)}
              disabled={isCreating}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New AFS
            </button>
          }
        />

        <AfsCreateModal
          open={showCreateModal}
          initialYear={pickNextAfsYear(documents)}
          isCreating={isCreating}
          onSubmit={handleCreateAfs}
          onClose={() => { if (!isCreating) setShowCreateModal(false); }}
        />

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
          </div>
        )}

        {!isLoading && visibleDocuments.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="w-10 h-10 text-zinc-700 dark:text-zinc-300 mb-3" />
            <p className="text-zinc-500 text-sm">
              {typeFilter
                ? `No ${typeFilter === 'management_pack' ? 'management pack' : typeFilter} documents yet.`
                : 'No AFS documents yet. Create your first one above.'}
            </p>
          </div>
        )}

        {!isLoading && visibleDocuments.length > 0 && (
          <div className="rounded-xl border border-zinc-200 dark:border-slate-700 divide-y divide-zinc-100 dark:divide-slate-800 overflow-hidden">
            {visibleDocuments.map(doc => (
              <Link
                key={doc.id}
                href={`/accounting/afs/${doc.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50 dark:hover:bg-slate-800/50 transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <FileText className="w-5 h-5 text-zinc-400 group-hover:text-zinc-600 transition-colors" />
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-white">
                      {doc.documentType === 'afs'
                        ? `AFS — ${doc.fiscalYear ?? '—'}`
                        : `Management Pack — ${doc.period ?? '—'}`}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-slate-400 mt-0.5">
                      {doc.reportingFramework === 'ifrs_smes' ? 'IFRS for SMEs' : 'Full IFRS'}
                      {' · '}v{doc.version}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={doc.status} />
                  <span className="text-xs text-zinc-400 dark:text-slate-500">
                    {new Date(doc.updatedAt).toLocaleDateString('en-ZA')}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
