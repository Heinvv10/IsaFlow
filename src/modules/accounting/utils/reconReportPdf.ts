/**
 * Bank Reconciliation PDF Report Generator
 * Produces a landscape A4 PDF containing matched and unmatched transaction
 * tables alongside a summary of statement vs GL balances.
 *
 * Dependencies: jsPDF + jspdf-autotable (already in package.json)
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single transaction line in the reconciliation report */
export interface ReconTx {
  date: string;
  description: string;
  amount: number;
  reference?: string;
  journalRef?: string;
}

/** Full data payload passed to generateReconReport */
export interface ReconReportData {
  bankAccountName: string;
  statementDate: string;
  openingBalance?: number;
  closingBalance?: number;
  glBalance?: number;
  matchedTransactions: ReconTx[];
  unmatchedTransactions: ReconTx[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ZAR currency formatter — 2 decimal places */
const fmtZAR = (amount: number): string =>
  new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

/** ISO date string → DD/MM/YYYY */
const fmtDate = (d: string): string => {
  if (!d) return '—';
  const parts = d.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
};

/** Soft-truncate a string to avoid cell overflow */
const trunc = (s: string | undefined, max = 60): string => {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// ─── Header Painter ───────────────────────────────────────────────────────────

function paintHeader(doc: jsPDF, bankAccountName: string, statementDate: string): void {
  const PAGE_W = doc.internal.pageSize.getWidth();

  // Title
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text('Bank Reconciliation Report', 14, 16);

  // Subtitle row
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  doc.text(`Account: ${bankAccountName}`, 14, 23);
  doc.text(`Statement Date: ${statementDate}`, 14, 29);

  // Generated timestamp — right-aligned
  const generated = `Generated: ${new Date().toLocaleString('en-ZA')}`;
  doc.text(generated, PAGE_W - 14, 23, { align: 'right' });

  // Horizontal rule
  doc.setDrawColor(200, 200, 200);
  doc.line(14, 33, PAGE_W - 14, 33);
}

// ─── Summary Box ─────────────────────────────────────────────────────────────

function paintSummaryBox(
  doc: jsPDF,
  data: Pick<ReconReportData, 'openingBalance' | 'closingBalance' | 'glBalance'>,
  startY: number
): number {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const BOX_H = 28;
  const COL = (PAGE_W - 28) / 4;

  // Box background
  doc.setFillColor(245, 247, 250);
  doc.setDrawColor(210, 215, 225);
  doc.roundedRect(14, startY, PAGE_W - 28, BOX_H, 2, 2, 'FD');

  const labelY = startY + 9;
  const valueY = startY + 20;

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);

  const cols = [
    { label: 'Opening Balance', value: data.openingBalance },
    { label: 'Closing Balance', value: data.closingBalance },
    { label: 'GL Balance', value: data.glBalance },
    { label: 'Difference', value: null as number | null | undefined },
  ];

  // Compute difference
  if (
    data.closingBalance !== undefined && data.closingBalance !== null &&
    data.glBalance !== undefined && data.glBalance !== null
  ) {
    cols[3]!.value = data.closingBalance - data.glBalance;
  }

  cols.forEach((col, i) => {
    const x = 14 + COL * i + COL / 2;
    doc.text(col.label, x, labelY, { align: 'center' });

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');

    const isDiff = i === 3;
    const isZero = isDiff && col.value !== null && col.value !== undefined && Math.abs(col.value) < 0.01;

    if (isDiff && !isZero && col.value !== null && col.value !== undefined) {
      doc.setTextColor(180, 100, 0);
    } else if (isDiff && isZero) {
      doc.setTextColor(22, 163, 74);
    } else {
      doc.setTextColor(30, 30, 30);
    }

    doc.text(
      col.value !== null && col.value !== undefined ? fmtZAR(col.value) : '—',
      x, valueY, { align: 'center' }
    );

    // Reset font/color for next iteration
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
  });

  return startY + BOX_H + 6;
}

// ─── Section Painter ─────────────────────────────────────────────────────────

function paintSection(
  doc: jsPDF,
  title: string,
  rows: ReconTx[],
  startY: number,
  includeJournalRef: boolean
): number {
  const PAGE_W = doc.internal.pageSize.getWidth();

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(title, 14, startY + 5);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`(${rows.length} transaction${rows.length !== 1 ? 's' : ''})`, 14 + doc.getTextWidth(title) + 4, startY + 5);

  if (rows.length === 0) {
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('No transactions in this category.', 14, startY + 14);
    return startY + 22;
  }

  const columns = [
    { header: 'Date', dataKey: 'date' },
    { header: 'Description', dataKey: 'description' },
    { header: 'Reference', dataKey: 'reference' },
    { header: 'Amount (ZAR)', dataKey: 'amount' },
    ...(includeJournalRef ? [{ header: 'Journal Ref', dataKey: 'journalRef' }] : []),
  ];

  const tableRows = rows.map(tx => ({
    date: fmtDate(tx.date),
    description: trunc(tx.description, 55),
    reference: tx.reference ? trunc(tx.reference, 25) : '—',
    amount: fmtZAR(tx.amount),
    ...(includeJournalRef ? { journalRef: tx.journalRef ? trunc(tx.journalRef, 20) : '—' } : {}),
  }));

  autoTable(doc, {
    startY: startY + 9,
    head: [columns.map(c => c.header)],
    body: tableRows.map(r => columns.map(c => (r as Record<string, string>)[c.dataKey] ?? '—')),
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [41, 82, 140], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      3: { halign: 'right', font: 'courier' },
    },
    tableWidth: PAGE_W - 28,
    margin: { left: 14, right: 14 },
    didDrawPage: () => {
      // Re-paint header on continuation pages
      paintHeader(doc, '', '');
    },
  });

  return (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
}

// ─── Footer Painter ───────────────────────────────────────────────────────────

function paintFooters(doc: jsPDF): void {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const totalPages = (doc as jsPDF & { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150, 150, 150);
    doc.line(14, PAGE_H - 10, PAGE_W - 14, PAGE_H - 10);
    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - 14, PAGE_H - 5, { align: 'right' });
    doc.text('FibreFlow Bank Reconciliation Report — Confidential', 14, PAGE_H - 5);
  }
}

// ─── Main Export Function ─────────────────────────────────────────────────────

/**
 * Generate a landscape A4 PDF reconciliation report and return it as a Blob.
 * Call `URL.createObjectURL(blob)` to download in the browser.
 */
// 🟢 WORKING: generateReconReport
export function generateReconReport(data: ReconReportData): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  // Page 1 header
  paintHeader(doc, data.bankAccountName, data.statementDate);

  // Summary box
  let cursor = paintSummaryBox(doc, data, 37);

  // Matched transactions section
  cursor = paintSection(doc, 'Matched Transactions', data.matchedTransactions, cursor, true);

  // Unmatched transactions section
  paintSection(doc, 'Unmatched Transactions', data.unmatchedTransactions, cursor, false);

  // Page numbers across all pages
  paintFooters(doc);

  return doc.output('blob');
}
