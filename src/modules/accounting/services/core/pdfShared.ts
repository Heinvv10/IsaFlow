/**
 * PDF Shared Utilities — formatting helpers, company details, premium design system.
 * Used by all PDF builders: invoice, credit note, quote, statement.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsPdfDoc = any;

// ── Formatting ────────────────────────────────────────────────────────────────

export const fmtZAR = (amount: number): string =>
  'R\u00a0' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const fmtDate = (d: string | Date | null | undefined): string => {
  if (!d) return '—';
  const str = d instanceof Date ? d.toISOString() : String(d);
  const parts = str.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return str;
};

/** Get the Y position after the last autoTable render */
export function getLastAutoTableY(doc: unknown, fallback: number): number {
  const d = doc as { lastAutoTable?: { finalY?: number } };
  return d.lastAutoTable?.finalY ?? fallback;
}

// ── Premium Color Palette ─────────────────────────────────────────────────────

export const COLORS = {
  DARK:           [15,  23,  42]  as [number, number, number], // near-black dark blue
  WHITE:          [255, 255, 255] as [number, number, number],
  TEXT_PRIMARY:   [15,  23,  42]  as [number, number, number],
  TEXT_SECONDARY: [100, 116, 139] as [number, number, number],
  TEXT_MUTED:     [148, 163, 184] as [number, number, number],
  HEADER_SUB:     [180, 195, 215] as [number, number, number], // light text in dark header
  SURFACE:        [248, 250, 252] as [number, number, number],
  BORDER:         [226, 232, 240] as [number, number, number],
  SUCCESS:        [22,  163,  74] as [number, number, number],
  DANGER:         [220,  38,  38] as [number, number, number],
  AMBER:          [180, 120,  20] as [number, number, number],
};

// Legacy constant (kept for backward compat)
export const TEAL = { r: 20, g: 184, b: 166 };

// ── Layout types ──────────────────────────────────────────────────────────────

export type DocumentLayout = 'classic' | 'modern' | 'minimal';
export type DocumentType = 'invoice' | 'credit_note' | 'quote' | 'statement' | 'purchase_order';

// ── Company Details ────────────────────────────────────────────────────────────

export interface CompanyDetails {
  name: string;
  address: string;
  phone: string;
  email: string;
  vatNumber: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankBranchCode: string;
  bankReference: string;
  logoData: string | null;
  primaryColor: string;
  invoiceLayout: DocumentLayout;
  quoteLayout: DocumentLayout;
  statementLayout: DocumentLayout;
}

const COMPANY_SETTINGS_KEYS = [
  'company_name', 'company_address', 'company_phone', 'company_email',
  'company_vat_number', 'bank_name', 'bank_account_name',
  'bank_account_number', 'bank_branch_code',
] as const;

const FALLBACK_COMPANY_DETAILS: CompanyDetails = {
  name: 'Company Name Not Set',
  address: '', phone: '', email: '', vatNumber: '',
  bankName: '', bankAccountName: '', bankAccountNumber: '',
  bankBranchCode: '', bankReference: '',
  logoData: null, primaryColor: '#0d9488',
  invoiceLayout: 'classic', quoteLayout: 'classic', statementLayout: 'classic',
};

async function getCompanyDetailsFromSettings(): Promise<CompanyDetails> {
  try {
    const rows = await withSavepoint('pdf_company_settings', () => sql`
      SELECT key, value FROM app_settings
      WHERE key = ANY(${COMPANY_SETTINGS_KEYS as unknown as string[]})
    `);
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key as string] = String(row.value ?? '');
    }
    return {
      ...FALLBACK_COMPANY_DETAILS,
      name: settings.company_name || FALLBACK_COMPANY_DETAILS.name,
      address: settings.company_address || '',
      phone: settings.company_phone || '',
      email: settings.company_email || '',
      vatNumber: settings.company_vat_number || '',
      bankName: settings.bank_name || '',
      bankAccountName: settings.bank_account_name || '',
      bankAccountNumber: settings.bank_account_number || '',
      bankBranchCode: settings.bank_branch_code || '',
    };
  } catch (err) {
    log.warn(
      'Failed to load company settings for PDF, using fallbacks',
      { error: err instanceof Error ? err.message : String(err) },
      'pdfShared',
    );
    return FALLBACK_COMPANY_DETAILS;
  }
}

