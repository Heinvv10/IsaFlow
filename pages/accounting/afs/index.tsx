// pages/accounting/afs/index.tsx
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Plus, Loader2, AlertCircle, Clock, CheckCircle, Lock } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { AfsDocument, DocumentStatus } from '@/modules/accounting/services/afs/afsTypes';

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

export default function AfsIndexPage() {
  const [documents, setDocuments] = useState<AfsDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

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

  async function handleCreateAfs() {
    const year = new Date().getFullYear();
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/accounting/afs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType: 'afs', reportingFramework: 'ifrs_smes', fiscalYear: year }),
      });
      const json = await res.json() as { data?: { document?: AfsDocument }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to create document');
      if (json.data?.document) setDocuments(prev => [json.data!.document!, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create AFS document');
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-7 h-7 text-zinc-700" />
            <div>
              <h1 className="text-2xl font-semibold text-zinc-900">Annual Financial Statements</h1>
              <p className="text-sm text-zinc-500 mt-0.5">IFRS-compliant AFS bundle generation and review</p>
            </div>
          </div>
          <button
            onClick={() => { void handleCreateAfs(); }}
            disabled={isCreating}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50 transition-colors"
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            New AFS
          </button>
        </div>

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

        {!isLoading && documents.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="w-10 h-10 text-zinc-300 mb-3" />
            <p className="text-zinc-500 text-sm">No AFS documents yet. Create your first one above.</p>
          </div>
        )}

        {!isLoading && documents.length > 0 && (
          <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100 overflow-hidden">
            {documents.map(doc => (
              <Link
                key={doc.id}
                href={`/accounting/afs/${doc.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50 transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <FileText className="w-5 h-5 text-zinc-400 group-hover:text-zinc-600 transition-colors" />
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {doc.documentType === 'afs'
                        ? `AFS — ${doc.fiscalYear ?? '—'}`
                        : `Management Pack — ${doc.period ?? '—'}`}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {doc.reportingFramework === 'ifrs_smes' ? 'IFRS for SMEs' : 'Full IFRS'}
                      {' · '}v{doc.version}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={doc.status} />
                  <span className="text-xs text-zinc-400">
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
