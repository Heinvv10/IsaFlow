/**
 * A synthetic SCANNED supplier invoice: every page is a JPEG, so the PDF has
 * no text layer and capture must read it as pictures. No client data.
 *
 * Page 1 is a payment-request cover page (no invoice figures), page 2 is the
 * tax invoice with the known figures in INVOICE, page 3 is terms and
 * conditions, and pages 4+ are delivery paperwork. A real Velocity Fibre scan
 * has the same shape: the cover page the 2026-10-17 benchmark read 0/6 on.
 */
import { execFileSync } from 'child_process';

export const INVOICE = {
  vendorName: 'Karoo Cable Supplies (Pty) Ltd',
  vendorVatNumber: '4123456789',
  referenceNumber: 'KCS-20931',
  date: '2026-09-14',
  subtotal: 12150,
  vatAmount: 1822.5,
  totalAmount: 13972.5,
} as const;

const COVER = [
  'PAYMENT REQUEST',
  '',
  'Request no: PR-0042',
  'Requested on: 2026-09-20',
  'Requested by: Procurement',
  'Department: Network Build',
  'Supplier: see attached invoice',
  'Approved by: ____________________',
  '',
  'Please pay the attached supplier invoice.',
];
const INVOICE_PAGE = [
  'TAX INVOICE',
  '',
  INVOICE.vendorName,
  '12 Station Road, Beaufort West, 6970',
  `VAT No: ${INVOICE.vendorVatNumber}`,
  '',
  `Invoice No: ${INVOICE.referenceNumber}`,
  `Invoice Date: ${INVOICE.date}`,
  'Bill To: Example Fibre Co (Pty) Ltd',
  '',
  'Description            Qty   Unit price      Total',
  'Drop cable 1 km          2     4 250.00   8 500.00',
  'Splice closure          10       365.00   3 650.00',
  '',
  'Subtotal                               R 12 150.00',
  'VAT 15%                                 R 1 822.50',
  'TOTAL DUE                              R 13 972.50',
];
const TERMS = [
  'TERMS AND CONDITIONS',
  '',
  '1. Payment is due 30 days from the invoice date.',
  '2. Goods remain our property until paid in full.',
  '3. Interest is charged on overdue accounts.',
  '4. Errors and omissions excepted.',
];
const delivery = (n: number) => [
  'DELIVERY NOTE',
  '',
  `Delivery note: DN-${7700 + n}`,
  'Received in good order by: ____________',
];

/** Page `i` (1-based) of the scan, as lines of text. */
function pageLines(i: number): string[] {
  if (i === 1) return COVER;
  if (i === 2) return INVOICE_PAGE;
  if (i === 3) return TERMS;
  return delivery(i);
}

/** A one-page PDF with `lines` drawn in Courier: the source that is rasterised. */
function textPagePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = lines.map((l, i) => `BT /F1 14 Tf 60 ${740 - i * 24} Td (${esc(l)}) Tj ET`).join('\n');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ].map((o) => Buffer.from(o, 'latin1')));
}

function assemble(objs: Buffer[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(part);
    length += part.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const DPI = 150;
const WIDTH = 612 * DPI / 72;
const HEIGHT = 792 * DPI / 72;

/** A greyscale JPEG of the page, through the real Ghostscript. */
function rasterise(pdf: Buffer): Buffer {
  return execFileSync('gs', [
    '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeggray', `-r${DPI}`, '-sOutputFile=-', '-',
  ], { input: pdf, maxBuffer: 20 * 1024 * 1024 });
}

/** A `pages`-page image-only PDF (pages ≥ 1). */
export function buildScanInvoicePdf(pages: number): Buffer {
  const jpegs = Array.from({ length: pages }, (_, i) => rasterise(textPagePdf(pageLines(i + 1))));
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from(`<< /Type /Pages /Kids [${jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${pages} >>`, 'latin1'),
  ];
  const draw = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
  jpegs.forEach((jpeg, i) => {
    const page = 3 + i * 3;
    objs.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R `
      + `/Resources << /XObject << /Im0 ${page + 2} 0 R >> >> >>`, 'latin1'));
    objs.push(Buffer.from(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`, 'latin1'));
    objs.push(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${WIDTH} /Height ${HEIGHT} /ColorSpace /DeviceGray `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]));
  });
  return assemble(objs);
}