export async function getCompanyDetailsFromCompany(companyId: string): Promise<CompanyDetails> {
  let rows: DbRow[] = [];
  try {
    rows = await withSavepoint('pdf_company_lookup', () => sql`
      SELECT name, address_line1, address_line2, city, province, postal_code,
             phone, email, vat_number,
             bank_name, bank_account_number, bank_branch_code,
             logo_data, primary_color,
             invoice_layout, quote_layout, statement_layout
      FROM companies WHERE id = ${companyId}::UUID
    `);
  } catch (err) {
    log.warn(
      'Failed to load company from companies table, trying app_settings',
      { companyId, error: err instanceof Error ? err.message : String(err) },
      'pdfShared',
    );
    return getCompanyDetailsFromSettings();
  }

  if (rows.length === 0) {
    return getCompanyDetailsFromSettings();
  }

  const c = rows[0] as DbRow;
  const addressParts = [c.address_line1, c.address_line2, c.city, c.province, c.postal_code]
    .filter(Boolean).map(String);
  return {
    name: c.name ? String(c.name) : 'Company Name Not Set',
    address: addressParts.join(', '),
    phone: c.phone ? String(c.phone) : '',
    email: c.email ? String(c.email) : '',
    vatNumber: c.vat_number ? String(c.vat_number) : '',
    bankName: c.bank_name ? String(c.bank_name) : '',
    bankAccountName: c.name ? String(c.name) : '',
    bankAccountNumber: c.bank_account_number ? String(c.bank_account_number) : '',
    bankBranchCode: c.bank_branch_code ? String(c.bank_branch_code) : '',
    bankReference: '',
    logoData: c.logo_data ? String(c.logo_data) : null,
    primaryColor: c.primary_color ? String(c.primary_color) : '#0d9488',
    invoiceLayout: (c.invoice_layout ? String(c.invoice_layout) : 'classic') as DocumentLayout,
    quoteLayout: (c.quote_layout ? String(c.quote_layout) : 'classic') as DocumentLayout,
    statementLayout: (c.statement_layout ? String(c.statement_layout) : 'classic') as DocumentLayout,
  };
}

// ── Color helpers ─────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return TEAL;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return { r, g, b };
}

function darken(color: { r: number; g: number; b: number }, factor = 0.6): [number, number, number] {
  return [
    Math.round(color.r * factor),
    Math.round(color.g * factor),
    Math.round(color.b * factor),
  ];
}

// ── Premium Document Header ────────────────────────────────────────────────────

export interface PremiumHeaderOptions {
  doc: JsPdfDoc;
  pageW: number;
  margin: number;
  company: CompanyDetails;
  accent: { r: number; g: number; b: number };
  docType: DocumentType;
  docTitle: string;       // e.g. "TAX INVOICE", "QUOTATION", "CREDIT NOTE"
  docNumber: string;      // e.g. "INV-0042"
  docDate: string;        // formatted date string
  docSecondaryDate?: string; // "Due: xx/xx" or "Valid Until: xx/xx" or undefined
  docSecondaryLabel?: string; // label for secondary date
}

/**
 * Renders the premium full-bleed dark header with accent strip.
 * Returns the Y position to start body content.
 */
