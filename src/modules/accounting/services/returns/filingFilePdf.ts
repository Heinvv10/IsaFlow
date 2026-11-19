/**
 * The EMP201 capture sheet as a PDF (wave 6 EFa, ruling 15): the STORED CSV's rows in one table, with its sha256 in the
 * footer so the printout names the stamped sheet. Rendered in memory; nothing is written to disk. The creation date is
 * the version's finalised_at written in UTC (`D:...+00'00'`, jsPDF's form of `Z`) and the file id the sha256, so a
 * version renders to the same bytes whatever the server's TZ.
 */
import { COLORS, type JsPdfDoc } from '@/modules/accounting/services/core/pdfShared';
import { parseCaptureCsv } from './filingFileContent';

type AutoTable = (doc: JsPdfDoc, opts: Record<string, unknown>) => void;
const MARGIN = 14;

/** finalised_at as a PDF date in UTC, e.g. D:20260403091500+00'00'. */
export function pdfDateUtc(at: string): string {
  const d = new Date(at).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ, always UTC
  return `D:${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}+00'00'`;
}

export async function buildCaptureSheetPdf(csv: string, sha256: string, title: string, finalisedAt: string): Promise<Buffer> {
  const [names = [], ...rows] = parseCaptureCsv(csv);
  const head = names.map((h) => h.charAt(0).toUpperCase() + h.slice(1));
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc: JsPdfDoc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.setCreationDate(pdfDateUtc(finalisedAt));
  doc.setFileId(sha256.slice(0, 32).toUpperCase());
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  doc.text(title, MARGIN, 16);
  (autoTable as unknown as AutoTable)(doc, {
    head: [head.map((h, i) => (i === head.length - 1 ? { content: h, styles: { halign: 'right' } } : h))],
    body: rows.map((r) => r.map((c, i) => (i === r.length - 1 ? { content: c, styles: { halign: 'right' } } : c))),
    startY: 22,
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, cellPadding: 1.6, textColor: COLORS.TEXT_PRIMARY },
    headStyles: { fillColor: COLORS.SURFACE, textColor: COLORS.TEXT_PRIMARY, fontStyle: 'bold' },
    columnStyles: { [head.length - 1]: { cellWidth: 60 } },
  });
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  doc.text(`Capture sheet sha256 ${sha256}. Capture these values on eFiling; IsaFlow sends nothing to SARS.`, MARGIN, pageH - 8);
  return Buffer.from(doc.output('arraybuffer'));
}
