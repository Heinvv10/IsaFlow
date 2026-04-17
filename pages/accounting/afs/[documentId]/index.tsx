// pages/accounting/afs/[documentId]/index.tsx
// AFS document editor — wrapped in AppLayout with dark-mode theme and section tabs.

import React, { useState, useEffect, useCallback } from 'react';
import type { NextPage, GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Clock, CheckCircle, Lock, ChevronRight, FileText,
  BarChart2, BookOpen, ShieldCheck, Download, Send,
} from 'lucide-react';
import type { AfsDocument, DocumentStatus } from '@/modules/accounting/services/afs/afsTypes';
import { AfsOverviewTab } from '@/components/accounting/afs/AfsOverviewTab';

type TabId = 'overview' | 'notes' | 'statements' | 'review' | 'compliance' | 'export';

interface PageProps { documentId: string; periodStart: string; periodEnd: string; }

const STATUS_CONFIG: Record<DocumentStatus, { label: string; colour: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft',          colour: 'bg-zinc-700 text-zinc-200',     icon: <Clock className="w-3 h-3" /> },
  in_review:      { label: 'In Review',      colour: 'bg-blue-800 text-blue-200',     icon: <Clock className="w-3 h-3" /> },
  partner_review: { label: 'Partner Review', colour: 'bg-yellow-800 text-yellow-200', icon: <Clock className="w-3 h-3" /> },
  signed_off:     { label: 'Signed Off',     colour: 'bg-green-800 text-green-200',   icon: <CheckCircle className="w-3 h-3" /> },
  filed:          { label: 'Filed',          colour: 'bg-purple-800 text-purple-200', icon: <Lock className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.colour}`}>
      {cfg.icon}{cfg.label}
    </span>
  );
}

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'overview',    label: 'Overview',    icon: <FileText className="w-4 h-4" /> },
  { id: 'notes',       label: 'Notes',       icon: <BookOpen className="w-4 h-4" /> },
  { id: 'statements',  label: 'Statements',  icon: <BarChart2 className="w-4 h-4" /> },
  { id: 'review',      label: 'Review',      icon: <CheckCircle className="w-4 h-4" /> },
  { id: 'compliance',  label: 'Compliance',  icon: <ShieldCheck className="w-4 h-4" /> },
  { id: 'export',      label: 'Export',      icon: <Download className="w-4 h-4" /> },
];

const AfsDocumentPage: NextPage<PageProps> = ({ documentId, periodStart, periodEnd }) => {
  const router = useRouter();
  const [doc, setDoc] = useState<AfsDocument | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadDoc = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}`, { credentials: 'include' });
      const json = await res.json() as { data?: { document?: AfsDocument }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      log.error('Failed to load AFS document', { error: err, documentId }, 'afs-document-page');
    }
  }, [documentId]);

  useEffect(() => { void loadDoc(); }, [loadDoc]);

  async function handleSubmitForReview() {
    setSubmitting(true); setActionError('');
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}/workflow`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit_for_review' }),
      });
      const json = await res.json() as { data?: { document?: AfsDocument }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to submit');
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      log.error('Workflow action failed', { error: err }, 'afs-document-page');
    } finally { setSubmitting(false); }
  }

  async function handleSignOff() {
    setSubmitting(true); setActionError('');
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}/workflow`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sign_off' }),
      });
      const json = await res.json() as { data?: { document?: AfsDocument }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to sign off');
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      log.error('Sign off failed', { error: err }, 'afs-document-page');
    } finally { setSubmitting(false); }
  }

  const title = doc
    ? `AFS ${doc.fiscalYear ?? periodStart.slice(0, 4)} | ISAFlow`
    : `AFS | ISAFlow`;

  return (
    <AppLayout>
      <Head><title>{title}</title></Head>
      <div className="min-h-screen bg-slate-900">

        {/* Breadcrumb */}
        <div className="bg-slate-900 border-b border-slate-800 px-6 py-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/accounting/afs" className="hover:text-slate-300 transition-colors">AFS</Link>
            <ChevronRight className="w-3.5 h-3.5" />
            <span className="text-slate-200 font-medium">
              {doc ? (doc.documentType === 'afs' ? `AFS ${doc.fiscalYear ?? ''}` : `Pack ${doc.period ?? ''}`) : documentId}
            </span>
          </div>
        </div>

        {/* Page header */}
        <div className="bg-slate-800 border-b border-slate-700 px-6 py-5">
          <div className="max-w-6xl mx-auto flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-white">Annual Financial Statements</h1>
                {doc && <StatusBadge status={doc.status} />}
              </div>
              <p className="text-sm text-slate-400">
                Period: {periodStart} — {periodEnd}
                {doc && ` · v${doc.version}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {doc?.status === 'draft' && (
                <button
                  onClick={() => { void handleSubmitForReview(); }}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  <Send className="w-4 h-4" />
                  Submit for Review
                </button>
              )}
              {(doc?.status === 'in_review' || doc?.status === 'partner_review') && (
                <button
                  onClick={() => { void handleSignOff(); }}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  <CheckCircle className="w-4 h-4" />
                  Sign Off
                </button>
              )}
            </div>
          </div>
          {actionError && (
            <div className="max-w-6xl mx-auto mt-3 text-sm text-red-400 bg-red-900/30 border border-red-800 rounded-lg px-4 py-2">
              {actionError}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="bg-slate-800 border-b border-slate-700 px-6">
          <div className="max-w-6xl mx-auto flex gap-0">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => {
                  if (tab.id === 'compliance') {
                    void router.push(`/accounting/afs/${documentId}/compliance`);
                  } else {
                    setActiveTab(tab.id);
                  }
                }}
                className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="max-w-6xl mx-auto px-6 py-8">
          {activeTab === 'overview' && (
            <AfsOverviewTab documentId={documentId} periodStart={periodStart} periodEnd={periodEnd} />
          )}
          {activeTab === 'notes' && (
            <div className="text-slate-400 text-sm py-12 text-center">
              <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>Notes to the Financial Statements — coming soon.</p>
              <Link href={`/accounting/afs/${documentId}/notes`} className="text-blue-400 hover:underline mt-2 inline-block">
                Open Notes editor →
              </Link>
            </div>
          )}
          {activeTab === 'statements' && (
            <div className="text-slate-400 text-sm py-12 text-center">
              <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>Full financial statements — Balance Sheet, Income Statement, and more.</p>
              <div className="flex gap-3 justify-center mt-4">
                <Link href={`/accounting/afs/${documentId}/balance-sheet`} className="text-blue-400 hover:underline">Balance Sheet →</Link>
                <Link href={`/accounting/afs/${documentId}/income-statement`} className="text-blue-400 hover:underline">Income Statement →</Link>
              </div>
            </div>
          )}
          {activeTab === 'review' && (
            <div className="text-slate-400 text-sm py-12 text-center">
              <CheckCircle className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>Review workflow — sign-off trail and comments.</p>
            </div>
          )}
          {activeTab === 'export' && (
            <div className="text-slate-400 text-sm py-12 text-center">
              <Download className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>Export AFS as PDF or XBRL package.</p>
              <Link href={`/accounting/afs/${documentId}/export`} className="text-blue-400 hover:underline mt-2 inline-block">
                Open Export →
              </Link>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
};

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ query }) => {
  const documentId = Array.isArray(query.documentId) ? query.documentId[0] : query.documentId;
  if (!documentId) return { notFound: true };

  // Explicit overrides from query always win (e.g. deep links).
  const queryStart = query.period_start as string | undefined;
  const queryEnd = query.period_end as string | undefined;

  let periodStart: string | null = null;
  let periodEnd: string | null = null;

  // Otherwise derive from the AFS document itself — for an AFS document the
  // fiscal_year field is the authoritative source of the reporting period,
  // and for a management_pack the `period` column (YYYY-MM) gives the month.
  if (!queryStart || !queryEnd) {
    try {
      const { sql } = await import('@/lib/neon');
      const rows = (await sql`
        SELECT fiscal_year, period, document_type
        FROM afs_documents WHERE id = ${documentId}::UUID LIMIT 1
      `) as Array<{ fiscal_year: number | null; period: string | null; document_type: string }>;
      const doc = rows[0];
      if (doc) {
        if (doc.document_type === 'afs' && doc.fiscal_year) {
          periodStart = `${doc.fiscal_year}-01-01`;
          periodEnd = `${doc.fiscal_year}-12-31`;
        } else if (doc.document_type === 'management_pack' && doc.period) {
          // Period is "YYYY-MM"; derive first/last day of that month.
          const [y, m] = doc.period.split('-').map(Number);
          if (y && m) {
            const lastDay = new Date(y, m, 0).getDate();
            periodStart = `${doc.period}-01`;
            periodEnd = `${doc.period}-${String(lastDay).padStart(2, '0')}`;
          }
        }
      }
    } catch {
      // Fall through to the safe default below
    }
  }

  const fallbackYear = new Date().getFullYear();

  return {
    props: {
      documentId,
      periodStart: queryStart ?? periodStart ?? `${fallbackYear}-01-01`,
      periodEnd:   queryEnd   ?? periodEnd   ?? `${fallbackYear}-12-31`,
    },
  };
};

export default AfsDocumentPage;
