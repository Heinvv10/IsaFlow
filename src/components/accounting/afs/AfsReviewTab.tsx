// src/components/accounting/afs/AfsReviewTab.tsx
// Sign-off trail, section-level comments and workflow actions for an AFS document.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { AfsDocument, AfsSection, AfsSectionComment } from '@/modules/accounting/services/afs/afsTypes';
import { useAuth } from '@/contexts/AuthContext';
import {
  CheckCircle, Clock, Lock, MessageSquare, Send, AlertCircle, Loader2, User,
} from 'lucide-react';

interface Props {
  documentId: string;
  doc: AfsDocument | null;
  onDocUpdate: (updated: AfsDocument) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: Date | string | null): string {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft:          <Clock className="w-4 h-4 text-slate-400" />,
  in_review:      <Clock className="w-4 h-4 text-blue-400" />,
  partner_review: <Clock className="w-4 h-4 text-yellow-400" />,
  signed_off:     <CheckCircle className="w-4 h-4 text-green-400" />,
  filed:          <Lock className="w-4 h-4 text-purple-400" />,
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', in_review: 'In Review', partner_review: 'Partner Review',
  signed_off: 'Signed Off', filed: 'Filed',
};

// ── Section Comments Panel ────────────────────────────────────────────────────

function SectionCommentsPanel({ documentId, section }: {
  documentId: string;
  section: AfsSection;
}) {
  const [comments, setComments] = useState<AfsSectionComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  const loadComments = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/accounting/afs/${documentId}/sections/${section.id}/comments`,
        { credentials: 'include' }
      );
      const json = await res.json() as { data: { items: AfsSectionComment[] } };
      setComments(json.data.items ?? []);
    } catch (err) {
      log.warn('Failed to load comments', { error: err, sectionId: section.id }, 'AfsReviewTab');
    } finally {
      setLoading(false);
    }
  }, [documentId, section.id]);

  useEffect(() => { void loadComments(); }, [loadComments]);

  async function handlePost() {
    if (!body.trim()) return;
    setPosting(true); setPostError('');
    try {
      const res = await apiFetch(
        `/api/accounting/afs/${documentId}/sections/${section.id}/comments`,
        {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: body.trim() }),
        }
      );
      const json = await res.json() as { data?: AfsSectionComment; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      if (json.data) setComments(prev => [...prev, json.data as AfsSectionComment]);
      setBody('');
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  }

  const statusColor: Record<string, string> = {
    pending: 'bg-slate-100 dark:bg-slate-800 text-slate-500',
    auto_generated: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    ai_enhanced: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
    reviewed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
    signed_off: 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400',
  };

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg mb-3 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-50 dark:bg-slate-800">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 capitalize">
          {section.sectionType.replace(/_/g, ' ')}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[section.status] ?? ''}`}>
          {section.status.replace(/_/g, ' ')}
        </span>
      </div>

      {loading ? (
        <div className="px-4 py-3 text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {comments.length > 0 && (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-48 overflow-y-auto">
              {comments.map(c => (
                <div key={c.id} className={`px-4 py-2 ${c.resolved ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <User className="w-3 h-3 text-slate-400" />
                    <span className="text-xs text-slate-500">{fmtDate(c.createdAt)}</span>
                    {c.resolved && <span className="text-xs text-green-500">resolved</span>}
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300">{c.body}</p>
                </div>
              ))}
            </div>
          )}

          <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex gap-2">
            <input
              type="text"
              placeholder="Add comment…"
              value={body}
              onChange={e => setBody(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePost(); } }}
              className="flex-1 text-sm bg-transparent border-0 outline-none text-slate-800 dark:text-slate-200 placeholder-slate-400"
            />
            <button
              type="button"
              onClick={() => { void handlePost(); }}
              disabled={posting || !body.trim()}
              className="p-1 text-blue-500 hover:text-blue-400 disabled:opacity-40"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          {postError && <p className="px-4 pb-2 text-xs text-red-400">{postError}</p>}
        </>
      )}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────

export function AfsReviewTab({ documentId, doc, onDocUpdate }: Props) {
  const { user } = useAuth();
  const [sections, setSections] = useState<AfsSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSectionsLoading(true);
    apiFetch(`/api/accounting/afs/${documentId}`, { credentials: 'include' })
      .then(r => r.json() as Promise<{ data: { document: AfsDocument & { sections: AfsSection[] } } }>)
      .then(json => {
        if (!cancelled) setSections(json.data.document.sections ?? []);
      })
      .catch((err: unknown) => log.warn('Failed to load sections', { error: err }, 'AfsReviewTab'))
      .finally(() => { if (!cancelled) setSectionsLoading(false); });
    return () => { cancelled = true; };
  }, [documentId]);

  const canSignOff = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';

  async function handleWorkflow(action: string) {
    setSubmitting(true); setWorkflowError('');
    try {
      const res = await apiFetch(`/api/accounting/afs/${documentId}/workflow`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json() as { data?: { document: AfsDocument }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      if (json.data?.document) onDocUpdate(json.data.document);
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : 'Action failed');
      log.error('Workflow action failed', { error: err, action }, 'AfsReviewTab');
    } finally {
      setSubmitting(false);
    }
  }

  const signedOffCount = sections.filter(s => s.status === 'signed_off').length;
  const reviewedCount = sections.filter(s => s.status === 'reviewed' || s.status === 'signed_off').length;
  const totalSections = sections.length;

  return (
    <div className="max-w-3xl">
      {/* Document status summary */}
      <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 mb-6">
        <div className="flex items-center gap-3 mb-3">
          {doc && STATUS_ICONS[doc.status]}
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Status: {doc ? STATUS_LABELS[doc.status] : '—'}
            </h2>
            {doc?.lockedAt && (
              <p className="text-xs text-slate-500 mt-0.5">
                Signed off {fmtDate(doc.lockedAt)} · v{doc.version}
              </p>
            )}
          </div>
        </div>

        {totalSections > 0 && (
          <div className="text-xs text-slate-500 space-y-1">
            <p>{reviewedCount}/{totalSections} sections reviewed</p>
            <p>{signedOffCount}/{totalSections} sections signed off</p>
          </div>
        )}

        {workflowError && (
          <div className="mt-3 flex items-center gap-2 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {workflowError}
          </div>
        )}

        {doc?.status === 'draft' && canSignOff && (
          <button
            type="button"
            onClick={() => { void handleWorkflow('submit_for_review'); }}
            disabled={submitting}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Send className="w-4 h-4" /> Submit for Review
          </button>
        )}

        {(doc?.status === 'in_review' || doc?.status === 'partner_review') && canSignOff && (
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => { void handleWorkflow('sign_off'); }}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" /> Sign Off Document
            </button>
          </div>
        )}
      </div>

      {/* Section comments */}
      <div>
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3 flex items-center gap-2">
          <MessageSquare className="w-4 h-4" /> Section Comments
        </h3>
        {sectionsLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading sections…
          </div>
        ) : sections.length === 0 ? (
          <p className="text-sm text-slate-400">No sections found for this document.</p>
        ) : (
          sections.map(s => (
            <SectionCommentsPanel key={s.id} documentId={documentId} section={s} />
          ))
        )}
      </div>
    </div>
  );
}
