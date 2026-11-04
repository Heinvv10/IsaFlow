// src/components/accounting/afs/ManagementPackViewer.tsx
// Read-only view of a management pack's stored sections, in sortOrder.
// Pack section keys (budget_variance, ai_executive_summary, ...) extend beyond the AFS SectionType union,
// so the key is treated as a plain string here.

import React from 'react';
import type { AfsSection, NoteContent, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

function readable(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A pack stores the section key as the title when the generator has no wording for it. */
function sectionTitle(section: AfsSection): string {
  const key: string = section.sectionType;
  const title = section.overrides?.title ?? section.content?.title;
  return title && title !== key ? title : readable(key);
}

function Block({ block }: { block: NoteContentBlock }) {
  switch (block.type) {
    case 'heading':
      return <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{block.text}</h3>;
    case 'paragraph':
      return <p className="text-sm text-slate-700 dark:text-slate-300">{block.text}</p>;
    case 'list':
      return <ul className="list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">{block.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-300 dark:border-slate-600 text-left text-slate-600 dark:text-slate-400">
                {block.headers.map((h, i) => <th key={i} className={`py-1.5 pr-4 font-medium ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200">
                  {row.map((cell, c) => <td key={c} className={`py-1.5 pr-4 ${c > 0 ? 'text-right tabular-nums' : ''}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function blocksOf(content: NoteContent | null): NoteContentBlock[] {
  return Array.isArray(content?.blocks) ? content.blocks : [];
}

export function ManagementPackViewer({ sections }: { sections: AfsSection[] }) {
  const ordered = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
  if (ordered.length === 0) {
    return <p className="text-sm text-ink-muted">This pack has no sections.</p>;
  }
  return (
    <div className="space-y-6">
      {ordered.map(section => (
        <section key={section.id} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 space-y-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">{sectionTitle(section)}</h2>
          {blocksOf(section.overrides?.blocks ? { title: '', blocks: section.overrides.blocks } : section.content)
            .map((block, i) => <Block key={i} block={block} />)}
          {section.aiNarrative && (
            <p className="text-sm italic text-slate-600 dark:text-slate-400">{section.aiNarrative}</p>
          )}
        </section>
      ))}
    </div>
  );
}