export function renderPremiumHeader(opts: PremiumHeaderOptions): number {
  const { doc, pageW, margin, company, accent, docTitle, docNumber, docDate,
    docSecondaryDate, docSecondaryLabel } = opts;

  // Header height grows to fit a stacked company-details block (address, email,
  // phone, VAT each on its own line) — matches the BILL TO style below and
  // avoids the cramped bullet-joined run-on. The block is the source of truth
  // for header height; we measure it before drawing the dark band so the
  // accent strip always lands at the bottom of the actual content.
  const STRIP_H = 3;
  const LOGO_SIZE = 26;
  const LOGO_TOP = 8;

  // Compose company info lines (stacked, like BILL TO).
  const infoLines: string[] = [];
  if (company.address) infoLines.push(company.address);
  if (company.email) infoLines.push(company.email);
  if (company.phone) infoLines.push(company.phone);
  if (company.vatNumber) infoLines.push(`VAT: ${company.vatNumber}`);

  const NAME_Y = 18;
  const INFO_LINE_H = 4.2;
  const INFO_FONT = 7.5;
  const NAME_FONT = 13;
  const infoStartY = NAME_Y + 6;

  // Pre-wrap address (and any other lines) to fit the available text column.
  const textLeftX = company.logoData ? margin + LOGO_SIZE + 4 : margin;
  const RIGHT_RESERVE = 70; // space reserved for doc number + dates on the right
  const textColW = pageW - textLeftX - RIGHT_RESERVE;
  const wrappedLines: string[] = [];
  for (const line of infoLines) {
    const parts = doc.splitTextToSize(line, textColW) as string[];
    wrappedLines.push(...parts);
  }

  const infoBottomY = infoStartY + Math.max(0, wrappedLines.length) * INFO_LINE_H;
  const logoBottomY = company.logoData ? LOGO_TOP + LOGO_SIZE : 0;
  const HEADER_H = Math.max(44, Math.max(infoBottomY, logoBottomY) + 4);

  // ── Dark background (now sized to content)
  doc.setFillColor(...COLORS.DARK);
  doc.rect(0, 0, pageW, HEADER_H, 'F');

  // ── Accent strip at bottom of header
  doc.setFillColor(accent.r, accent.g, accent.b);
  doc.rect(0, HEADER_H, pageW, STRIP_H, 'F');

  // ── Logo (if available)
  if (company.logoData) {
    try {
      doc.addImage(company.logoData, 'AUTO', margin, LOGO_TOP, LOGO_SIZE, LOGO_SIZE);
    } catch { /* skip broken logo */ }
  }

  // ── Company name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(NAME_FONT);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(company.name, textLeftX, NAME_Y);

  // ── Company sub-details — each on its own line
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(INFO_FONT);
  doc.setTextColor(...COLORS.HEADER_SUB);
  let cy = infoStartY;
  for (const line of wrappedLines) {
    doc.text(line, textLeftX, cy);
    cy += INFO_LINE_H;
  }

  // ── Right side: document type + number
  const rx = pageW - margin;

  // Document type label (small, uppercase, accent color)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(accent.r, accent.g, accent.b);
  doc.text(docTitle, rx, 13, { align: 'right' });

  // Document number (prominent)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COLORS.WHITE);
  doc.text(docNumber, rx, 25, { align: 'right' });

  // Date
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...COLORS.HEADER_SUB);
  doc.text(`Date: ${docDate}`, rx, 33, { align: 'right' });

  if (docSecondaryDate && docSecondaryLabel) {
    doc.text(`${docSecondaryLabel}: ${docSecondaryDate}`, rx, 39, { align: 'right' });
  }

  return HEADER_H + STRIP_H + 8; // y start for body content
}

// ── Party Info Section ─────────────────────────────────────────────────────────

export interface PartyInfo {
  label: string;   // e.g. "FROM", "BILL TO", "CREDIT TO"
  name: string;
  address?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  attention?: string;
}

/**
 * Render two-column FROM / TO party info section.
 * Returns new Y position after section.
 */
