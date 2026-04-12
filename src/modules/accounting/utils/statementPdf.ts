/**
 * Customer Statement PDF Generator — premium design.
 * Produces a portrait A4 PDF statement for a single customer.
 * Dynamically imports jsPDF + jspdf-autotable (browser-side lazy load).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatementTransaction {
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementData {
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  asAtDate: string;
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
  balanceOutstanding: number;
  transactions: StatementTransaction[];
  companyName?: string;
  companyVatNumber?: string;
  companyEmail?: string;
  companyPhone?: string;
  companyAddress?: string;
  accentColor?: string; // hex, e.g. "#0d9488"
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtR = (n: number): string =>
  'R\u00a0' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtD = (d: string): string => {
  if (!d) return '—';
  const parts = d.split('T')[0]?.split('-') ?? [];
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

function hexToTriple(hex: string): [number, number, number] {
  const c = hex.replace('#', '');
  if (c.length !== 6) return [20, 184, 166];
  return [parseInt(c.slice(0,2), 16), parseInt(c.slice(2,4), 16), parseInt(c.slice(4,6), 16)];
}

const DARK:   [number,number,number] = [15,  23,  42];
const WHITE:  [number,number,number] = [255, 255, 255];
const MUTED:  [number,number,number] = [148, 163, 184];
const BORDER: [number,number,number] = [226, 232, 240];
const SURF:   [number,number,number] = [248, 250, 252];
const TPRI:   [number,number,number] = [15,  23,  42];
const TSEC:   [number,number,number] = [100, 116, 139];

// ─── Main Export ──────────────────────────────────────────────────────────────

// 🟢 WORKING: generateStatementPdf
export async function generateStatementPdf(data: StatementData): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const accent = hexToTriple(data.accentColor || '#0d9488');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 14;

  // ── Header ────────────────────────────────────────────────────────────────
  const HDR_H = 42;
  const STRIP_H = 3;

  doc.setFillColor(...DARK);
  doc.rect(0, 0, PAGE_W, HDR_H, 'F');

  doc.setFillColor(...accent);
  doc.rect(0, HDR_H, PAGE_W, STRIP_H, 'F');

  // Left: company info
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...WHITE);
  doc.text(data.companyName || 'Company', M, 19);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(180, 195, 215);
  const subLeft: string[] = [];
  if (data.companyEmail) subLeft.push(data.companyEmail);
  if (data.companyPhone) subLeft.push(data.companyPhone);
  if (data.companyVatNumber) subLeft.push(`VAT: ${data.companyVatNumber}`);
  if (subLeft.length) doc.text(subLeft.join('  •  '), M, 26);
  if (data.companyAddress) {
    doc.setFontSize(7);
    doc.text(data.companyAddress, M, 32);
  }

  // Right: document type + client
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...accent);
  doc.text('ACCOUNT STATEMENT', PAGE_W - M, 13, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...WHITE);
  doc.text(data.clientName, PAGE_W - M, 25, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(180, 195, 215);
  if (data.clientEmail) doc.text(data.clientEmail, PAGE_W - M, 32, { align: 'right' });
  if (data.clientPhone) doc.text(data.clientPhone, PAGE_W - M, 37.5, { align: 'right' });

  let y = HDR_H + STRIP_H + 8;

  // ── As At date strip ──────────────────────────────────────────────────────
  const CONTENT_W = PAGE_W - M * 2;
  doc.setFillColor(...SURF);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.roundedRect(M, y, CONTENT_W, 10, 1.5, 1.5, 'FD');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text('STATEMENT DATE', M + 4, y + 4);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...TPRI);
  doc.text(fmtD(data.asAtDate), M + 4, y + 9);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text('GENERATED', PAGE_W - M - 50, y + 4);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...TPRI);
  doc.text(new Date().toLocaleDateString('en-ZA'), PAGE_W - M - 50, y + 9);

  y += 16;

  // ── Summary cards ─────────────────────────────────────────────────────────
  const CARD_W = (CONTENT_W - 9) / 4;
  const CARD_H = 20;
  const summaryItems = [
    { label: 'Total Invoiced',   value: data.totalInvoiced,      color: TPRI },
    { label: 'Total Paid',       value: data.totalPaid,          color: [22, 163, 74]  as [number,number,number] },
    { label: 'Credits Applied',  value: data.totalCredits,       color: TPRI },
    { label: 'Balance Due',      value: data.balanceOutstanding, color: data.balanceOutstanding > 0 ? [220,38,38] as [number,number,number] : [22,163,74] as [number,number,number] },
  ];

  summaryItems.forEach((item, i) => {
    const cx = M + i * (CARD_W + 3);
    const isLast = i === 3;

    if (isLast && data.balanceOutstanding > 0) {
      doc.setFillColor(...accent);
    } else {
      doc.setFillColor(...SURF);
    }
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.3);
    doc.roundedRect(cx, y, CARD_W, CARD_H, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(isLast && data.balanceOutstanding > 0 ? 220 : MUTED[0], isLast && data.balanceOutstanding > 0 ? 220 : MUTED[1], isLast && data.balanceOutstanding > 0 ? 220 : MUTED[2]);
    doc.text(item.label.toUpperCase(), cx + CARD_W / 2, y + 6.5, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(isLast && data.balanceOutstanding > 0 ? 255 : item.color[0], isLast && data.balanceOutstanding > 0 ? 255 : item.color[1], isLast && data.balanceOutstanding > 0 ? 255 : item.color[2]);
    doc.text(fmtR(item.value), cx + CARD_W / 2, y + 15, { align: 'center' });
  });

  y += CARD_H + 8;

  // ── Transactions table ────────────────────────────────────────────────────
  const typeLabels: Record<string, string> = {
    invoice:     'Invoice',
    payment:     'Payment',
    credit_note: 'Credit Note',
  };

  const tableRows = data.transactions.map(t => [
    fmtD(t.date),
    typeLabels[t.type] || t.type,
    t.reference || '—',
    t.description?.substring(0, 38) || '—',
    t.debit  > 0 ? fmtR(t.debit)  : '',
    t.credit > 0 ? fmtR(t.credit) : '',
    fmtR(t.balance),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Date', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance']],
    body: tableRows,
    styles: {
      fontSize: 7.5,
      cellPadding: { top: 3.5, bottom: 3.5, left: 3, right: 3 },
      textColor: TPRI,
    },
    headStyles: {
      fillColor: DARK,
      textColor: WHITE,
      fontStyle: 'bold',
      fontSize: 7,
      cellPadding: { top: 5, bottom: 5, left: 3, right: 3 },
    },
    alternateRowStyles: { fillColor: SURF },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { cellWidth: 20 },
      2: { cellWidth: 24 },
      3: { cellWidth: 'auto' },
      4: { halign: 'right', cellWidth: 24, textColor: [220, 38, 38] as [number,number,number] },
      5: { halign: 'right', cellWidth: 24, textColor: [22, 163, 74]  as [number,number,number] },
      6: { halign: 'right', cellWidth: 24, fontStyle: 'bold' },
    },
    tableWidth: CONTENT_W,
    margin: { left: M, right: M },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didDrawCell: (data: any) => {
      // Highlight rows where balance is overdue (debit > 0, balance > 0)
      if (data.section === 'body' && data.column.index === 6) {
        const row = tableRows[data.row.index];
        if (row && data.row.raw[4] !== '' && Number(data.row.raw[6]?.replace(/[^0-9.-]/g, '')) > 0) {
          // debit row — already colored by column style
        }
      }
    },
  });

  // ── Page footers ──────────────────────────────────────────────────────────
  const totalPages = (doc as unknown as { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.4);
    doc.line(M, PAGE_H - 12, PAGE_W - M, PAGE_H - 12);

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('This statement is for account reconciliation purposes only. Please contact us for any discrepancies.', M, PAGE_H - 7);

    doc.setFont('helvetica', 'normal');
    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - M, PAGE_H - 7, { align: 'right' });
  }

  // Suppress unused TSEC
  void TSEC;

  return doc.output('blob');
}
