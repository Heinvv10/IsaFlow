/**
 * FirstBankImportWizard — modal shown before first bank statement import.
 * Covers supported formats, column mapping, and tips.
 * Dismissed via user_preferences key: first_bank_import_wizard_dismissed
 */

import { useEffect, useState } from 'react';
import { FileText, CheckCircle, Download } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useFirstUseWizard } from '@/hooks/useFirstUseWizard';

const WIZARD_KEY = 'first_bank_import_wizard';

const SAMPLE_CSV = `Date,Description,Amount
01/04/2026,Opening Balance,10000.00
02/04/2026,FNB Salary Payment,-5000.00
03/04/2026,Client Payment Received,2500.00`;

function FormatBadge({ format, description }: { format: string; description: string }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-100 dark:bg-gray-700/50">
      <div className="mt-0.5 w-12 shrink-0 text-center">
        <span className="text-xs font-bold text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/40 px-2 py-0.5 rounded">
          {format}
        </span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-300">{description}</p>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
      <CheckCircle className="w-4 h-4 text-teal-500 shrink-0 mt-0.5" />
      <span>{children}</span>
    </li>
  );
}

export function FirstBankImportWizard() {
  const { shouldShow, dismiss, loading } = useFirstUseWizard(WIZARD_KEY);
  const [sampleUrl, setSampleUrl] = useState('#');

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
    setSampleUrl(url);
    return () => URL.revokeObjectURL(url);
  }, []);

  if (loading || !shouldShow) return null;

  return (
    <Modal open title="Importing Your Bank Statement" onClose={dismiss} size="lg">
      <Modal.Body className="space-y-5">
        {/* Supported formats */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Supported Formats
          </p>
          <div className="space-y-2">
            <FormatBadge
              format="CSV"
              description="Comma-separated values. Export from your internet banking or use our sample template."
            />
            <FormatBadge
              format="OFX"
              description="Open Financial Exchange — widely supported by South African banks for direct export."
            />
            <FormatBadge
              format="QIF"
              description="Quicken Interchange Format — supported by most legacy banking systems."
            />
          </div>
        </div>

        {/* CSV column mapping */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            CSV Column Mapping
          </p>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-100 dark:bg-gray-700">
                  <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-300 font-semibold">Column</th>
                  <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-300 font-semibold">Description</th>
                  <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-300 font-semibold">Example</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                <tr>
                  <td className="px-3 py-2 text-teal-600 dark:text-teal-400 font-medium">Date</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300">Transaction date</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-mono">01/04/2026</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 text-teal-600 dark:text-teal-400 font-medium">Description</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300">Payee / narration</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-mono">FNB Salary Payment</td>
                </tr>
                <tr>
                  <td className="px-3 py-2 text-teal-600 dark:text-teal-400 font-medium">Amount</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300">Negative = debit, positive = credit</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-mono">-5000.00</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Tips */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Tips for Success
          </p>
          <ul className="space-y-2">
            <Tip>Make sure your CSV file includes a header row (Date, Description, Amount)</Tip>
            <Tip>Date format should be DD/MM/YYYY — e.g. 01/04/2026</Tip>
            <Tip>Debits should be negative amounts, credits positive</Tip>
            <Tip>Remove any summary rows (totals) before importing</Tip>
          </ul>
        </div>

        {/* Sample download */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800">
          <FileText className="w-5 h-5 text-teal-600 dark:text-teal-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-teal-800 dark:text-teal-200">Need a starting point?</p>
            <p className="text-xs text-teal-600 dark:text-teal-400">Download our sample CSV to see the expected format.</p>
          </div>
          <a
            href={sampleUrl}
            download="isaflow-sample-statement.csv"
            className="flex items-center gap-1 text-xs text-teal-700 dark:text-teal-300 font-medium hover:text-teal-900 dark:hover:text-teal-100 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button size="sm" onClick={dismiss}>
          Got it, let&apos;s import
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
