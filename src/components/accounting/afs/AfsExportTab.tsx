// src/components/accounting/afs/AfsExportTab.tsx
// Export options for an AFS document: PDF (WeasyPrint), DOCX, Caseware, disclosure notes TXT.

import React, { useState } from 'react';
import { log } from '@/lib/logger';
import { Download, FileText, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

interface Props {
  documentId: string;
  fiscalYear: number;
}

type ExportState = 'idle' | 'loading' | 'done' | 'error';

interface ExportCard {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

function ExportButton({
  title,
  description,
  icon,
  onExport,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onExport: () => void | Promise<void>;
}) {
  const [state, setState] = useState<ExportState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleClick() {
    setState('loading');
    setErrorMsg('');
    try {
      await Promise.resolve(onExport());
      setState('done');
      // Reset after 3s so it can be triggered again
      setTimeout(() => setState('idle'), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('AFS export failed', { error: err, title }, 'AfsExportTab');
      setErrorMsg(msg);
      setState('error');
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-5 flex flex-col gap-3 bg-white dark:bg-slate-800/50">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-700 shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>
        </div>
      </div>

      {state === 'error' && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-1.5">
          <AlertCircle className="w-3 h-3 shrink-0" />
          {errorMsg}
        </div>
      )}

      <button
        type="button"
        onClick={() => { void handleClick(); }}
        disabled={state === 'loading'}
        className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
          state === 'done'
            ? 'bg-green-600 text-white'
            : state === 'error'
            ? 'bg-red-600 text-white hover:bg-red-700'
            : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
        }`}
      >
        {state === 'loading' && <Loader2 className="w-4 h-4 animate-spin" />}
        {state === 'done' && <CheckCircle className="w-4 h-4" />}
        {state === 'idle' || state === 'error' ? <Download className="w-4 h-4" /> : null}
        {state === 'loading' ? 'Generating…' : state === 'done' ? 'Downloaded' : 'Download'}
      </button>
    </div>
  );
}

function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function AfsExportTab({ documentId, fiscalYear }: Props) {
  const exports: ExportCard[] = [
    {
      id: 'pdf',
      title: 'Download AFS as PDF',
      description: 'Full Annual Financial Statements rendered via WeasyPrint with cover page, notes, and statements.',
      icon: <FileText className="w-5 h-5 text-red-500" />,
      action() {
        triggerDownload(`/api/accounting/afs/${documentId}/export?format=pdf`);
      },
    },
    {
      id: 'docx',
      title: 'Download as Word (.docx)',
      description: 'Editable Microsoft Word document — useful for final formatting before client delivery.',
      icon: <FileText className="w-5 h-5 text-blue-500" />,
      action() {
        triggerDownload(`/api/accounting/afs/${documentId}/export?format=docx`);
      },
    },
    {
      id: 'caseware',
      title: 'Caseware Export Package',
      description: 'Structured Caseware-compatible export of all AFS sections and financial data.',
      icon: <FileText className="w-5 h-5 text-purple-500" />,
      action() {
        triggerDownload(`/api/accounting/afs/${documentId}/export?format=caseware`);
      },
    },
    {
      id: 'notes-txt',
      title: 'Download Disclosure Notes (.txt)',
      description: 'Plain-text export of all IFRS disclosure notes for the fiscal year — useful for audit workpapers.',
      icon: <FileText className="w-5 h-5 text-slate-500" />,
      action() {
        triggerDownload(`/api/accounting/disclosure-notes?year=${fiscalYear}&export=true`);
      },
    },
  ];

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Export AFS Package</h2>
        <p className="text-xs text-slate-500 mt-1">
          Fiscal Year {fiscalYear}. PDF and DOCX exports run pre-export checks — ensure all mandatory sections are reviewed before downloading.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {exports.map(exp => (
          <ExportButton
            key={exp.id}
            title={exp.title}
            description={exp.description}
            icon={exp.icon}
            onExport={exp.action}
          />
        ))}
      </div>

      <div className="mt-6 border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-slate-50 dark:bg-slate-800">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">Pre-export checklist notes</h3>
        <ul className="text-xs text-slate-500 space-y-1 list-disc list-inside">
          <li>PDF export will fail if any blocker compliance checks are unresolved.</li>
          <li>Ensure the document is at minimum <strong>In Review</strong> status before distributing.</li>
          <li>Disclosure notes export does not require sign-off — available at any status.</li>
        </ul>
      </div>
    </div>
  );
}
