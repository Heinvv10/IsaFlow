/**
 * Supplier Invoice PDF Builder — premium Supplier Invoice PDF.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  fmtZAR, fmtDate, COLORS,
  getCompanyDetailsFromCompany, renderPageFooters, getLastAutoTableY,
  hexToRgb, renderPremiumHeader, renderPartySection, renderRefStrip,
  renderTotalsBlock, renderNotesBlock,
  type TotalLine,
} from './pdfShared';

type Row = Record<string, unknown>;

export async function generateSupplierInvoicePdf(
  companyId: string,
  invoiceId: string,
): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);
  const accent = hexToRgb(COMPANY.primaryColor);

  const rows = (await sql`
    SELECT si.*,
           s.name          AS supplier_name,
           s.email         AS supplier_email,
           s.phone         AS supplier_phone,
           s.vat_number    AS supplier_vat,
           s.address       AS supplier_address,
           s.contact_person AS supplier_contact,
           s.bank_name     AS supplier_bank_name,
           s.bank_account_number AS supplier_bank_account,
           s.bank_branch_code    AS supplier_branch_code,
           po.order_number AS po_number
    FROM supplier_invoices si
    LEFT JOIN suppliers s ON s.id = si.supplier_id
    LEFT JOIN supplier_purchase_orders po ON po.id = si.purchase_order_id
    WHERE si.id = ${invoiceId}::UUID
      AND si.company_id = ${companyId}::UUID
  `) as Row[];

  if (rows.length === 0) throw new Error(`Supplier invoice not found: ${invoiceId}`);
  const inv = rows[0]!;

  const items = (await sql`
    SELECT * FROM supplier_invoice_items
    WHERE supplier_invoice_id = ${invoiceId}::UUID
    ORDER BY created_at
  `) as Row[];

  log.info('Generating supplier invoice PDF', {
    invoiceId, invoiceNumber: inv.invoice_number, itemCount: items.length,
  }, 'supplierInvoicePdfBuilder');

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
    docTitle: 'SUPPLIER INVOICE',
    docNumber: String(inv.invoice_number || ''),
    docDate: fmtDate(inv.invoice_date as string | Date | null | undefined),
    docSecondaryDate: inv.due_date
      ? fmtDate(inv.due_date as string | Date | null | undefined)
      : undefined,
    docSecondaryLabel: 'Due',
  });

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusStr = String(inv.status || 'draft').toUpperCase().replace(/_/g, ' ');
  const statusColorMap: Record<string, [number, number, number]> = {
    PAID:             COLORS.SUCCESS,
    APPROVED:         [accent.r, accent.g, accent.b],
    'PARTIALLY PAID': COLORS.AMBER,
    DISPUTED:         COLORS.DANGER,
    CANCELLED:        COLORS.TEXT_MUTED,
  };
  const badgeColor: [number, number, number] = statusColorMap[statusStr]
    ?? ([100, 116, 139] as [number, number, number]);

  doc.setFillColor(...badgeColor);
  doc.roundedRect(PAGE_W - MARGIN - 34, y - 2, 34, 7, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(statusStr, PAGE_W - MARGIN - 17, y + 2.5, { align: 'center' });

  // ── Party Section: FROM (Supplier) → TO (Our Company) ────────────────────
  y = renderPartySection(doc, y, PAGE_W, MARGIN, accent,
    {
      label: 'FROM (SUPPLIER)',
      name: String(inv.supplier_name || 'Unknown Supplier'),
      address: inv.supplier_address ? String(inv.supplier_address) : undefined,
      attention: inv.supplier_contact ? String(inv.supplier_contact) : undefined,
      email: inv.supplier_email ? String(inv.supplier_email) : undefined,
      phone: inv.supplier_phone ? String(inv.supplier_phone) : undefined,
      vatNumber: inv.supplier_vat ? String(inv.supplier_vat) : undefined,
    },
    {
      label: 'BILLED TO',
      name: COMPANY.name,
      address: COMPANY.address,
      email: COMPANY.email,
      phone: COMPANY.phone,
      vatNumber: COMPANY.vatNumber,
    },
  );

  // ── Reference Strip ───────────────────────────────────────────────────────
  y = renderRefStrip(doc, y, PAGE_W, MARGIN, [
    { label: 'Invoice #',   value: String(inv.invoice_number || '—') },
    { label: 'PO #',        value: inv.po_number ? String(inv.po_number) : '—' },
    { label: 'Invoice Date', value: fmtDate(inv.invoice_date as string | Date | null | undefined) },
    { label: 'Due Date',    value: inv.due_date ? fmtDate(inv.due_date as string | Date | null | undefined) : '—' },
    { label: 'Reference',   value: inv.reference ? String(inv.reference) : '—' },
  ]);

  // ── Line Items Table ───────────────────────────────────────────────────────
  if (items.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']],
      body: items.map((item: Row) => [
        item.description || '—',
        Number(item.quantity || 0).toFixed(2),
        fmtZAR(Number(item.unit_price || 0)),
        fmtZAR(Number(item.tax_amount || 0)),
        fmtZAR(Number(item.line_total || 0)),
      ]),
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
        1: { halign: 'right', cellWidth: 18 },
        2: { halign: 'right', cellWidth: 28 },
        3: { halign: 'right', cellWidth: 25 },
        4: { halign: 'right', cellWidth: 30, fontStyle: 'bold' },
      },
      tableWidth: CONTENT_W,
      margin: { left: MARGIN, right: MARGIN },
    });
    y = getLastAutoTableY(doc, y + 40) + 8;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const subtotal   = Number(inv.subtotal    || 0);
  const taxAmount  = Number(inv.tax_amount  || 0);
  const totalAmt   = Number(inv.total_amount|| 0);
  const amountPaid = Number(inv.amount_paid || 0);
  const balance    = totalAmt - amountPaid;

  const totalLines: TotalLine[] = [
    { label: 'Subtotal',                        value: fmtZAR(subtotal) },
    { label: `VAT (${Number(inv.tax_rate || 15)}%)`, value: fmtZAR(taxAmount) },
    { label: 'INVOICE TOTAL',                   value: fmtZAR(totalAmt), isTotal: true },
  ];
  if (amountPaid > 0) {
    totalLines.push({ label: 'Amount Paid', value: `(${fmtZAR(amountPaid)})`, isMuted: true });
    totalLines.push({ label: 'BALANCE DUE', value: fmtZAR(balance), isTotal: true });
  }

  y = renderTotalsBlock(doc, y, PAGE_W, MARGIN, accent, totalLines);

  // ── Supplier Banking Details (for remittance) ─────────────────────────────
  if (inv.supplier_bank_name || inv.supplier_bank_account) {
    if (y + 35 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(accent.r, accent.g, accent.b);
    doc.text('SUPPLIER BANKING DETAILS', MARGIN, y);
    y += 2;
    doc.setDrawColor(accent.r, accent.g, accent.b);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, y, MARGIN + 52, y);
    y += 5;

    const bankFields = [
      { label: 'Bank',           value: inv.supplier_bank_name   ? String(inv.supplier_bank_name)   : '—' },
      { label: 'Account Number', value: inv.supplier_bank_account ? String(inv.supplier_bank_account) : '—' },
      { label: 'Branch Code',    value: inv.supplier_branch_code  ? String(inv.supplier_branch_code)  : '—' },
      { label: 'Reference',      value: String(inv.invoice_number || '') },
    ];

    const ROW_H = 5.5;
    const BOX_H = bankFields.length * ROW_H + 8;
    doc.setFillColor(...COLORS.SURFACE);
    doc.setDrawColor(...COLORS.BORDER);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y, CONTENT_W * 0.55, BOX_H, 1.5, 1.5, 'FD');

    let ry = y + 5;
    for (const f of bankFields) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...COLORS.TEXT_SECONDARY);
      doc.text(f.label, MARGIN + 4, ry);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.TEXT_PRIMARY);
      doc.text(f.value, MARGIN + 36, ry);
      ry += ROW_H;
    }
    y += BOX_H + 6;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (inv.notes && String(inv.notes).trim()) {
    if (y + 20 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
    y = renderNotesBlock(doc, y, PAGE_W, MARGIN, String(inv.notes));
  }

  // ── Approval info ─────────────────────────────────────────────────────────
  if (inv.approved_at) {
    if (y + 12 > PAGE_H - 16) { doc.addPage(); y = MARGIN + 8; }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.TEXT_MUTED);
    doc.text(
      `Approved: ${fmtDate(inv.approved_at as string | Date | null | undefined)}`,
      MARGIN, y,
    );
  }

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN, 'This document is for internal records only.');
  return Buffer.from(doc.output('arraybuffer'));
}
