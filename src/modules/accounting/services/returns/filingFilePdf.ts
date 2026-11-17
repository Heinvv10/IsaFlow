/**
 * The EMP201 capture sheet as a PDF (wave 6 EFa, ruling 15): the stamped CSV's rows in one table, with the CSV's
 * sha256 in the footer so the printout names the stamped sheet. Rendered in memory; nothing is written to disk. The
 * creation date is the version's finalised_at and the file id its sha256, so a version renders to the same bytes.
 */
import { COLORS, type JsPdfDoc } from '@/modules/accounting/services/core/pdfShared';
import type { CaptureSheet } from './filingFileContent';

type AutoTable = (doc: JsPdfDoc, opts: Record<string, unknown>) => void;
const MARGIN = 14;

export async function buildCaptureSheetPdf(sheet: CaptureSheet, title: string, finalisedAt: string): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc: JsPdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.setCreationDate(new Date(finalisedAt));
  doc.setFileId(sheet.sha256.slice(0, 32).toUpperCase());
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  doc.text(title, MARGIN, 16);
  (autoTable as unknown as AutoTable)(doc, {
    head: [['Section', 'Field', { content: 'Amount', styles: { halign: 'right' } }]],
    body: sheet.rows.map(([section, label, value]) => [section, label, { content: value, styles: { halign: 'right' } }]),
    startY: 22,
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, cellPadding: 1.6, textColor: COLORS.TEXT_PRIMARY },
    headStyles: { fillColor: COLORS.SURFACE, textColor: COLORS.TEXT_PRIMARY, fontStyle: 'bold' },
    columnStyles: { 2: { cellWidth: 60 } },
  });
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  doc.text(`Capture sheet sha256 ${sheet.sha256}. Capture these values on eFiling; IsaFlow sends nothing to SARS.`, MARGIN, pageH - 8);
  return Buffer.from(doc.output('arraybuffer'));
}
