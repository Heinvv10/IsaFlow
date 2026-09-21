/**
 * Quote PDF Builder — premium Quotation PDF using jsPDF + jspdf-autotable.
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


export async function generateQuotePdf(companyId: string, quoteId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);
  const accent = hexToRgb(COMPANY.primaryColor);

  const quoteRows = (await sql`
    SELECT q.*,
           c.name AS client_name_resolved,
           c.email AS client_email,
           c.phone AS client_phone,
           c.vat_number AS client_vat,
           c.billing_address AS client_address,
           c.contact_person AS client_contact
    FROM customer_quotes q
    -- The join carries company_id: customer_quotes.client_id has no FK, so a
    -- drifted id would print another tenant's customer name, VAT number and
    -- billing address onto a customer-facing quotation.
    LEFT JOIN customers c ON c.id = q.client_id AND c.company_id = q.company_id
    WHERE q.id = ${quoteId}::UUID
      AND q.company_id = ${companyId}::UUID
  `) as DbRow[];

  if (quoteRows.length === 0) throw new Error(`Quote not found: ${quoteId}`);
  const q = quoteRows[0]!;

  const lines = (await sql`
    SELECT * FROM customer_quote_lines
    WHERE quote_id = ${quoteId}::UUID
    ORDER BY sort_order, created_at
  `) as DbRow[];

  log.info('Generating premium quote PDF', {
    quoteId, quoteNumber: q.quote_number, lineCount: lines.length,
  }, 'quotePdfBuilder');

  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const clientName = String(q.client_name_resolved || q.customer_name || 'Prospective Client');
  const statusStr = String(q.status || 'DRAFT').toUpperCase();

  // ── Premium Header ────────────────────────────────────────────────────────
  let y = renderPremiumHeader({
    doc, pageW: PAGE_W, margin: MARGIN, company: COMPANY, accent,
    docType: 'quote',
    docTitle: 'QUOTATION',
    docNumber: String(q.quote_number || ''),
    docDate: fmtDate(q.quote_date as string | Date | null | undefined),
    docSecondaryDate: q.expiry_date
      ? fmtDate(q.expiry_date as string | Date | null | undefined)
      : undefined,
    docSecondaryLabel: 'Valid Until',
  });

  // ── Status badge ──────────────────────────────────────────────────────────
  const badgeColors: Record<string, [number,number,number]> = {
    ACCEPTED: COLORS.SUCCESS,
    DECLINED: COLORS.DANGER,
    EXPIRED:  COLORS.TEXT_SECONDARY,
    SENT:     [accent.r, accent.g, accent.b],
    DRAFT:    [120, 130, 150],
  };
  const badgeColor = badgeColors[statusStr] ?? ([accent.r, accent.g, accent.b] as [number,number,number]);

  doc.setFillColor(...badgeColor);
  doc.roundedRect(PAGE_W - MARGIN - 26, y - 2, 26, 7, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(statusStr, PAGE_W - MARGIN - 13, y + 2.5, { align: 'center' });

  // ── Party Section ─────────────────────────────────────────────────────────
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
      label: 'PREPARED FOR',
      name: clientName,
      address: q.client_address ? String(q.client_address) : undefined,
      attention: q.client_contact ? String(q.client_contact) : undefined,
      email: q.client_email ? String(q.client_email) : undefined,
      phone: q.client_phone ? String(q.client_phone) : undefined,
      vatNumber: q.client_vat ? String(q.client_vat) : undefined,
    },
  );

  // ── Reference Strip ───────────────────────────────────────────────────────
  y = renderRefStrip(doc, y, PAGE_W, MARGIN, [
    { label: 'Quote #', value: String(q.quote_number || '—') },
    { label: 'Issue Date', value: fmtDate(q.quote_date as string | Date | null | undefined) },
    {
      label: 'Valid Until',
      value: q.expiry_date ? fmtDate(q.expiry_date as string | Date | null | undefined) : '30 Days',
    },
    { label: 'Status', value: statusStr },
    { label: 'Currency', value: 'ZAR' },
  ]);

  // ── Line Items Table ───────────────────────────────────────────────────────
  // customer_quote_lines carries a per-line tax_rate and the table below prints
  // it, so the totals block must not claim a single rate the lines contradict.
  const headerTaxRate = Number(q.tax_rate ?? 15);
  const lineRate = (line: DbRow): number =>
    line.tax_rate != null ? Number(line.tax_rate) : headerTaxRate;
  // As in invoicePdfBuilder: state the rate the LINES carry. Uniform zero-rated
  // lines under a header still holding the 15.00 column default must not be
  // labelled 'VAT (15%)'.
  const distinctRates = [...new Set(lines.map(lineRate))];
  const totalsVatLabel = distinctRates.length === 1
    ? `VAT (${distinctRates[0]}%)`
    : distinctRates.length === 0 ? `VAT (${headerTaxRate}%)` : 'VAT';
  // The table prints a RATE per line, not a VAT amount, so there is no column to
  // foot. What can still disagree is the stored header aggregate: a quote whose
  // lines are all zero-rated but whose `tax_amount` still holds a 15% figure
  // prints 'VAT (0%) R150.00'. It is printed and logged, not left for the
  // customer to find. The tolerance is a HALF CENT, not `lines.length / 100`:
  // nothing on this page rounds per line, so a line-scaled tolerance only
  // silenced up to R0.20 of real disagreement on a 20-line quote.
  const headerVat = Number(q.tax_amount || 0);
  const linesVat = lines.reduce(
    (sum, line) => sum + Number(line.amount || 0) * (lineRate(line) / 100),
    0,
  );
  const vatDisagreement = Math.round((headerVat - linesVat) * 100) / 100;
  // A quote with NO lines and a non-zero header VAT is a disagreement of the
  // whole amount, not an exemption from the check: nothing on the page can
  // account for it, and `lines.length > 0` suppressed the note in exactly that
  // case.
  const vatDisagrees = Math.abs(vatDisagreement) > 0.005;
  if (vatDisagrees) {
    log.warn('Quote VAT total disagrees with the rates its lines carry', {
      quoteId, headerVat, linesVat: Math.round(linesVat * 100) / 100, vatDisagreement,
    }, 'quotePdfBuilder');
  }

  if (lines.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Description', 'Qty', 'Unit Price', 'VAT Rate', 'Amount']],
      body: lines.map((line: DbRow) => [
        line.description || '—',
        Number(line.quantity || 0).toFixed(2),
        fmtZAR(Number(line.unit_price || 0)),
        `${lineRate(line).toFixed(0)}%`,
        fmtZAR(Number(line.amount || 0)),
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
        3: { halign: 'right', cellWidth: 22 },
        4: { halign: 'right', cellWidth: 30, fontStyle: 'bold' },
      },
      tableWidth: CONTENT_W,
      margin: { left: MARGIN, right: MARGIN },
    });
    y = getLastAutoTableY(doc, y + 40) + 8;
  } else {
    // No lines — show placeholder
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    doc.text('No line items on this quotation.', MARGIN, y + 8);
    y += 18;
  }

  if (vatDisagrees) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COLORS.DANGER);
    doc.text(
      lines.length > 0
        ? `The VAT total differs by ${fmtZAR(vatDisagreement)} from the rates the lines above carry.`
        : `The VAT total of ${fmtZAR(vatDisagreement)} is not accounted for by any line item.`,
      MARGIN, y,
    );
    doc.setTextColor(...COLORS.TEXT_PRIMARY);
    y += 6;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const subtotal = Number(q.subtotal || 0);
  const taxAmount = headerVat;
  const total = Number(q.total || 0);

  y = renderTotalsBlock(doc, y, PAGE_W, MARGIN, accent, [
    { label: 'Subtotal (excl. VAT)', value: fmtZAR(subtotal) },
    { label: totalsVatLabel, value: fmtZAR(taxAmount) },
    { label: 'QUOTATION TOTAL', value: fmtZAR(total), isTotal: true },
  ]);

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (q.notes && String(q.notes).trim()) {
    if (y + 20 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }
    y = renderNotesBlock(doc, y, PAGE_W, MARGIN, String(q.notes));
  }

  // ── Terms & Conditions ────────────────────────────────────────────────────
  if (y + 28 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }

  const termsText = q.terms
    ? String(q.terms)
    : 'This quotation is valid for the period stated. Prices are subject to change without notice after the validity date. ' +
      'All amounts are in South African Rand (ZAR) and include VAT at the rate shown per line. E&OE.';

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  doc.text('TERMS & CONDITIONS', MARGIN, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  const termLines = doc.splitTextToSize(termsText, CONTENT_W * 0.85) as string[];
  doc.text(termLines, MARGIN, y);
  y += termLines.length * 3.5 + 6;

  // ── Acceptance block ──────────────────────────────────────────────────────
  if (y + 24 > PAGE_H - 20) { doc.addPage(); y = MARGIN + 8; }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(accent.r, accent.g, accent.b);
  doc.text('TO ACCEPT THIS QUOTATION', MARGIN, y);
  y += 2;
  doc.setDrawColor(accent.r, accent.g, accent.b);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, MARGIN + 48, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  if (COMPANY.email) {
    doc.text(`Please contact us at ${COMPANY.email}`, MARGIN, y);
    y += 4.5;
  }
  if (COMPANY.phone) {
    doc.text(`or call ${COMPANY.phone} to confirm your order.`, MARGIN, y);
    y += 4.5;
  }

  // Signature line
  y += 4;
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, MARGIN + 60, y);
  doc.line(PAGE_W - MARGIN - 60, y, PAGE_W - MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.TEXT_MUTED);
  doc.text('Authorised Signature', MARGIN, y + 5);
  doc.text('Date', PAGE_W - MARGIN - 60, y + 5);

  renderPageFooters(doc, PAGE_W, PAGE_H, MARGIN, 'We look forward to doing business with you.');
  return Buffer.from(doc.output('arraybuffer'));
}
