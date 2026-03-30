/**
 * GL Import Template API
 * GET /api/accounting/gl-import-template
 * Returns an Excel (.xlsx) template file with headers and 2 sample rows.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCompany } from '@/lib/auth';
import * as XLSX from 'xlsx';

function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const headers = [
    'Date',
    'Account Code',
    'Description',
    'Reference',
    'Debit',
    'Credit',
    'VAT Code',
    'Cost Centre',
  ];

  const sampleRows = [
    [
      '2026-04-01',
      '1000',
      'Opening bank balance',
      'OB-2026-001',
      50000,
      0,
      'no_vat',
      '',
    ],
    [
      '2026-04-01',
      '3100',
      'Opening bank balance',
      'OB-2026-001',
      0,
      50000,
      'no_vat',
      '',
    ],
  ];

  const wsData = [headers, ...sampleRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  ws['!cols'] = [
    { wch: 12 }, // Date
    { wch: 14 }, // Account Code
    { wch: 35 }, // Description
    { wch: 18 }, // Reference
    { wch: 12 }, // Debit
    { wch: 12 }, // Credit
    { wch: 14 }, // VAT Code
    { wch: 14 }, // Cost Centre
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'GL Import');

  // Add a Notes sheet with VAT code reference
  const notesData = [
    ['VAT Code Reference'],
    ['standard', '15% standard rate'],
    ['zero_rated', '0% zero-rated supplies'],
    ['exempt', 'Exempt from VAT'],
    ['capital_goods', 'Standard-rated capital goods'],
    ['export', 'Zero-rated exports'],
    ['imported', 'Imported goods/services'],
    ['reverse_charge', 'Domestic reverse charge (DRC)'],
    ['bad_debt', 'Bad debt recovery'],
    ['no_vat', 'No VAT applicable'],
  ];
  const notesWs = XLSX.utils.aoa_to_sheet(notesData);
  notesWs['!cols'] = [{ wch: 18 }, { wch: 35 }];
  XLSX.utils.book_append_sheet(wb, notesWs, 'VAT Codes');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="isaflow-gl-import-template.xlsx"');
  res.setHeader('Content-Length', buf.length);
  res.status(200).send(buf);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
