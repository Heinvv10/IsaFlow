// src/components/accounting/afs/AfsNotesTab.tsx
// Inline IFRS disclosure notes for an AFS document's fiscal year.

import React, { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { DisclosureNote, NoteTable } from '@/modules/accounting/services/reports/disclosureNoteService';
import { Loader2, AlertCircle, BookOpen } from 'lucide-react';

interface Props {
  fiscalYear: number;
}

function NoteTableBlock({ table }: { table: NoteTable }) {
  return (
    <div className="overflow-x-auto mt-3 mb-2">
      <table className="w-full text-xs border-collapse border border-slate-300 dark:border-slate-700">
        <thead>
          <tr className="bg-slate-200 dark:bg-slate-700">
            {table.headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-600">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'bg-white dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-800/50'}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteCard({ note }: { note: DisclosureNote }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-center justify-between px-5 py-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-left"
      >
        <span className="font-semibold text-slate-900 dark:text-white text-sm">
          Note {note.noteNumber}: {note.title}
          {note.source === 'manual' && (
            <span className="ml-2 px-1.5 py-0.5 text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded">Manual</span>
          )}
        </span>
        <span className="text-slate-400 text-xs">{expanded ? 'collapse' : 'expand'}</span>
      </button>
      {expanded && (
        <div className="px-5 py-4 bg-white dark:bg-slate-900">
          <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{note.content}</p>
          {note.tables?.map((tbl, i) => <NoteTableBlock key={i} table={tbl} />)}
        </div>
      )}
    </div>
  );
}

export function AfsNotesTab({ fiscalYear }: Props) {
  const [notes, setNotes] = useState<DisclosureNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch(`/api/accounting/disclosure-notes?year=${fiscalYear}`, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ data: { notes: DisclosureNote[] } }>;
      })
      .then(json => {
        if (!cancelled) {
          setNotes(json.data.notes ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          log.warn('Failed to load disclosure notes', { error: err, fiscalYear }, 'AfsNotesTab');
          setError(err instanceof Error ? err.message : 'Failed to load notes');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [fiscalYear]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading disclosure notes for {fiscalYear}…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-red-900/20 border border-red-800 text-sm text-red-400">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (notes.length === 0) {
    return (
      <div className="py-16 text-center text-slate-500 dark:text-slate-400">
        <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">No disclosure notes generated for {fiscalYear}.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">Notes to the Financial Statements</h2>
          <p className="text-xs text-slate-500 mt-0.5">IFRS for SMEs — Fiscal Year {fiscalYear} · {notes.length} note{notes.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      {notes.map(note => <NoteCard key={note.noteNumber} note={note} />)}
    </div>
  );
}