export function renderPartySection(
  doc: JsPdfDoc,
  y: number,
  pageW: number,
  margin: number,
  accent: { r: number; g: number; b: number },
  from: PartyInfo,
  to: PartyInfo,
): number {
  const midX = pageW / 2;
  const colW = midX - margin - 6;

  function renderParty(info: PartyInfo, x: number, startY: number): number {
    let cy = startY;

    // Label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(accent.r, accent.g, accent.b);
    doc.text(info.label, x, cy);
    cy += 1.5;

    // Thin underline
    doc.setDrawColor(accent.r, accent.g, accent.b);
    doc.setLineWidth(0.3);
    doc.line(x, cy, x + 28, cy);
    cy += 4.5;

    // Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...COLORS.TEXT_PRIMARY);
    doc.text(info.name, x, cy);
    cy += 5.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);

    if (info.address) {
      const lines = String(info.address).split('\n').flatMap(l =>
        doc.splitTextToSize(l.trim(), colW) as string[]
      );
      for (const line of lines) {
        if (line.trim()) { doc.text(line, x, cy); cy += 4; }
      }
    }
    if (info.attention) { doc.text(`Attn: ${info.attention}`, x, cy); cy += 4; }
    if (info.email) { doc.text(info.email, x, cy); cy += 4; }
    if (info.phone) { doc.text(info.phone, x, cy); cy += 4; }
    if (info.vatNumber) { doc.text(`VAT: ${info.vatNumber}`, x, cy); cy += 4; }

    return cy;
  }

  const leftBottom = renderParty(from, margin, y);
  const rightBottom = renderParty(to, midX + 4, y);

  // Thin vertical divider
  const divH = Math.max(leftBottom, rightBottom) - y;
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.3);
  doc.line(midX, y - 2, midX, y + divH - 2);

  return Math.max(leftBottom, rightBottom) + 6;
}

// ── Reference Strip ────────────────────────────────────────────────────────────

export interface RefField {
  label: string;
  value: string;
}

/**
 * Render a subtle reference info strip with N columns.
 * Returns new Y position.
 */
export function renderRefStrip(
  doc: JsPdfDoc,
  y: number,
  pageW: number,
  margin: number,
  fields: RefField[],
): number {
  const STRIP_H = 14;
  const contentW = pageW - margin * 2;

  doc.setFillColor(...COLORS.SURFACE);
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, y, contentW, STRIP_H, 1.5, 1.5, 'FD');

  const colW = contentW / fields.length;
  fields.forEach((field, i) => {
    const cx = margin + colW * i + 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...COLORS.TEXT_MUTED);
    doc.text(field.label.toUpperCase(), cx, y + 5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.TEXT_PRIMARY);
    doc.text(field.value, cx, y + 11);
  });

  return y + STRIP_H + 6;
}

// ── Premium Totals Block ───────────────────────────────────────────────────────

export interface TotalLine {
  label: string;
  value: string;
  isTotal?: boolean;
  isMuted?: boolean;
  [key: string]: unknown;
}

/**
 * Render right-aligned totals block. Returns new Y position.
 */
export function renderTotalsBlock(
  doc: JsPdfDoc,
  y: number,
  pageW: number,
  margin: number,
  accent: { r: number; g: number; b: number },
  lines: TotalLine[],
): number {
  const BLOCK_W = 75;
  const LEFT_X = pageW - margin - BLOCK_W;
  const RIGHT_X = pageW - margin;
  let cy = y;

  // Top divider
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.4);
  doc.line(LEFT_X, cy, RIGHT_X, cy);
  cy += 5;

  for (const line of lines) {
    if (line.isTotal) {
      // Add clear vertical breathing room above the accent box so its top
      // edge doesn't clip the descenders of the previous (Subtotal/VAT) row.
      cy += 3;
      // Accent fill box for total — vertically centered around the text
      // baseline with enough padding for cap-height + descender clearance.
      const BOX_H = 10;
      const BOX_TOP = cy - 7;
      doc.setFillColor(accent.r, accent.g, accent.b);
      doc.roundedRect(LEFT_X - 2, BOX_TOP, BLOCK_W + 4, BOX_H, 1, 1, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...COLORS.WHITE);
      doc.text(line.label, LEFT_X + 2, cy);
      doc.text(line.value, RIGHT_X - 2, cy, { align: 'right' });
      cy = BOX_TOP + BOX_H + 2;
    } else if (line.isMuted) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...COLORS.TEXT_SECONDARY);
      doc.text(line.label, LEFT_X, cy);
      doc.text(line.value, RIGHT_X, cy, { align: 'right' });
      cy += 5.5;
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.TEXT_SECONDARY);
      doc.text(line.label, LEFT_X, cy);
      doc.setTextColor(...COLORS.TEXT_PRIMARY);
      doc.text(line.value, RIGHT_X, cy, { align: 'right' });
      cy += 6;
    }
  }

  return cy + 4;
}

