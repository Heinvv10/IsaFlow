/**
 * Invoice PDF Builder — premium Tax Invoice PDF using jsPDF + jspdf-autotable.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  fmtZAR, fmtDate, COLORS,
  getCompanyDetailsFromCompany, renderPageFooters,
  getLastAutoTableY, hexToRgb,
  renderPremiumHeader, renderPartySection, renderRefStrip,
  renderTotalsBlock, renderPaymentDetails, renderNotesBlock,
  type TotalLine,
} from '../core/pdfShared';

type Row = DbRow;

export async function generateInvoicePdf(companyId: string, invoiceId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);
  const accent = hexToRgb(COMPANY.primaryColor);

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
      AND ci.company_id = ${companyId}::UUID
  `) as Row[];

  if (invoiceRows.length === 0) throw new Error(`Invoice not found: ${invoiceId}`);
  const inv = invoiceRows[0]!;

  const items = (await sql`
    SELECT * FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY created_at
  `) as Row[];

  log.info('Generating premium invoice PDF', {
    invoiceId, invoiceNumber: inv.invoice_number, itemCount: items.length,
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

  // ── Premium Header ────────────────────────────────────────────────────────
  let y = renderPremiumHeader({
    doc, pageW: PAGE_W, margin: MARGIN, company: COMPANY, accent,
    docType: 'invoice',
    docTitle: 'TAX INVOICE',
    docNumber: String(inv.invoice_number || ''),
    docDate: fmtDate(inv.invoice_date as string | Date | null | undefined),
    docSecondaryDate: inv.due_date ? fmtDate(inv.due_date as string | Date | null | undefined) : undefined,
    docSecondaryLabel: 'Due',
  });

  // ── Party Section (FROM / BILL TO) ────────────────────────────────────────
  const statusStr = String(inv.status || '').toUpperCase();
  const statusColors: Record<string, [number, number, number]> = {
    PAID:           COLORS.SUCCESS,
    OVERDUE:        COLORS.DANGER,
    PARTIALLY_PAID: COLORS.AMBER,
    SENT:           [accent.r, accent.g, accent.b],
    APPROVED:       [accent.r, accent.g, accent.b],
  };
  const badgeColor = statusColors[statusStr] ?? COLORS.TEXT_SECONDARY;

  // Status badge top-right of body
  doc.setFillColor(...badgeColor);
  doc.roundedRect(PAGE_W - MARGIN - 26, y - 2, 26, 7, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(statusStr, PAGE_W - MARGIN - 13, y + 2.5, { align: 'center' });

  y = renderPartySection(doc, y, PAGE_W, MARGIN, accent,
    {
      label: 'FROM',
      name: COMPANY.name,
      address: COMPANY.address,
      email: COMPANY.email,
      phone: COMPANY.phone,
      vatNumber: COMPANY.vatNumber,
    },
    {
      label: 'BILL TO',
      name: String(inv.client_name || 'Unknown Client'),
      address: inv.client_address ? String(inv.client_address) : undefined,
      attention: inv.client_contact ? String(inv.client_contact) : undefined,
      email: inv.client_email ? String(inv.client_email) : undefined,
      phone: inv.client_phone ? String(inv.client_phone) : undefined,
      vatNumber: inv.client_vat ? String(inv.client_vat) : undefined,
    },
  );

  // ── Reference Strip ───────────────────────────────────────────────────────
  const refFields = [
    { label: 'Invoice #', value: String(inv.invoice_number || '—') },
    {
      label: 'Project',
      value: inv.project_name ? String(inv.project_name) : '—',
    },
    {
      label: 'Issue Date',
      value: fmtDate(inv.invoice_date as string | Date | null | undefined),
    },
    {
      label: 'Due Date',
      value: inv.due_date ? fmtDate(inv.due_date as string | Date | null | undefined) : 'On Receipt',
    },
    {
      label: 'Terms',
      value: inv.payment_terms ? String(inv.payment_terms) : '30 Days',
    },
  ];
  y = renderRefStrip(doc, y, PAGE_W, MARGIN, refFields);

  // ── Line Items Table ───────────────────────────────────────────────────────
  // Per-line VAT is derived from the line amount × the LINE's own tax rate.
  // Items don't carry a populated tax_amount, but they do carry tax_rate, and
  // an invoice may mix rates (a zero-rated export line beside a standard one).
  // Falling back to the header rate for every line printed 15% VAT against a
  // zero-rated line and the VAT column stopped footing to the totals block.
  const headerTaxRate = Number(inv.tax_rate ?? 15);
  const lineRate = (item: Row): number =>
    item.tax_rate != null ? Number(item.tax_rate) : headerTaxRate;
  const mixedRates = new Set(items.map(lineRate)).size > 1;
  autoTable(doc, {
    startY: y,
    head: [['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']],
    body: items.map((item: Row) => {
      const lineAmount = Number(item.line_total || item.amount || 0);
      const lineVat = Math.round(lineAmount * (lineRate(item) / 100) * 100) / 100;
      return [
        item.description || '—',
        Number(item.quantity || 0).toFixed(2),
        fmtZAR(Number(item.unit_price || 0)),
        fmtZAR(lineVat),
        fmtZAR(lineAmount),
      ];
    }),
    styles: {
      fontSize: 8,
      cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
      textColor: COLORS.TEXT_PRIMARY,
    },
    headStyles: {
      fillColor: COLORS.DARK,
      textColor: COLORS.WHITE,
      fontStyle: 'bold',
      fontSize: 7,
      cellPadding: { top: 5, bottom: 5, left: 4, right: 4 },
    },
    alternateRowStyles: { fillColor: COLORS.SURFACE },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 16 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 30 },
      4: { halign: 'right', cellWidth: 32, fontStyle: 'bold' },
    },
    tableWidth: CONTENT_W,
    margin: { left: MARGIN, right: MARGIN },
  });

  y = getLastAutoTableY(doc, y + 40) + 8;

  // ── Totals ────────────────────────────────────────────────────────────────
  const subtotal = Number(inv.subtotal || 0);
  const taxAmount = Number(inv.tax_amount || 0);
  const totalAmount = Number(inv.total_amount || 0);
  const amountPaid = Number(inv.amount_paid || 0);
  const balanceDue = totalAmount - amountPaid;

  const totalLines: TotalLine[] = [
    { label: 'Subtotal', value: fmtZAR(subtotal) },
    { label: mixedRates ? 'VAT' : `VAT (${headerTaxRate}%)`, value: fmtZAR(taxAmount) },
    { label: 'TOTAL DUE', value: fmtZAR(totalAmount), isTotal: true },
  ];
  if (amountPaid > 0) {
    totalLines.push({ label: 'Amount Paid', value: `(${fmtZAR(amountPaid)})`, isMuted: true });
    totalLines.push({ label: 'BALANCE DUE', value: fmtZAR(balanceDue), isTotal: true });
  }

  y = renderTotalsBlock(doc, y, PAGE_W, MARGIN, accent, totalLines);

  // ── Payment Details ───────────────────────────────────────────────────────
  if (y + 50 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
  y = renderPaymentDetails(doc, y, PAGE_W, MARGIN, accent, COMPANY,
    String(inv.invoice_number || ''));

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (inv.notes && String(inv.notes).trim()) {
    if (y + 20 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
    y = renderNotesBlock(doc, y, PAGE_W, MARGIN, String(inv.notes));
  }

  // ── Terms ─────────────────────────────────────────────────────────────────
  if (y + 12 > PAGE_H - 16) { doc.addPage(); y = MARGIN + 8; }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  doc.text(
    'Payment is due within the stated terms. Late payments may accrue interest at 2% per month compounded. E&OE.',
    MARGIN, y, { maxWidth: CONTENT_W * 0.8 }
  );

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);
  return Buffer.from(doc.output('arraybuffer'));
}
