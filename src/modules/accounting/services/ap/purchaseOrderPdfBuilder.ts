/**
 * Purchase Order PDF Builder — premium PO PDF using jsPDF + jspdf-autotable.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  fmtZAR, fmtDate, COLORS,
  getCompanyDetailsFromCompany, renderPageFooters, getLastAutoTableY,
  hexToRgb, renderPremiumHeader, renderPartySection, renderRefStrip,
  renderTotalsBlock, renderNotesBlock,
} from '../core/pdfShared';


export async function generatePurchaseOrderPdf(
  companyId: string,
  poId: string,
): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);
  const accent = hexToRgb(COMPANY.primaryColor);

  const rows = (await sql`
    SELECT po.*,
           s.name           AS supplier_name,
           s.email          AS supplier_email,
           s.phone          AS supplier_phone,
           s.vat_number     AS supplier_vat,
           s.address        AS supplier_address,
           s.contact_person AS supplier_contact
    FROM supplier_purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = ${poId}::UUID
      AND po.company_id = ${companyId}::UUID
  `) as DbRow[];

  if (rows.length === 0) throw new Error(`Purchase order not found: ${poId}`);
  const po = rows[0]!;

  const items = (await sql`
    SELECT * FROM supplier_purchase_order_items
    WHERE purchase_order_id = ${poId}::UUID
    ORDER BY created_at
  `) as DbRow[];

  log.info('Generating PO PDF', {
    poId, poNumber: po.order_number, itemCount: items.length,
  }, 'purchaseOrderPdfBuilder');

  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const statusStr = String(po.status || 'DRAFT').toUpperCase();
  const deliveryDate = po.delivery_date
    ? fmtDate(po.delivery_date as string | Date | null | undefined)
    : undefined;

  // ── Premium Header ────────────────────────────────────────────────────────
  let y = renderPremiumHeader({
    doc, pageW: PAGE_W, margin: MARGIN, company: COMPANY, accent,
    docType: 'purchase_order',
    docTitle: 'PURCHASE ORDER',
    docNumber: String(po.order_number || ''),
    docDate: fmtDate(po.order_date as string | Date | null | undefined),
    docSecondaryDate: deliveryDate,
    docSecondaryLabel: 'Deliver By',
  });

  // ── Status badge ──────────────────────────────────────────────────────────
  const badgeColors: Record<string, [number, number, number]> = {
    APPROVED:           [accent.r, accent.g, accent.b],
    RECEIVED:           COLORS.SUCCESS,
    'PARTIALLY RECEIVED': COLORS.AMBER,
    CANCELLED:          COLORS.TEXT_MUTED,
    SUBMITTED:          [100, 116, 139],
    DRAFT:              [120, 130, 150],
  };
  const badgeColor: [number, number, number] = badgeColors[statusStr]
    ?? ([100, 116, 139] as [number, number, number]);

  doc.setFillColor(...badgeColor);
  doc.roundedRect(PAGE_W - MARGIN - 34, y - 2, 34, 7, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(statusStr, PAGE_W - MARGIN - 17, y + 2.5, { align: 'center' });

  // ── Party Section: FROM (Our Company) → TO (Supplier) ────────────────────
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
      label: 'TO (SUPPLIER)',
      name: String(po.supplier_name || 'Unknown Supplier'),
      address: po.supplier_address ? String(po.supplier_address) : undefined,
      attention: po.supplier_contact ? String(po.supplier_contact) : undefined,
      email: po.supplier_email ? String(po.supplier_email) : undefined,
      phone: po.supplier_phone ? String(po.supplier_phone) : undefined,
      vatNumber: po.supplier_vat ? String(po.supplier_vat) : undefined,
    },
  );

  // ── Reference Strip ───────────────────────────────────────────────────────
  y = renderRefStrip(doc, y, PAGE_W, MARGIN, [
    { label: 'PO Number',    value: String(po.order_number || '—') },
    { label: 'Order Date',   value: fmtDate(po.order_date as string | Date | null | undefined) },
    { label: 'Deliver By',   value: deliveryDate ?? '—' },
    { label: 'Status',       value: statusStr },
    { label: 'Reference',    value: po.reference ? String(po.reference) : '—' },
  ]);

  // ── Delivery Address ──────────────────────────────────────────────────────
  if (COMPANY.address) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(accent.r, accent.g, accent.b);
    doc.text('DELIVERY ADDRESS', MARGIN, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    doc.text(COMPANY.address, MARGIN, y);
    y += 6;
  }

  // ── Line Items Table ───────────────────────────────────────────────────────
  if (items.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Description', 'Qty', 'Unit Price', 'VAT%', 'Amount']],
      body: items.map((item: DbRow) => [
        item.description || '—',
        Number(item.quantity || 0).toFixed(2),
        fmtZAR(Number(item.unit_price || 0)),
        `${Number(item.tax_rate || 0).toFixed(0)}%`,
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
        3: { halign: 'right', cellWidth: 18 },
        4: { halign: 'right', cellWidth: 30, fontStyle: 'bold' },
      },
      tableWidth: CONTENT_W,
      margin: { left: MARGIN, right: MARGIN },
    });
    y = getLastAutoTableY(doc, y + 40) + 8;
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    doc.text('No line items on this purchase order.', MARGIN, y + 8);
    y += 18;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const subtotal  = Number(po.subtotal   || 0);
  const taxAmount = Number(po.tax_amount || 0);
  const total     = Number(po.total      || po.total_amount || 0);

  y = renderTotalsBlock(doc, y, PAGE_W, MARGIN, accent, [
    { label: 'Subtotal (excl. VAT)', value: fmtZAR(subtotal) },
    { label: 'VAT',                  value: fmtZAR(taxAmount) },
    { label: 'ORDER TOTAL',          value: fmtZAR(total), isTotal: true },
  ]);

  // ── Notes & Terms ─────────────────────────────────────────────────────────
  if (po.notes && String(po.notes).trim()) {
    if (y + 20 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
    y = renderNotesBlock(doc, y, PAGE_W, MARGIN, String(po.notes));
  }

  // ── Terms & Conditions ────────────────────────────────────────────────────
  if (y + 22 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  doc.text('TERMS & CONDITIONS', MARGIN, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  const terms = [
    'Please confirm receipt of this order and advise if you cannot fulfil any line item.',
    'Delivery must be accompanied by a valid delivery note and tax invoice.',
    'Payment will be made within agreed terms upon receipt of a valid tax invoice.',
  ].join(' ');
  const termLines = doc.splitTextToSize(terms, CONTENT_W * 0.85) as string[];
  doc.text(termLines, MARGIN, y);
  y += termLines.length * 3.5 + 8;

  // ── Authorised signature ──────────────────────────────────────────────────
  if (y + 18 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, MARGIN + 65, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  doc.text('Authorised Signature & Date', MARGIN, y + 5);

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN, 'This purchase order constitutes a binding order subject to the terms stated above.');
  return Buffer.from(doc.output('arraybuffer'));
}
