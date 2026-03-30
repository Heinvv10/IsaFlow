/**
 * NoteCard — expandable card for a single IFRS Disclosure Note.
 * Used on the Disclosure Notes page.
 */

import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';

interface NoteTable { headers: string[]; rows: string[][] }

interface DisclosureNote {
  noteNumber: number;
  title: string;
  content: string;
  tables?: NoteTable[];
  source: 'auto' | 'manual';
  id?: string;
}

interface NoteCardProps {
  note: DisclosureNote;
  expanded: boolean;
  onToggle: () => void;
  onDelete?: () => void;
}

export function NoteCard({ note, expanded, onToggle, onDelete }: NoteCardProps) {
  return (
    <div className="border border-[var(--ff-border-light)] rounded-lg bg-[var(--ff-bg-secondary)] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--ff-bg-tertiary)] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono bg-teal-500/10 text-teal-400 px-2 py-0.5 rounded">
            {note.noteNumber}
          </span>
          <span className="text-sm font-medium text-[var(--ff-text-primary)]">{note.title}</span>
          {note.source === 'manual' && (
            <span className="text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">Manual</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onDelete && (
            <span
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="text-red-400 hover:text-red-300 p-1 rounded cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
            </span>
          )}
          {expanded
            ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
            : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--ff-border-light)] px-4 py-4 space-y-4">
          <p className="text-sm text-[var(--ff-text-secondary)] whitespace-pre-line leading-relaxed">
            {note.content}
          </p>
          {note.tables?.map((table, ti) => (
            <div key={ti} className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[var(--ff-bg-tertiary)]">
                    {table.headers.map((h, hi) => (
                      <th key={hi} className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium border-b border-[var(--ff-border-light)]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, ri) => (
                    <tr key={ri} className={ri % 2 === 0 ? '' : 'bg-[var(--ff-bg-tertiary)]/40'}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5 text-[var(--ff-text-primary)] border-b border-[var(--ff-border-light)]/50">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
