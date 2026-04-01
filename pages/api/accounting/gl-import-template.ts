/**
 * GL Import Template API
 * GET /api/accounting/gl-import-template
 * Returns an Excel (.xlsx) template file with headers and 2 sample rows.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCompany } from '@/lib/auth';
import ExcelJS from 'exceljs';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const wb = new ExcelJS.Workbook();

  // ── GL Import sheet ──────────────────────────────────────────────────────────

  const ws = wb.addWorksheet('GL Import');

  ws.columns = [
    { header: 'Date',         key: 'date',        width: 14 },
    { header: 'Account Code', key: 'accountCode',  width: 16 },
    { header: 'Description',  key: 'description',  width: 36 },
    { header: 'Reference',    key: 'reference',    width: 20 },
    { header: 'Debit',        key: 'debit',        width: 14 },
    { header: 'Credit',       key: 'credit',       width: 14 },
    { header: 'VAT Code',     key: 'vatCode',      width: 16 },
    { header: 'Cost Centre',  key: 'costCentre',   width: 16 },
  ];

  ws.addRow(['2026-04-01', '1000', 'Opening bank balance', 'OB-2026-001', 50000, 0, 'no_vat', '']);
  ws.addRow(['2026-04-01', '3100', 'Opening bank balance', 'OB-2026-001', 0, 50000, 'no_vat', '']);

  // ── VAT Codes reference sheet ────────────────────────────────────────────────

  const notes = wb.addWorksheet('VAT Codes');
  notes.columns = [
    { header: 'VAT Code',    key: 'code',  width: 20 },
    { header: 'Description', key: 'desc',  width: 36 },
  ];

  const vatCodes = [
    ['standard',       '15% standard rate'],
    ['zero_rated',     '0% zero-rated supplies'],
    ['exempt',         'Exempt from VAT'],
    ['capital_goods',  'Standard-rated capital goods'],
    ['export',         'Zero-rated exports'],
    ['imported',       'Imported goods/services'],
    ['reverse_charge', 'Domestic reverse charge (DRC)'],
    ['bad_debt',       'Bad debt recovery'],
    ['no_vat',         'No VAT applicable'],
  ];

  vatCodes.forEach(([code, desc]) => notes.addRow([code, desc]));

  // ── Write to buffer ──────────────────────────────────────────────────────────

  const buf = await wb.xlsx.writeBuffer();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="isaflow-gl-import-template.xlsx"');
  res.setHeader('Content-Length', buf.byteLength);
  res.status(200).send(buf);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