// ── Payment Details Block ──────────────────────────────────────────────────────

export function renderPaymentDetails(
  doc: JsPdfDoc,
  y: number,
  pageW: number,
  margin: number,
  accent: { r: number; g: number; b: number },
  company: CompanyDetails,
  reference: string,
): number {
  // Section header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(accent.r, accent.g, accent.b);
  doc.text('PAYMENT INFORMATION', margin, y);
  y += 2;
  doc.setDrawColor(accent.r, accent.g, accent.b);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + 40, y);
  y += 5;

  const fields = [
    { label: 'Bank', value: company.bankName || '—' },
    { label: 'Account Name', value: company.bankAccountName || company.name || '—' },
    { label: 'Account Number', value: company.bankAccountNumber || '—' },
    { label: 'Branch Code', value: company.bankBranchCode || '—' },
    { label: 'Reference', value: reference || '—' },
  ];

  const ROW_H = 5.5;
  const BOX_H = fields.length * ROW_H + 8;
  const CONTENT_W = pageW - margin * 2;

  doc.setFillColor(...COLORS.SURFACE);
  doc.setDrawColor(...COLORS.BORDER);
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, y, CONTENT_W * 0.55, BOX_H, 1.5, 1.5, 'FD');

  let ry = y + 5;
  for (const f of fields) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.TEXT_SECONDARY);
    doc.text(f.label, margin + 4, ry);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.TEXT_PRIMARY);
    doc.text(f.value, margin + 36, ry);
    ry += ROW_H;
  }

  return y + BOX_H + 6;
}

// ── Notes Block ───────────────────────────────────────────────────────────────

export function renderNotesBlock(
  doc: JsPdfDoc,
  y: number,
  pageW: number,
  margin: number,
  notes: string,
): number {
  const CONTENT_W = pageW - margin * 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  doc.text('NOTES', margin, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...COLORS.TEXT_SECONDARY);
  const noteLines = doc.splitTextToSize(notes, CONTENT_W * 0.7) as string[];
  doc.text(noteLines, margin, y);
  return y + noteLines.length * 4 + 4;
}

// ── Premium Page Footer ────────────────────────────────────────────────────────

export function renderPageFooters(
  doc: JsPdfDoc,
  pageW: number,
  pageH: number,
  margin: number,
  tagline = 'Thank you for your business.',
): void {
  const totalPages = (doc as { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);

    // Thin accent line (using TEAL default — will be overridden by callers if needed)
    doc.setDrawColor(...COLORS.BORDER);
    doc.setLineWidth(0.4);
    doc.line(margin, pageH - 12, pageW - margin, pageH - 12);

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.TEXT_MUTED);
    doc.text(tagline, margin, pageH - 7);

    doc.setFont('helvetica', 'normal');
    doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 7, { align: 'right' });
  }
}

// ── Legacy header shim (kept for backward compat) ─────────────────────────────

export interface InvoiceHeaderCtx {
  doc: JsPdfDoc;
  invoice: Record<string, unknown>;
  layout: DocumentLayout;
  pageW: number;
  margin: number;
  accent: { r: number; g: number; b: number };
  company: CompanyDetails;
}

/** @deprecated Use renderPremiumHeader instead */
export function renderInvoiceHeader(ctx: InvoiceHeaderCtx): number {
  const { doc, invoice, pageW, margin, accent, company } = ctx;
  return renderPremiumHeader({
    doc, pageW, margin, company, accent,
    docType: 'invoice',
    docTitle: 'TAX INVOICE',
    docNumber: String(invoice.invoice_number || ''),
    docDate: fmtDate(invoice.invoice_date as string | Date | null | undefined),
    docSecondaryDate: invoice.due_date ? fmtDate(invoice.due_date as string | Date | null | undefined) : undefined,
    docSecondaryLabel: 'Due',
  });
}

// Re-export darken for use in builders
export { darken };
