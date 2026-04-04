/**
 * Credit Note PDF Builder — generates Credit Note PDFs using jsPDF + jspdf-autotable.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtZAR, fmtDate, TEAL, getCompanyDetailsFromCompany, renderPageFooters } from './pdfShared';

type Row = Record<string, unknown>;

interface CreditNoteRow {
  credit_note_number: string;
  credit_date: string | Date;
  original_invoice_number: string | null;
  type: string;
  reason: string | null;
  status: string;
  client_name: string | null;
  client_address: string | null;
  client_vat: string | null;
  supplier_name: string | null;
  approved_by: string | null;
  approved_at: string | Date | null;
  subtotal: unknown;
  tax_amount: unknown;
  total_amount: unknown;
  tax_rate: unknown;
}

export async function generateCreditNotePdf(companyId: string, creditNoteId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);

  const rows = (await sql`
    SELECT cn.*,
           c.name AS client_name,
           c.email AS client_email,
           c.phone AS client_phone,
           c.vat_number AS client_vat,
           c.billing_address AS client_address,
           c.contact_person AS client_contact,
           s.name AS supplier_name,
           ci.invoice_number AS original_invoice_number
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = COALESCE(cn.client_id, cn.customer_id)
    LEFT JOIN suppliers s ON s.id = cn.supplier_id
    LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
    WHERE cn.id = ${creditNoteId}::UUID
  `) as Row[];

  if (rows.length === 0) throw new Error(`Credit note not found: ${creditNoteId}`);
  const cn = rows[0]! as unknown as CreditNoteRow;

  log.info('Generating credit note PDF', {
    creditNoteId,
    creditNoteNumber: cn.credit_note_number,
  }, 'creditNotePdfBuilder');

  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // Header bar
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(0, 0, PAGE_W, 28, 'F');
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('CREDIT NOTE', MARGIN, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(cn.credit_note_number || '', PAGE_W - MARGIN, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.text(`Date: ${fmtDate(cn.credit_date)}`, PAGE_W - MARGIN, 18, { align: 'right' });
  if (cn.original_invoice_number) {
    doc.text(`Ref: ${cn.original_invoice_number}`, PAGE_W - MARGIN, 23, { align: 'right' });
  }

  let y = 36;

  // Company details (left)
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
  doc.text(COMPANY.name, MARGIN, y);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
  y += 5; doc.text(COMPANY.address, MARGIN, y);
  y += 4; doc.text(`VAT No: ${COMPANY.vatNumber}`, MARGIN, y);
  y += 4; doc.text(`Email: ${COMPANY.email}`, MARGIN, y);

  // Recipient details (right)
  const rightX = PAGE_W / 2 + 10;
  let ry = 36;
  const entityName = cn.type === 'customer' ? cn.client_name : cn.supplier_name;

  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('CREDIT TO:', rightX, ry); ry += 5;
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
  doc.text(entityName || 'Unknown', rightX, ry); ry += 5;
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);

  if (cn.type === 'customer') {
    if (cn.client_address) {
      for (const line of String(cn.client_address).split('\n')) {
        doc.text(line.trim(), rightX, ry); ry += 4;
      }
    }
    if (cn.client_vat) { doc.text(`VAT No: ${cn.client_vat}`, rightX, ry); ry += 4; }
  }

  y = Math.max(y, ry) + 8;

  // Credit note details table
  autoTable(doc, {
    startY: y,
    body: [
      ['Credit Note Number', cn.credit_note_number || '—'],
      ['Type', cn.type === 'customer' ? 'Customer Credit Note' : 'Supplier Credit Note'],
      ['Credit Date', fmtDate(cn.credit_date)],
      ['Original Invoice', cn.original_invoice_number || '—'],
      ['Reason', cn.reason || '—'],
    ],
    styles: { fontSize: 8, cellPadding: 3 },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 45, textColor: [80, 80, 80] },
      1: { cellWidth: 'auto' },
    },
    theme: 'plain',
    tableWidth: CONTENT_W,
    margin: { left: MARGIN, right: MARGIN },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable?.finalY || y + 30;
  y += 6;

  // Totals table
  const subtotal = Number(cn.subtotal || 0);
  const taxAmount = Number(cn.tax_amount || 0);
  const totalAmount = Number(cn.total_amount || 0);

  autoTable(doc, {
    startY: y,
    body: [
      ['Subtotal', fmtZAR(subtotal)],
      [`VAT (${Number(cn.tax_rate || 15)}%)`, fmtZAR(taxAmount)],
      ['Total Credit', fmtZAR(totalAmount)],
    ],
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { halign: 'right', fontStyle: 'bold', cellWidth: CONTENT_W - 40 },
      1: { halign: 'right', cellWidth: 40, fontStyle: 'bold' },
    },
    theme: 'plain',
    tableWidth: CONTENT_W,
    margin: { left: MARGIN, right: MARGIN },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didParseCell: (data: any) => {
      if (data.row.index === 2) {
        data.cell.styles.fillColor = [TEAL.r, TEAL.g, TEAL.b];
        data.cell.styles.textColor = [255, 255, 255];
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable?.finalY || y + 30;
  y += 10;

  // Status badge
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(80, 80, 80);
  doc.text(`Status: ${(cn.status || 'draft').toUpperCase()}`, MARGIN, y);
  if (cn.approved_by) {
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.text(`Approved by: ${cn.approved_by} on ${fmtDate(cn.approved_at)}`, MARGIN, y);
  }

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);

  return Buffer.from(doc.output('arraybuffer'));
}
