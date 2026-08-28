/**
 * GET /api/accounting/assets/far-report-xlsx?asAt=YYYY-MM-DD
 * Streams an ExcelJS workbook of the Fixed Asset Register as an .xlsx download.
 */

import type { NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiLogger } from '@/lib/logger';

type Row = Record<string, unknown>;

const toNum = (v: unknown) => Number(v ?? 0);
const toStr = (v: unknown) => (v instanceof Date ? fmtDate(v) : String(v ?? ''));

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const { asAt } = req.query as { asAt?: string };
  const asAtDate = asAt ?? new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(asAtDate)) {
    res.status(400).json({ success: false, error: 'asAt must be YYYY-MM-DD' });
    return;
  }

  const asAtYYYYMM = asAtDate.replace(/-/g, '').slice(0, 6);
  apiLogger.info({ companyId, asAtDate }, 'FAR xlsx export requested');

  const companyRows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1`) as Row[];
  const companyName = (companyRows[0]?.name as string) ?? 'Company';

  const rows = (await sql`
    SELECT DISTINCT ON (apl.asset_id)
      a.id                                  AS asset_id,
      a.asset_number,
      a.name                                AS asset_name,
      a.status,
      a.below_threshold,
      c.code                                AS category_code,
      c.name                                AS category_name,
      COALESCE(c.ias16_group, 'OA')         AS ias16_group,
      COALESCE(c.tax_code, c.code)          AS tax_code,
      COALESCE(a.tax_useful_life_years,
               c.tax_life_years)            AS tax_life_years,
      COALESCE(a.useful_life_years,
               c.useful_life_years)         AS policy_life_years,
      COALESCE(c.residual_pct, 0)           AS residual_pct,
      apl.policy_cost,
      apl.policy_closing_acc_dep            AS policy_acc_dep,
      apl.policy_carrying_amount            AS policy_ca,
      apl.policy_current_dep               AS policy_current_dep,
      apl.policy_profit_loss,
      apl.tax_cost,
      apl.tax_closing_acc_dep              AS tax_acc_dep,
      apl.tax_carrying_amount              AS tax_ca,
      apl.tax_current_dep                  AS tax_current_dep,
      apl.tax_profit_loss,
      apl.deferred_tax
    FROM asset_period_ledger apl
    JOIN assets a ON a.id = apl.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    WHERE apl.company_id = ${companyId}::UUID
      AND apl.yyyymm <= ${asAtYYYYMM}
    ORDER BY apl.asset_id, apl.yyyymm DESC
  `) as Row[];

  // ── Build workbook ────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISAFlow';
  wb.created = new Date();

  const ws = wb.addWorksheet('FAR');

  // Title row
  ws.mergeCells('A1:S1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `${companyName} — Fixed Asset Register — as at ${asAtDate}`;
  titleCell.font = { bold: true, size: 13 };
  titleCell.alignment = { horizontal: 'left' };
  ws.getRow(1).height = 22;

  // Blank row
  ws.addRow([]);

  // Column headers
  const headers = [
    'Asset #', 'Description', 'Code', 'IAS16', 'Tax Life', 'Policy Life', 'Res%', 'Status',
    'Policy Cost', 'Policy Acc Dep', 'Policy CA', 'Policy Curr Dep', 'Policy P/L',
    'Tax Cost', 'Tax Acc Dep', 'Tax CA', 'Tax Curr Dep', 'Tax P/L',
    'Def Tax',
  ];
  const hdrRow = ws.addRow(headers);
  hdrRow.eachCell(cell => {
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: { style: 'thin' } };
  });
  // Colour policy headers green, tax blue, deferred violet
  const policyIdxs = [9, 10, 11, 12, 13];
  const taxIdxs = [14, 15, 16, 17, 18];
  policyIdxs.forEach(i => { hdrRow.getCell(i).font = { bold: true, color: { argb: 'FF34D399' }, size: 10 }; });
  taxIdxs.forEach(i => { hdrRow.getCell(i).font = { bold: true, color: { argb: 'FF38BDF8' }, size: 10 }; });
  hdrRow.getCell(19).font = { bold: true, color: { argb: 'FFC084FC' }, size: 10 };

  // Set column widths
  const colWidths = [10, 32, 8, 7, 9, 10, 6, 9, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14];
  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const numFmt = '#,##0.00';
  const numCols = new Set([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  let policyCostTot = 0, policyAccDepTot = 0, policyCAot = 0, policyCurrentDepTot = 0;
  let taxCostTot = 0, taxAccDepTot = 0, taxCAot = 0, taxCurrentDepTot = 0, deferredTaxTot = 0;

  // Data rows
  for (const r of rows) {
    const policyCost = toNum(r.policy_cost);
    const policyAccDep = toNum(r.policy_acc_dep);
    const policyCA = toNum(r.policy_ca);
    const policyCurrentDep = toNum(r.policy_current_dep);
    const policyPL = toNum(r.policy_profit_loss);
    const taxCost = toNum(r.tax_cost);
    const taxAccDep = toNum(r.tax_acc_dep);
    const taxCA = toNum(r.tax_ca);
    const taxCurrentDep = toNum(r.tax_current_dep);
    const taxPL = toNum(r.tax_profit_loss);
    const deferredTax = toNum(r.deferred_tax);

    policyCostTot += policyCost;
    policyAccDepTot += policyAccDep;
    policyCAot += policyCA;
    policyCurrentDepTot += policyCurrentDep;
    taxCostTot += taxCost;
    taxAccDepTot += taxAccDep;
    taxCAot += taxCA;
    taxCurrentDepTot += taxCurrentDep;
    deferredTaxTot += deferredTax;

    const dataRow = ws.addRow([
      toStr(r.asset_number),
      toStr(r.asset_name),
      toStr(r.category_code),
      toStr(r.ias16_group),
      toNum(r.tax_life_years),
      toNum(r.policy_life_years),
      toNum(r.residual_pct),
      toStr(r.status),
      policyCost, policyAccDep, policyCA, policyCurrentDep, policyPL,
      taxCost, taxAccDep, taxCA, taxCurrentDep, taxPL,
      deferredTax,
    ]);

    dataRow.eachCell((cell, colNum) => {
      cell.font = { size: 10 };
      if (numCols.has(colNum)) {
        cell.numFmt = numFmt;
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  // Freeze pane — rows 1 (title), 2 (blank), 3 (headers) are frozen
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3, topLeftCell: 'A4', activeCell: 'A4' }];

  // Auto-filter on header row (row 3)
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };

  // Totals row
  const totRow = ws.addRow([
    'TOTALS', '', '', '', '', '', '', '',
    policyCostTot, policyAccDepTot, policyCAot, policyCurrentDepTot, '',
    taxCostTot, taxAccDepTot, taxCAot, taxCurrentDepTot, '',
    deferredTaxTot,
  ]);
  totRow.eachCell((cell, colNum) => {
    cell.font = { bold: true, size: 10 };
    cell.border = { top: { style: 'medium' } };
    if (numCols.has(colNum) && cell.value !== '') {
      cell.numFmt = numFmt;
      cell.alignment = { horizontal: 'right' };
    }
  });

  // Stream response
  const filename = `FAR-${asAtDate.replace(/-/g, '')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
}

export default withAuth(withErrorHandler(handler));
