/**
 * Invoice & Credit Note PDF Generator
 * Server-side PDF generation using jsPDF + jspdf-autotable
 * Returns Buffer for API responses and email attachments
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ─── Currency Formatting ────────────────────────────────────────────────────

const fmtZAR = (amount: number): string =>
  'R ' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtDate = (d: string | Date | null | undefined): string => {
  if (!d) return '—';
  const str = d instanceof Date ? d.toISOString() : String(d);
  const parts = str.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return str;
};

// ─── Company Details (loaded from DB settings) ─────────────────────────────

interface CompanyDetails {
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
}

const COMPANY_SETTINGS_KEYS = [
  'company_name', 'company_address', 'company_phone', 'company_email',
  'company_vat_number', 'bank_name', 'bank_account_name',
  'bank_account_number', 'bank_branch_code',
] as const;

async function getCompanyDetails(): Promise<CompanyDetails> {
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
    };
  } catch {
    log.warn('Failed to load company settings for PDF, using fallbacks', {}, 'invoicePdf');
    return {
      name: 'Company Name Not Set',
      address: '', phone: '', email: '', vatNumber: '',
      bankName: '', bankAccountName: '', bankAccountNumber: '',
      bankBranchCode: '', bankReference: '',
    };
  }
}

async function getCompanyDetailsFromCompany(companyId: string): Promise<CompanyDetails> {
  try {
    const rows = await sql`
      SELECT name, address_line1, address_line2, city, province, postal_code,
             phone, email, vat_number,
             bank_name, bank_account_number, bank_branch_code
      FROM companies WHERE id = ${companyId}::UUID
    `;
    if (rows.length > 0) {
      const c = rows[0] as Row;
      const addressParts = [c.address_line1, c.address_line2, c.city, c.province, c.postal_code].filter(Boolean);
      return {
        name: c.name || 'Company Name Not Set',
        address: addressParts.join(', '),
        phone: c.phone || '',
        email: c.email || '',
        vatNumber: c.vat_number || '',
        bankName: c.bank_name || '',
        bankAccountName: c.name || '',
        bankAccountNumber: c.bank_account_number || '',
        bankBranchCode: c.bank_branch_code || '',
        bankReference: '',
      };
    }
  } catch {
    log.warn('Failed to load company from companies table, trying app_settings', {}, 'invoicePdf');
  }
  return getCompanyDetails();
}

const TEAL = { r: 20, g: 184, b: 166 }; // #14b8a6

// ─── Invoice PDF ────────────────────────────────────────────────────────────

export async function generateInvoicePdf(companyId: string, invoiceId: string): Promise<Buffer> {
  // Load company details from companies table (with fallback to app_settings)
  const COMPANY = await getCompanyDetailsFromCompany(companyId);

  // Fetch invoice with client details
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

  if (invoiceRows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  const invoice = invoiceRows[0];

  // Fetch line items
  const items = (await sql`
    SELECT * FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID
    ORDER BY created_at
  `) as Row[];

  log.info('Generating invoice PDF', {
    invoiceId,
    invoiceNumber: invoice.invoice_number,
    itemCount: items.length,
  }, 'invoicePdfService');

  // Dynamic import to keep jsPDF out of initial bundles
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // ── Teal Header Bar ────────────────────────────────────────────────────
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(0, 0, PAGE_W, 28, 'F');

  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('TAX INVOICE', MARGIN, 18);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(invoice.invoice_number || '', PAGE_W - MARGIN, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.text(`Date: ${fmtDate(invoice.invoice_date)}`, PAGE_W - MARGIN, 18, { align: 'right' });
  doc.text(`Due: ${fmtDate(invoice.due_date)}`, PAGE_W - MARGIN, 23, { align: 'right' });

  let y = 36;

  // ── Company Details (left) vs Client Details (right) ──────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(COMPANY.name, MARGIN, y);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  y += 5;
  doc.text(COMPANY.address, MARGIN, y);
  y += 4;
  doc.text(`Tel: ${COMPANY.phone}`, MARGIN, y);
  y += 4;
  doc.text(`Email: ${COMPANY.email}`, MARGIN, y);
  y += 4;
  doc.text(`VAT No: ${COMPANY.vatNumber}`, MARGIN, y);

  // Client details on the right
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
  doc.text(invoice.client_name || 'Unknown Client', rightX, ry);
  ry += 5;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);

  if (invoice.client_address) {
    const addressLines = String(invoice.client_address).split('\n');
    for (const line of addressLines) {
      doc.text(line.trim(), rightX, ry);
      ry += 4;
    }
  }
  if (invoice.client_contact) {
    doc.text(`Attn: ${invoice.client_contact}`, rightX, ry);
    ry += 4;
  }
  if (invoice.client_email) {
    doc.text(invoice.client_email, rightX, ry);
    ry += 4;
  }
  if (invoice.client_phone) {
    doc.text(`Tel: ${invoice.client_phone}`, rightX, ry);
    ry += 4;
  }
  if (invoice.client_vat) {
    doc.text(`VAT No: ${invoice.client_vat}`, rightX, ry);
    ry += 4;
  }

  y = Math.max(y, ry) + 6;

  // ── Reference / Billing period info bar ────────────────────────────────
  doc.setFillColor(245, 247, 250);
  doc.setDrawColor(210, 215, 225);
  doc.roundedRect(MARGIN, y, CONTENT_W, 12, 1.5, 1.5, 'FD');

  const refCols = [
    { label: 'Invoice #', value: invoice.invoice_number || '' },
    { label: 'Project', value: invoice.project_name || '—' },
    { label: 'Period', value: invoice.billing_period_start ? `${fmtDate(invoice.billing_period_start)} - ${fmtDate(invoice.billing_period_end)}` : '—' },
    { label: 'Terms', value: invoice.due_date ? `Due ${fmtDate(invoice.due_date)}` : 'On receipt' },
  ];

  const colW = CONTENT_W / refCols.length;
  refCols.forEach((col, i) => {
    const cx = MARGIN + colW * i + 4;
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120, 120, 120);
    doc.text(col.label.toUpperCase(), cx, y + 4);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text(col.value, cx, y + 9);
  });

  y += 18;

  // ── Line Items Table ──────────────────────────────────────────────────
  const tableRows = items.map((item: Row) => [
    item.description || '—',
    Number(item.quantity).toFixed(2),
    fmtZAR(Number(item.unit_price)),
    fmtZAR(Number(item.tax_amount || 0)),
    fmtZAR(Number(item.line_total || item.amount || 0)),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']],
    body: tableRows,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: {
      fillColor: [TEAL.r, TEAL.g, TEAL.b],
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 8.5,
    },
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

  // Get cursor position after table
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable?.finalY || y + 40;
  y += 6;

  // ── Totals Section ────────────────────────────────────────────────────
  const totalsX = PAGE_W - MARGIN - 70;
  const totalsW = 70;
  const subtotal = Number(invoice.subtotal || 0);
  const taxAmount = Number(invoice.tax_amount || 0);
  const totalAmount = Number(invoice.total_amount || 0);
  const amountPaid = Number(invoice.amount_paid || 0);
  const balanceDue = totalAmount - amountPaid;

  const totalsData = [
    { label: 'Subtotal', value: fmtZAR(subtotal) },
    { label: `VAT (${Number(invoice.tax_rate || 15)}%)`, value: fmtZAR(taxAmount) },
    { label: 'Total', value: fmtZAR(totalAmount), bold: true },
  ];

  if (amountPaid > 0) {
    totalsData.push({ label: 'Paid', value: `(${fmtZAR(amountPaid)})`, bold: false });
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

  // ── Payment Details ───────────────────────────────────────────────────
  if (y + 40 > PAGE_H - 30) {
    doc.addPage();
    y = MARGIN + 10;
  }

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('PAYMENT DETAILS', MARGIN, y);
  y += 5;

  doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, MARGIN + 50, y);
  y += 5;

  const paymentDetails = [
    { label: 'Bank', value: COMPANY.bankName },
    { label: 'Account Name', value: COMPANY.bankAccountName },
    { label: 'Account Number', value: COMPANY.bankAccountNumber },
    { label: 'Branch Code', value: COMPANY.bankBranchCode },
    { label: 'Reference', value: invoice.invoice_number || '' },
  ];

  doc.setFontSize(8);
  paymentDetails.forEach((pd) => {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60, 60, 60);
    doc.text(`${pd.label}:`, MARGIN, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    doc.text(pd.value, MARGIN + 32, y);
    y += 5;
  });

  y += 5;

  // ── Notes ─────────────────────────────────────────────────────────────
  if (invoice.notes) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(80, 80, 80);
    doc.text('Notes:', MARGIN, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    const noteLines = doc.splitTextToSize(String(invoice.notes), CONTENT_W);
    doc.text(noteLines, MARGIN, y);
    y += noteLines.length * 4 + 4;
  }

  // ── Terms ─────────────────────────────────────────────────────────────
  if (y + 20 > PAGE_H - 20) {
    doc.addPage();
    y = MARGIN + 10;
  }

  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(130, 130, 130);
  doc.text('Terms & Conditions: Payment is due within the stated terms. Late payments may incur interest at 2% per month.', MARGIN, y);
  y += 4;
  doc.text('E&OE - Errors and Omissions Excepted. Please advise of any discrepancies within 7 days.', MARGIN, y);

  // ── Page footers ──────────────────────────────────────────────────────
  const totalPages = (doc as typeof doc & { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150, 150, 150);

    // Teal footer line
    doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, PAGE_H - 12, PAGE_W - MARGIN, PAGE_H - 12);

    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 7, { align: 'right' });
    doc.text('Generated by IsaFlow', MARGIN, PAGE_H - 7);
  }

  // Return as Buffer for Node.js API usage
  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

// ─── Credit Note PDF ────────────────────────────────────────────────────────

export async function generateCreditNotePdf(companyId: string, creditNoteId: string): Promise<Buffer> {
  const COMPANY = await getCompanyDetailsFromCompany(companyId);

  // Fetch credit note with client/supplier details
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

  if (rows.length === 0) {
    throw new Error(`Credit note not found: ${creditNoteId}`);
  }

  const cn = rows[0];

  log.info('Generating credit note PDF', {
    creditNoteId,
    creditNoteNumber: cn.credit_note_number,
  }, 'invoicePdfService');

  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const MARGIN = 14;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // ── Header Bar (Teal) ─────────────────────────────────────────────────
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

  // ── Company Details (left) ────────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(COMPANY.name, MARGIN, y);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  y += 5;
  doc.text(COMPANY.address, MARGIN, y);
  y += 4;
  doc.text(`VAT No: ${COMPANY.vatNumber}`, MARGIN, y);
  y += 4;
  doc.text(`Email: ${COMPANY.email}`, MARGIN, y);

  // ── Recipient Details (right) ─────────────────────────────────────────
  const rightX = PAGE_W / 2 + 10;
  let ry = 36;
  const entityName = cn.type === 'customer' ? cn.client_name : cn.supplier_name;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('CREDIT TO:', rightX, ry);
  ry += 5;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text(entityName || 'Unknown', rightX, ry);
  ry += 5;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);

  if (cn.type === 'customer') {
    if (cn.client_address) {
      const addressLines = String(cn.client_address).split('\n');
      for (const line of addressLines) {
        doc.text(line.trim(), rightX, ry);
        ry += 4;
      }
    }
    if (cn.client_vat) {
      doc.text(`VAT No: ${cn.client_vat}`, rightX, ry);
      ry += 4;
    }
  }

  y = Math.max(y, ry) + 8;

  // ── Credit Note Details ───────────────────────────────────────────────
  const detailRows = [
    ['Credit Note Number', cn.credit_note_number || '—'],
    ['Type', cn.type === 'customer' ? 'Customer Credit Note' : 'Supplier Credit Note'],
    ['Credit Date', fmtDate(cn.credit_date)],
    ['Original Invoice', cn.original_invoice_number || '—'],
    ['Reason', cn.reason || '—'],
  ];

  autoTable(doc, {
    startY: y,
    body: detailRows,
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

  // ── Totals ────────────────────────────────────────────────────────────
  const subtotal = Number(cn.subtotal || 0);
  const taxAmount = Number(cn.tax_amount || 0);
  const totalAmount = Number(cn.total_amount || 0);

  const totalsRows = [
    ['Subtotal', fmtZAR(subtotal)],
    [`VAT (${Number(cn.tax_rate || 15)}%)`, fmtZAR(taxAmount)],
    ['Total Credit', fmtZAR(totalAmount)],
  ];

  autoTable(doc, {
    startY: y,
    body: totalsRows,
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

  // ── Status badge ──────────────────────────────────────────────────────
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(80, 80, 80);
  doc.text(`Status: ${(cn.status || 'draft').toUpperCase()}`, MARGIN, y);

  if (cn.approved_by) {
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.text(`Approved by: ${cn.approved_by} on ${fmtDate(cn.approved_at)}`, MARGIN, y);
  }

  // ── Page footers ──────────────────────────────────────────────────────
  const totalPages = (doc as typeof doc & { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(150, 150, 150);

    doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, PAGE_H - 12, PAGE_W - MARGIN, PAGE_H - 12);

    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 7, { align: 'right' });
    doc.text('Generated by IsaFlow', MARGIN, PAGE_H - 7);
  }

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}
