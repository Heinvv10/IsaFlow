/**
 * Invoice PDF Builder — generates Tax Invoice PDFs using jsPDF + jspdf-autotable.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtZAR, fmtDate, TEAL, getCompanyDetailsFromCompany, renderPageFooters } from './pdfShared';

type Row = Record<string, unknown>;

interface InvoiceRow {
  invoice_number: string;
  invoice_date: string | Date;
  due_date: string | Date | null;
  billing_period_start: string | Date | null;
  billing_period_end: string | Date | null;
  client_name: string | null;
  client_address: string | null;
  client_contact: string | null;
  client_email: string | null;
  client_phone: string | null;
  client_vat: string | null;
  project_name: string | null;
  subtotal: unknown;
  tax_amount: unknown;
  total_amount: unknown;
  amount_paid: unknown;
  tax_rate: unknown;
  notes: string | null;
}


export async function generateInvoicePdf(companyId: string, invoiceId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);

  const invoiceRows = (await sql`
    SELECT ci.*,
           c.name AS client_name,
           c.email AS client_email,
           c.phone AS client_phone,
           c.vat_number AS client_vat,
           c.billing_address AS client_address,
           c.contact_person AS client_contact,
           p.name AS project_name
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    LEFT JOIN projects p ON p.id = ci.project_id
    WHERE ci.id = ${invoiceId}::UUID
  `) as Row[];

  if (invoiceRows.length === 0) throw new Error(`Invoice not found: ${invoiceId}`);
  const invoice = invoiceRows[0]!;

  const items = (await sql`
    SELECT * FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY created_at
  `) as Row[];

  log.info('Generating invoice PDF', {
    invoiceId,
    invoiceNumber: invoice.invoice_number,
    itemCount: items.length,
  }, 'invoicePdfBuilder');

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
  doc.text('TAX INVOICE', MARGIN, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(String(invoice.invoice_number || ''), PAGE_W - MARGIN, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.text(`Date: ${fmtDate(invoice.invoice_date as string | Date | null | undefined)}`, PAGE_W - MARGIN, 18, { align: 'right' });
  doc.text(`Due: ${fmtDate(invoice.due_date as string | Date | null | undefined)}`, PAGE_W - MARGIN, 23, { align: 'right' });

  let y = 36;

  // Company details (left)
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(COMPANY.name, MARGIN, y);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  y += 5; doc.text(COMPANY.address, MARGIN, y);
  y += 4; doc.text(`Tel: ${COMPANY.phone}`, MARGIN, y);
  y += 4; doc.text(`Email: ${COMPANY.email}`, MARGIN, y);
  y += 4; doc.text(`VAT No: ${COMPANY.vatNumber}`, MARGIN, y);

  // Client details (right)
  const rightX = PAGE_W / 2 + 10;
  let ry = 36;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('BILL TO:', rightX, ry);
  ry += 5;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(String(invoice.client_name || 'Unknown Client'), rightX, ry);
  ry += 5;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  if (invoice.client_address) {
    for (const line of String(invoice.client_address).split('\n')) {
      doc.text(line.trim(), rightX, ry); ry += 4;
    }
  }
  if (invoice.client_contact) { doc.text(`Attn: ${invoice.client_contact}`, rightX, ry); ry += 4; }
  if (invoice.client_email) { doc.text(String(invoice.client_email), rightX, ry); ry += 4; }
  if (invoice.client_phone) { doc.text(`Tel: ${invoice.client_phone}`, rightX, ry); ry += 4; }
  if (invoice.client_vat) { doc.text(`VAT No: ${invoice.client_vat}`, rightX, ry); ry += 4; }

  y = Math.max(y, ry) + 6;

  // Reference info bar
  doc.setFillColor(245, 247, 250);
  doc.setDrawColor(210, 215, 225);
  doc.roundedRect(MARGIN, y, CONTENT_W, 12, 1.5, 1.5, 'FD');
  const refCols = [
    { label: 'Invoice #', value: String(invoice.invoice_number || '') },
    { label: 'Project', value: String(invoice.project_name || '—') },
    { label: 'Period', value: invoice.billing_period_start ? `${fmtDate(invoice.billing_period_start as string | Date | null)} - ${fmtDate(invoice.billing_period_end as string | Date | null)}` : '—' },
    { label: 'Terms', value: invoice.due_date ? `Due ${fmtDate(invoice.due_date as string | Date | null)}` : 'On receipt' },
  ];
  const colW = CONTENT_W / refCols.length;
  refCols.forEach((col, i) => {
    const cx = MARGIN + colW * i + 4;
    doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
    doc.text(col.label.toUpperCase(), cx, y + 4);
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
    doc.text(col.value, cx, y + 9);
  });
  y += 18;

  // Line items table
  autoTable(doc, {
    startY: y,
    head: [['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']],
    body: items.map((item: Row) => [
      item.description || '—',
      Number(item.quantity).toFixed(2),
      fmtZAR(Number(item.unit_price)),
      fmtZAR(Number(item.tax_amount || 0)),
      fmtZAR(Number(item.line_total || item.amount || 0)),
    ]),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [TEAL.r, TEAL.g, TEAL.b], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 20 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 28 },
      4: { halign: 'right', cellWidth: 32, fontStyle: 'bold' },
    },
    tableWidth: CONTENT_W,
    margin: { left: MARGIN, right: MARGIN },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable?.finalY || y + 40;
  y += 6;

  // Totals section
  const totalsX = PAGE_W - MARGIN - 70;
  const totalsW = 70;
  const subtotal = Number(invoice.subtotal || 0);
  const taxAmount = Number(invoice.tax_amount || 0);
  const totalAmount = Number(invoice.total_amount || 0);
  const amountPaid = Number(invoice.amount_paid || 0);
  const balanceDue = totalAmount - amountPaid;

  const totalsData: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Subtotal', value: fmtZAR(subtotal) },
    { label: `VAT (${Number(invoice.tax_rate || 15)}%)`, value: fmtZAR(taxAmount) },
    { label: 'Total', value: fmtZAR(totalAmount), bold: true },
  ];
  if (amountPaid > 0) {
    totalsData.push({ label: 'Paid', value: `(${fmtZAR(amountPaid)})` });
    totalsData.push({ label: 'Balance Due', value: fmtZAR(balanceDue), bold: true });
  }

  totalsData.forEach((row, i) => {
    const rowY = y + i * 7;
    if (row.bold) {
      doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
      doc.rect(totalsX - 2, rowY - 4, totalsW + 4, 7, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
    } else {
      doc.setTextColor(60, 60, 60);
      doc.setFont('helvetica', 'normal');
    }
    doc.setFontSize(8.5);
    doc.text(row.label, totalsX, rowY);
    doc.text(row.value, totalsX + totalsW, rowY, { align: 'right' });
  });
  y += totalsData.length * 7 + 10;

  // Payment details
  if (y + 40 > PAGE_H - 30) { doc.addPage(); y = MARGIN + 10; }
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('PAYMENT DETAILS', MARGIN, y); y += 5;
  doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b); doc.setLineWidth(0.5);
  doc.line(MARGIN, y, MARGIN + 50, y); y += 5;

  const paymentDetails = [
    { label: 'Bank', value: COMPANY.bankName },
    { label: 'Account Name', value: COMPANY.bankAccountName },
    { label: 'Account Number', value: COMPANY.bankAccountNumber },
    { label: 'Branch Code', value: COMPANY.bankBranchCode },
    { label: 'Reference', value: String(invoice.invoice_number || '') },
  ];
  doc.setFontSize(8);
  paymentDetails.forEach((pd) => {
    doc.setFont('helvetica', 'bold'); doc.setTextColor(60, 60, 60);
    doc.text(`${pd.label}:`, MARGIN, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30);
    doc.text(pd.value, MARGIN + 32, y);
    y += 5;
  });
  y += 5;

  // Notes
  if (invoice.notes) {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(80, 80, 80);
    doc.text('Notes:', MARGIN, y); y += 4;
    doc.setFont('helvetica', 'normal');
    const noteLines = doc.splitTextToSize(String(invoice.notes), CONTENT_W);
    doc.text(noteLines, MARGIN, y);
    y += noteLines.length * 4 + 4;
  }

  // Terms
  if (y + 20 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 10; }
  doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(130, 130, 130);
  doc.text('Terms & Conditions: Payment is due within the stated terms. Late payments may incur interest at 2% per month.', MARGIN, y);
  y += 4;
  doc.text('E&OE - Errors and Omissions Excepted. Please advise of any discrepancies within 7 days.', MARGIN, y);

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);

  return Buffer.from(doc.output('arraybuffer'));
}
