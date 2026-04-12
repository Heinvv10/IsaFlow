/**
 * PDF Shared Utilities — formatting helpers, company details, and branding constants.
 * Used by invoicePdfBuilder and creditNotePdfBuilder.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

// ── Formatting ────────────────────────────────────────────────────────────────

export const fmtZAR = (amount: number): string =>
  'R ' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Get the Y position after the last autoTable render (jspdf-autotable extension) */
export function getLastAutoTableY(doc: unknown, fallback: number): number {
  const d = doc as { lastAutoTable?: { finalY?: number } };
  return d.lastAutoTable?.finalY ?? fallback;
}

export const fmtDate = (d: string | Date | null | undefined): string => {
  if (!d) return '—';
  const str = d instanceof Date ? d.toISOString() : String(d);
  const parts = str.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return str;
};

// ── Branding ──────────────────────────────────────────────────────────────────

export const TEAL = { r: 20, g: 184, b: 166 }; // #14b8a6

// ── Layout types ──────────────────────────────────────────────────────────────

export type DocumentLayout = 'classic' | 'modern' | 'minimal';

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

async function getCompanyDetailsFromSettings(): Promise<CompanyDetails> {
  try {
    const rows = await sql`
      SELECT key, value FROM app_settings
      WHERE key = ANY(${COMPANY_SETTINGS_KEYS as unknown as string[]})
    `;
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key as string] = String(row.value ?? '');
    }
    return {
      name: settings.company_name || 'Company Name Not Set',
      address: settings.company_address || '',
      phone: settings.company_phone || '',
      email: settings.company_email || '',
      vatNumber: settings.company_vat_number || '',
      bankName: settings.bank_name || '',
      bankAccountName: settings.bank_account_name || '',
      bankAccountNumber: settings.bank_account_number || '',
      bankBranchCode: settings.bank_branch_code || '',
      bankReference: '',
      logoData: null,
      primaryColor: '#0d9488',
      invoiceLayout: 'classic',
      quoteLayout: 'classic',
      statementLayout: 'classic',
    };
  } catch {
    log.warn('Failed to load company settings for PDF, using fallbacks', {}, 'pdfShared');
    return {
      name: 'Company Name Not Set',
      address: '', phone: '', email: '', vatNumber: '',
      bankName: '', bankAccountName: '', bankAccountNumber: '',
      bankBranchCode: '', bankReference: '',
      logoData: null,
      primaryColor: '#0d9488',
      invoiceLayout: 'classic',
      quoteLayout: 'classic',
      statementLayout: 'classic',
    };
  }
}

/**
 * Load company details from the companies table, with fallback to app_settings.
 */
export async function getCompanyDetailsFromCompany(companyId: string): Promise<CompanyDetails> {
  try {
    const rows = await sql`
      SELECT name, address_line1, address_line2, city, province, postal_code,
             phone, email, vat_number,
             bank_name, bank_account_number, bank_branch_code,
             logo_data, primary_color,
             invoice_layout, quote_layout, statement_layout
      FROM companies WHERE id = ${companyId}::UUID
    `;
    if (rows.length > 0) {
      const c = rows[0] as Row;
      const addressParts = [c.address_line1, c.address_line2, c.city, c.province, c.postal_code].filter(Boolean).map(String);
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
  } catch {
    log.warn('Failed to load company from companies table, trying app_settings', {}, 'pdfShared');
  }
  return getCompanyDetailsFromSettings();
}

// ── Color helpers ─────────────────────────────────────────────────────────────

/** Parse a hex color string into r/g/b numbers, fallback to TEAL. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return TEAL;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return { r, g, b };
}

// ── Invoice header renderer ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsPdfDoc = any;

export interface InvoiceHeaderCtx {
  doc: JsPdfDoc;
  invoice: Record<string, unknown>;
  layout: DocumentLayout;
  pageW: number;
  margin: number;
  accent: { r: number; g: number; b: number };
  company: CompanyDetails;
}

/** Render page header bar and return Y position after header. */
export function renderInvoiceHeader(ctx: InvoiceHeaderCtx): number {
  const { doc, invoice, layout, pageW, margin, accent, company } = ctx;

  if (layout === 'minimal') {
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text('TAX INVOICE', margin, 14);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80, 80, 80);
    doc.text(String(invoice.invoice_number || ''), pageW - margin, 10, { align: 'right' });
    doc.text(`Date: ${fmtDate(invoice.invoice_date as string | Date | null | undefined)}`, pageW - margin, 15, { align: 'right' });
    doc.text(`Due: ${fmtDate(invoice.due_date as string | Date | null | undefined)}`, pageW - margin, 20, { align: 'right' });
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.4);
    doc.line(margin, 24, pageW - margin, 24);
    return 30;
  }

  if (layout === 'modern') {
    const bannerH = 36;
    doc.setFillColor(accent.r, accent.g, accent.b);
    doc.rect(0, 0, pageW, bannerH, 'F');
    if (company.logoData) {
      try { doc.addImage(company.logoData, 'AUTO', margin, 4, 28, 28); } catch { /* skip */ }
    }
    const textLeft = company.logoData ? margin + 32 : margin;
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('TAX INVOICE', textLeft, 20);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(String(invoice.invoice_number || ''), pageW - margin, 12, { align: 'right' });
    doc.setFontSize(8);
    doc.text(`Date: ${fmtDate(invoice.invoice_date as string | Date | null | undefined)}`, pageW - margin, 19, { align: 'right' });
    doc.text(`Due: ${fmtDate(invoice.due_date as string | Date | null | undefined)}`, pageW - margin, 25, { align: 'right' });
    return bannerH + 8;
  }

  // Classic (default)
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('TAX INVOICE', margin, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(String(invoice.invoice_number || ''), pageW - margin, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.text(`Date: ${fmtDate(invoice.invoice_date as string | Date | null | undefined)}`, pageW - margin, 18, { align: 'right' });
  doc.text(`Due: ${fmtDate(invoice.due_date as string | Date | null | undefined)}`, pageW - margin, 23, { align: 'right' });
  return 36;
}

// ── Page footer renderer ──────────────────────────────────────────────────────

/**
 * Render IsaFlow teal footer lines on every page of a jsPDF document.
 */
export function renderPageFooters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  pageW: number,
  pageH: number,
  margin: number,
): void {
  const totalPages = (doc as { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150, 150, 150);

    doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b);
    doc.setLineWidth(0.3);
    doc.line(margin, pageH - 12, pageW - margin, pageH - 12);

    doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 7, { align: 'right' });
    doc.text('Generated by IsaFlow', margin, pageH - 7);
  }
}
