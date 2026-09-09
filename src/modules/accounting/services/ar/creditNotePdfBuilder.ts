/**
 * Credit Note PDF Builder — premium Credit Note PDF using jsPDF + jspdf-autotable.
 * Returns a Node.js Buffer suitable for API responses and email attachments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  fmtZAR, fmtDate, COLORS, TEAL,
  getCompanyDetailsFromCompany, renderPageFooters, getLastAutoTableY,
  hexToRgb, renderPremiumHeader, renderPartySection, renderRefStrip,
  renderTotalsBlock,
} from '../core/pdfShared';


export async function generateCreditNotePdf(companyId: string, creditNoteId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);
  const accent = hexToRgb(COMPANY.primaryColor);

  const rows = (await sql`
    SELECT cn.*,
           c.name AS client_name,
           c.email AS client_email,
           c.phone AS client_phone,
           c.vat_number AS client_vat,
           c.billing_address AS client_address,
           c.contact_person AS client_contact,
           s.name AS supplier_name,
           ci.invoice_number AS original_invoice_number,
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS approved_by_name
    FROM credit_notes cn
    -- Two columns named here did not exist: cn.customer_id and u.full_name
    -- (users carries first_name/last_name). credit_notes has NO customer_id; the repo's
    -- COALESCE(client_id, customer_id) rule is about customer_invoices and was
    -- applied here by pattern. Postgres raised 42703 on every call, so this
    -- endpoint returned 500 for every credit note.
    LEFT JOIN customers c ON c.id = cn.client_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id
    LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
    LEFT JOIN users u ON u.id = cn.approved_by::TEXT
    WHERE cn.id = ${creditNoteId}::UUID
      AND cn.company_id = ${companyId}::UUID
  `) as DbRow[];

  if (rows.length === 0) throw new Error(`Credit note not found: ${creditNoteId}`);
  const cn = rows[0]!;

  // credit_note_items does not exist in the current schema. Asking for it and
  // catching the failure is not free: the 42P01 aborts the request's
  // transaction (this builder runs under withAuth), and every query added to
  // this route afterwards would fail with 25P02 for a reason no log names.
  // to_regclass answers the same question without raising.
  const [presence] = (await sql`
    SELECT to_regclass('public.credit_note_items') IS NOT NULL AS has_items_table
  `) as Array<{ has_items_table: boolean }>;

  const items: DbRow[] = presence?.has_items_table
    ? (await sql`
        SELECT * FROM credit_note_items
        WHERE credit_note_id = ${creditNoteId}::UUID
        ORDER BY created_at
      `) as DbRow[]
    : [];

  log.info('Generating premium credit note PDF', {
    creditNoteId, creditNoteNumber: cn.credit_note_number,
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

  // ── Premium Header ────────────────────────────────────────────────────────
  let y = renderPremiumHeader({
    doc, pageW: PAGE_W, margin: MARGIN, company: COMPANY, accent,
    docType: 'credit_note',
    docTitle: 'CREDIT NOTE',
    docNumber: String(cn.credit_note_number || ''),
    docDate: fmtDate(cn.credit_date as string | Date | null | undefined),
    docSecondaryDate: cn.original_invoice_number ? String(cn.original_invoice_number) : undefined,
    docSecondaryLabel: 'Ref Invoice',
  });

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusStr = String(cn.status || 'draft').toUpperCase();
  const badgeColor: [number, number, number] = statusStr === 'APPROVED'
    ? COLORS.SUCCESS
    : statusStr === 'VOID'
      ? COLORS.DANGER
      : [accent.r, accent.g, accent.b];

  doc.setFillColor(...badgeColor);
  doc.roundedRect(PAGE_W - MARGIN - 26, y - 2, 26, 7, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(statusStr, PAGE_W - MARGIN - 13, y + 2.5, { align: 'center' });

  // ── Party Section ─────────────────────────────────────────────────────────
  const isCustomer = !cn.type || String(cn.type) === 'customer';
  const entityName = isCustomer
    ? String(cn.client_name || 'Unknown')
    : String(cn.supplier_name || 'Unknown');
  const entityAddress = isCustomer && cn.client_address ? String(cn.client_address) : undefined;
  const entityVat = isCustomer && cn.client_vat ? String(cn.client_vat) : undefined;

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
      label: 'CREDIT TO',
      name: entityName,
      address: entityAddress,
      vatNumber: entityVat,
    },
  );

  // ── Reference Strip ───────────────────────────────────────────────────────
  y = renderRefStrip(doc, y, PAGE_W, MARGIN, [
    { label: 'Credit Note #', value: String(cn.credit_note_number || '—') },
    { label: 'Type', value: isCustomer ? 'Customer' : 'Supplier' },
    { label: 'Credit Date', value: fmtDate(cn.credit_date as string | Date | null | undefined) },
    { label: 'Original Invoice', value: String(cn.original_invoice_number || '—') },
    { label: 'Reason', value: cn.reason ? String(cn.reason).substring(0, 30) : '—' },
  ]);

  // ── Line Items (if any) ───────────────────────────────────────────────────
  if (items.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']],
      body: items.map((item: DbRow) => [
        item.description || '—',
        Number(item.quantity || 0).toFixed(2),
        fmtZAR(Number(item.unit_price || 0)),
        fmtZAR(Number(item.tax_amount || 0)),
        fmtZAR(Number(item.line_total || item.amount || 0)),
      ]),
      styles: { fontSize: 8, cellPadding: { top: 4, bottom: 4, left: 4, right: 4 }, textColor: COLORS.TEXT_PRIMARY },
      headStyles: { fillColor: COLORS.DARK, textColor: COLORS.WHITE, fontStyle: 'bold', fontSize: 7 },
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
  const subtotal = Number(cn.subtotal || 0);
  const taxAmount = Number(cn.tax_amount || 0);
  const totalAmount = Number(cn.total_amount || 0);

  y = renderTotalsBlock(doc, y, PAGE_W, MARGIN, accent, [
    { label: 'Subtotal', value: fmtZAR(subtotal) },
    { label: `VAT (${Number(cn.tax_rate || 15)}%)`, value: fmtZAR(taxAmount) },
    { label: 'CREDIT TOTAL', value: fmtZAR(totalAmount), isTotal: true },
  ]);

  // ── Approval details ──────────────────────────────────────────────────────
  if (cn.approved_by_name || cn.approved_at) {
    if (y + 14 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    doc.text('APPROVAL', MARGIN, y); y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.TEXT_PRIMARY);
    const approvalLine = [
      cn.approved_by_name ? `Approved by: ${cn.approved_by_name}` : null,
      cn.approved_at ? `on ${fmtDate(cn.approved_at as string | Date | null | undefined)}` : null,
    ].filter(Boolean).join(' ');
    doc.text(approvalLine, MARGIN, y);
    y += 8;
  }

  // ── Terms ─────────────────────────────────────────────────────────────────
  if (y + 10 > PAGE_H - 16) { doc.addPage(); y = MARGIN + 8; }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  doc.text('This credit note is issued in accordance with applicable tax legislation. E&OE.', MARGIN, y);

  // Suppress unused var
  void TEAL;

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN);
  return Buffer.from(doc.output('arraybuffer'));
}
