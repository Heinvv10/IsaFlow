// pages/accounting/afs/[documentId]/index.tsx
// AFS document editor — wrapped in AppLayout with dark-mode theme and section tabs.

import React, { useState, useEffect, useCallback } from 'react';
import type { NextPage, GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { CheckCircle, ChevronRight, Send } from 'lucide-react';
import type { AfsDocument, AfsSection } from '@/modules/accounting/services/afs/afsTypes';
import { AfsDocumentTabs } from '@/components/accounting/afs/AfsDocumentTabs';
import { AfsStatusBadge } from '@/components/accounting/afs/AfsStatusBadge';
import { ManagementPackView, managementPackTitle } from '@/components/accounting/afs/ManagementPackViewer';

/** periodMonths: null when the period came from the query or could not be stated (its length is unknown). */
interface PageProps { documentId: string; periodStart: string; periodEnd: string; periodMonths: number | null; periodError: string | null; }
const PERIOD_ERROR = 'Could not work out the reporting period for this document - reload the page to try again';

const AfsDocumentPage: NextPage<PageProps> = ({ documentId, periodStart, periodEnd, periodMonths, periodError }) => {
  const [doc, setDoc] = useState<(AfsDocument & { sections?: AfsSection[] }) | null>(null);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadDoc = useCallback(async () => {
    setActionError(''); setLoadError('');
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}`, { credentials: 'include' });
      await assertOk(res, 'Could not load the document - try again');
      const json = await res.json() as { data?: { document?: AfsDocument } };
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      log.error('Failed to load AFS document', { error: err, documentId }, 'afs-document-page');
      setDoc(null);
      setLoadError(apiErrorMessage(err, 'Could not load the document - try again'));
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
      await assertOk(res, 'Could not submit the document for review - try again');
      const json = await res.json() as { data?: { document?: AfsDocument } };
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Could not submit the document for review - try again'));
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
      await assertOk(res, 'Could not sign off the document - try again');
      const json = await res.json() as { data?: { document?: AfsDocument } };
      if (json.data?.document) setDoc(json.data.document);
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Could not sign off the document - try again'));
      log.error('Sign off failed', { error: err }, 'afs-document-page');
    } finally { setSubmitting(false); }
  }

  if (periodError) {
    return (
      <AppLayout>
        <div role="alert" className="max-w-xl mx-auto mt-16 p-4 rounded-lg bg-red-900/20 border border-red-800 text-sm text-red-400">
          {periodError} <Link href="/accounting/afs" className="underline">Back to AFS</Link>
        </div>
      </AppLayout>
    );
  }

  // Nothing document-type-specific renders (no tabs, no tab fetches, no actions) until the document is known.
  if (!doc) {
    return (
      <AppLayout>
        <Head><title>Document | ISAFlow</title></Head>
        {loadError ? (
          <div role="alert" className="max-w-xl mx-auto mt-16 p-4 rounded-lg bg-red-900/20 border border-red-800 text-sm text-red-400">
            {loadError} <Link href="/accounting/afs" className="underline">Back to AFS</Link>
          </div>
        ) : (
          <div role="status" aria-label="Loading document" className="max-w-6xl mx-auto px-6 py-8 space-y-3 animate-pulse">
            <div className="h-6 w-64 rounded bg-slate-200 dark:bg-slate-700" />
            <div className="h-40 rounded-xl bg-slate-200 dark:bg-slate-700" />
          </div>
        )}
      </AppLayout>
    );
  }

  if (doc.documentType === 'management_pack') {
    return (
      // The URL is the same as an AFS document's; this is what lights "Management Packs", not "Annual Financial Statements".
      <AppLayout navPath={`/accounting/afs/${documentId}?type=management_pack`}>
        <Head><title>{`${managementPackTitle(doc.period)} | ISAFlow`}</title></Head>
        <ManagementPackView doc={doc} periodStart={periodStart} periodEnd={periodEnd} />
      </AppLayout>
    );
  }

  const hasPeriod = periodStart !== '' && periodEnd !== '';
  return (
    <AppLayout>
      <Head><title>{`AFS ${doc.fiscalYear ?? periodStart.slice(0, 4)} | ISAFlow`}</title></Head>
      <div className="min-h-screen bg-white dark:bg-slate-900">

        {/* Breadcrumb */}
        <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/accounting/afs" className="hover:text-slate-300 transition-colors">AFS</Link>
            <ChevronRight className="w-3.5 h-3.5" />
            <span className="text-slate-800 dark:text-slate-200 font-medium">
              {doc.documentType === 'afs' ? `AFS ${doc.fiscalYear ?? ''}` : `Pack ${doc.period ?? ''}`}
            </span>
          </div>
        </div>

        {/* Page header */}
        <div className="bg-slate-100 dark:bg-slate-800 border-b border-slate-300 dark:border-slate-700 px-6 py-5">
          <div className="max-w-6xl mx-auto flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">Annual Financial Statements</h1>
                <AfsStatusBadge status={doc.status} />
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {hasPeriod && `Period: ${periodStart} — ${periodEnd}`}
                {`${hasPeriod ? ' · ' : ''}v${doc.version}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {doc.documentType === 'afs' && (
                <Link
                  href={`/accounting/afs/report-templates?document_id=${encodeURIComponent(documentId)}`}
                  className="text-sm text-blue-700 dark:text-blue-400 hover:underline"
                >
                  Report templates for this period
                </Link>
              )}
              {doc.status === 'draft' && (
                <button
                  onClick={() => { void handleSubmitForReview(); }}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  <Send className="w-4 h-4" />
                  Submit for Review
                </button>
              )}
              {(doc.status === 'in_review' || doc.status === 'partner_review') && (
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

        <AfsDocumentTabs
          documentId={documentId} doc={doc} onDocUpdate={setDoc}
          periodStart={periodStart} periodEnd={periodEnd} periodMonths={periodMonths}
        />
      </div>
    </AppLayout>
  );
};

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ query, req, resolvedUrl }) => {
  const documentId = Array.isArray(query.documentId) ? query.documentId[0] : query.documentId;
  if (!documentId) return { notFound: true };

  // Explicit overrides from query always win (e.g. deep links).
  const queryStart = query.period_start as string | undefined;
  const queryEnd = query.period_end as string | undefined;

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let periodMonths: number | null = null;
  let periodError: string | null = null;

  // Otherwise derive the period from the API route — keeps DB access
  // out of the page layer and ensures company_id scoping.
  if (!queryStart || !queryEnd) {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `http://${req.headers.host}`;
      const apiRes = await fetch(
        `${baseUrl}/api/accounting/afs/${documentId}/period`,
        { headers: { cookie: req.headers.cookie ?? '' } },
      );
      if (apiRes.status === 404) return { notFound: true };
      // 401: the session cookie outlived its token. Reloading can never clear a period-error page, and rendering with a guessed year would show the wrong period, so sign in again and come back.
      if (apiRes.status === 401) return { redirect: { destination: `/login?returnTo=${encodeURIComponent(resolvedUrl)}`, permanent: false } };
      // 403: the client load explains the refusal; this is not a failure to work out the period.
      if (apiRes.ok) {
        const json = (await apiRes.json()) as { data?: { periodStart?: string; periodEnd?: string; periodMonths?: number } };
        periodStart  = json.data?.periodStart ?? null;
        periodEnd    = json.data?.periodEnd   ?? null;
        periodMonths = json.data?.periodMonths ?? null;
      } else if (apiRes.status !== 403) {
        periodError = PERIOD_ERROR;
      }
    } catch (err) {
      // Never fall back to the current year for a document whose period is unknown: the page would show the wrong period.
      log.error('Could not resolve the AFS period', { error: err, documentId }, 'afs-document-page');
      periodError = PERIOD_ERROR;
    }
  }

  // No period from the query or the API (a 403): show none rather than guess a calendar year.
  return {
    props: {
      documentId,
      periodStart: queryStart ?? periodStart ?? '',
      periodEnd:   queryEnd   ?? periodEnd   ?? '',
      // The length belongs to the period the API stated; a period given in the query has no known length.
      periodMonths: queryStart || queryEnd ? null : periodMonths,
      periodError,
    },
  };
};

export default AfsDocumentPage;
