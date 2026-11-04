// src/components/accounting/afs/AfsDocumentTabs.tsx
// The AFS-only tab bar and its tab content. A management pack never renders this: its tabs would fetch AFS statements.

import React, { useState } from 'react';
import { useRouter } from 'next/router';
import { CheckCircle, FileText, BarChart2, BookOpen, ShieldCheck, Download } from 'lucide-react';
import type { AfsDocument } from '@/modules/accounting/services/afs/afsTypes';
import { AfsOverviewTab } from './AfsOverviewTab';
import { AfsNotesTab } from './AfsNotesTab';
import { AfsStatementsTab } from './AfsStatementsTab';
import { AfsReviewTab } from './AfsReviewTab';
import { AfsExportTab } from './AfsExportTab';

type TabId = 'overview' | 'notes' | 'statements' | 'review' | 'compliance' | 'export';

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'overview',    label: 'Overview',    icon: <FileText className="w-4 h-4" /> },
  { id: 'notes',       label: 'Notes',       icon: <BookOpen className="w-4 h-4" /> },
  { id: 'statements',  label: 'Statements',  icon: <BarChart2 className="w-4 h-4" /> },
  { id: 'review',      label: 'Review',      icon: <CheckCircle className="w-4 h-4" /> },
  { id: 'compliance',  label: 'Compliance',  icon: <ShieldCheck className="w-4 h-4" /> },
  { id: 'export',      label: 'Export',      icon: <Download className="w-4 h-4" /> },
];

interface Props {
  documentId: string;
  doc: AfsDocument;
  onDocUpdate: (doc: AfsDocument) => void;
  periodStart: string;
  periodEnd: string;
  periodMonths: number | null;
}

export function AfsDocumentTabs({ documentId, doc, onDocUpdate, periodStart, periodEnd, periodMonths }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  // Empty when the server could not state the period (a 403): nothing period-bound is shown then.
  const hasPeriod = periodStart !== '' && periodEnd !== '';
  const fiscalYear = doc.fiscalYear ?? Number(periodStart.slice(0, 4));
  return (
    <>
      <div className="bg-slate-100 dark:bg-slate-800 border-b border-slate-300 dark:border-slate-700 px-6">
        <div className="max-w-6xl mx-auto flex gap-0 overflow-x-auto">
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
              className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${ activeTab === tab.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-ink-muted hover:text-slate-200' }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-6 py-8">
        {hasPeriod && activeTab === 'overview' && (
          <AfsOverviewTab documentId={documentId} periodStart={periodStart} periodEnd={periodEnd} periodMonths={periodMonths} />
        )}
        {hasPeriod && activeTab === 'notes' && <AfsNotesTab fiscalYear={fiscalYear} />}
        {hasPeriod && activeTab === 'statements' && <AfsStatementsTab periodStart={periodStart} periodEnd={periodEnd} />}
        {activeTab === 'review' && <AfsReviewTab documentId={documentId} doc={doc} onDocUpdate={onDocUpdate} />}
        {hasPeriod && activeTab === 'export' && <AfsExportTab documentId={documentId} fiscalYear={fiscalYear} />}
      </div>
    </>
  );
}
