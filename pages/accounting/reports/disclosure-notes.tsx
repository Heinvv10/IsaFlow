/**
 * IFRS Disclosure Notes Page — WS-7.2
 * Generate, view and export IFRS disclosure notes for a fiscal year.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, FileText, Loader2, AlertCircle, Download, Plus, Save,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { NoteCard } from '@/components/accounting/NoteCard';

interface DisclosureNote {
  noteNumber: number;
  title: string;
  content: string;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  source: 'auto' | 'manual';
  id?: string;
}

function currentFiscalYear() { return new Date().getFullYear(); }

export default function DisclosureNotesPage() {
  const [year, setYear] = useState(currentFiscalYear());
  const [notes, setNotes] = useState<DisclosureNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedNote, setExpandedNote] = useState<number | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [manualNumber, setManualNumber] = useState(20);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const loadNotes = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/disclosure-notes?year=${year}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load notes');
      setNotes(json.data?.notes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setIsLoading(false);
    }
  }, [year]);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  function handleExport() {
    window.open(`/api/accounting/disclosure-notes?year=${year}&export=true`, '_blank');
  }

  async function handleSaveManual() {
    if (!manualTitle.trim() || !manualContent.trim()) { setSaveError('Title and content are required'); return; }
    setIsSaving(true); setSaveError('');
    try {
      const res = await apiFetch('/api/accounting/disclosure-notes-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiscalYear: year, noteNumber: manualNumber, title: manualTitle, content: manualContent }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to save note');
      setManualTitle(''); setManualContent(''); setManualNumber(20); setShowAddForm(false);
      await loadNotes();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally { setIsSaving(false); }
  }

  async function handleDeleteManual(noteId: string) {
    if (!confirm('Delete this note?')) return;
    const res = await apiFetch(`/api/accounting/disclosure-notes-manual?id=${noteId}`, { method: 'DELETE' });
    if (!res.ok) { setError('Failed to delete note'); return; }
    await loadNotes();
  }

  const yearOptions = Array.from({ length: 10 }, (_, i) => currentFiscalYear() - i);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reports
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <FileText className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">IFRS Disclosure Notes</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">Auto-generated notes from financial data</p>
                </div>
              </div>
              <button onClick={handleExport} disabled={notes.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export TXT
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          <div className="flex items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Fiscal Year</label>
              <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))}
                className="ff-input text-sm min-w-[120px]">
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button onClick={() => void loadNotes()}
              className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
              Generate Notes
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          ) : (
            <div className="space-y-3">
              {notes.map(note => (
                <NoteCard
                  key={`${note.source}-${note.noteNumber}`}
                  note={note}
                  expanded={expandedNote === note.noteNumber}
                  onToggle={() => setExpandedNote(n => n === note.noteNumber ? null : note.noteNumber)}
                  onDelete={note.source === 'manual' && note.id ? () => handleDeleteManual(note.id!) : undefined}
                />
              ))}
              {notes.length === 0 && !isLoading && (
                <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                  No notes generated. Select a year and click Generate Notes.
                </div>
              )}
            </div>
          )}

          {/* Manual Note Form */}
          <div className="border border-[var(--ff-border-light)] rounded-lg bg-[var(--ff-bg-secondary)]">
            <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Manual Notes</h3>
              <button onClick={() => setShowAddForm(v => !v)}
                className="inline-flex items-center gap-1 text-xs text-teal-500 hover:text-teal-400">
                <Plus className="h-3 w-3" /> Add Note
              </button>
            </div>
            {showAddForm && (
              <div className="p-4 space-y-4">
                {saveError && (
                  <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 text-red-400 text-xs">
                    <AlertCircle className="h-3 w-3" /> {saveError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Note Number</label>
                    <input type="number" min={8} max={99} value={manualNumber}
                      onChange={e => setManualNumber(parseInt(e.target.value, 10))}
                      className="ff-input text-sm w-full" />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Title</label>
                    <input type="text" value={manualTitle} onChange={e => setManualTitle(e.target.value)}
                      placeholder="e.g. Subsequent Events" className="ff-input text-sm w-full" maxLength={200} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Content</label>
                  <textarea value={manualContent} onChange={e => setManualContent(e.target.value)}
                    rows={6} className="ff-input text-sm w-full resize-y"
                    placeholder="Enter note content..." />
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => void handleSaveManual()} disabled={isSaving}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                    {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Save Note
                  </button>
                  <button onClick={() => setShowAddForm(false)}
                    className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
