/**
 * The employee portal's IRP5 copy as a PDF (wave 6 SS-c): one A4 page from a CertificateView (a FILED EMP501
 * version's stored certificate), rendered in memory. It is a copy of the figures the employer filed with SARS, not
 * SARS's own certificate form, and it says so. The ID and tax numbers appear as their last four characters only.
 * The creation date is the version's filing time and the file id comes from the version and certificate, so the same
 * certificate renders to the same bytes.
 */
import { createHash } from 'crypto';
import { COLORS, type JsPdfDoc } from '@/modules/accounting/services/core/pdfShared';
import { money, shortDate } from './payslipFacts';
import type { CertificateLine, CertificateView } from './employeePortalIrp5View';

const MARGIN = 14;
type AutoTable = (doc: JsPdfDoc, opts: Record<string, unknown>) => void;

export const IRP5_COPY_NOTE = 'A copy of the IRP5/IT3(a) figures your employer filed with SARS in its EMP501 reconciliation. '
  + 'It is not the SARS certificate form; your employer can give you that. SARS pre-populates your tax return from what was filed.';

export const kindLabel = (kind: CertificateView['kind']): string =>
  (kind === 'annual' ? 'Annual (March to February)' : 'Interim (March to August)');

function table(doc: JsPdfDoc, autoTable: AutoTable, y: number, title: string, lines: CertificateLine[]): number {
  if (lines.length === 0) return y;
  autoTable(doc, {
    head: [['Code', title, { content: 'Amount', styles: { halign: 'right' } }]],
    body: lines.map((l) => [l.code, l.label, { content: money(l.amount), styles: { halign: 'right' } }]),
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, cellPadding: 1.6, textColor: COLORS.TEXT_PRIMARY },
    headStyles: { fillColor: COLORS.SURFACE, textColor: COLORS.TEXT_PRIMARY, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 16 }, 2: { cellWidth: 40 } },
  });
  return ((doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 4;
}

export async function buildIrp5CopyPdf(c: CertificateView): Promise<Buffer> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc: JsPdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  if (c.filedAt) doc.setCreationDate(new Date(c.filedAt));
  doc.setFileId(createHash('sha256').update(`${c.versionId}:${c.certificateNumber}`).digest('hex').slice(0, 32).toUpperCase());
  const width: number = doc.internal.pageSize.getWidth();
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`IRP5 copy: tax year ${c.taxYear}`, MARGIN, 18);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const facts: Array<[string, string]> = [
    ['Employer', `${c.employer} (PAYE ${c.payeReference})`],
    ['Employee', c.employee],
    ['ID number', c.idNumberLast4 ? `ending ${c.idNumberLast4}` : 'Not on the certificate'],
    ['Tax number', c.taxNumberLast4 ? `ending ${c.taxNumberLast4}` : 'Not on the certificate'],
    ['Certificate', c.certificateNumber],
    ['Reconciliation', kindLabel(c.kind)],
    ['Employed', c.periodTo ? `${shortDate(c.periodFrom)} to ${shortDate(c.periodTo)}` : `from ${shortDate(c.periodFrom)}`],
    ['Filed', c.filedAt ? shortDate(c.filedAt) : 'Not recorded'],
  ];
  let y = 26;
  for (const [k, v] of facts) {
    doc.text(`${k}:`, MARGIN, y);
    doc.text(v, MARGIN + 30, y);
    y += 5;
  }
  y += 2;
  const at = autoTable as unknown as AutoTable;
  y = table(doc, at, y, 'Income', c.income);
  y = table(doc, at, y, 'Deductions', c.deductions);
  y = table(doc, at, y, 'Tax, UIF and SDL', c.tax);
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(IRP5_COPY_NOTE, width - MARGIN * 2), MARGIN, y + 2);
  return Buffer.from(doc.output('arraybuffer'));
}

/** A filename that can only hold safe characters. */
export const irp5CopyFilename = (c: CertificateView): string => `irp5-${c.taxYear}-${c.kind}.pdf`;
