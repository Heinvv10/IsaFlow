/**
 * SARS source-code XLSX parser.
 *
 * Reads the curated PAYE-AE-06-G06 master spreadsheet (sheet "Master_Codes")
 * and returns normalised rows ready for upsert into sars_source_codes.
 * Used by both the CLI importer (scripts/import-sars-codes.ts) and the
 * admin API upload endpoint.
 */

import ExcelJS from 'exceljs';

export type SarsCategory =
  | 'income'
  | 'allowance'
  | 'fringe'
  | 'employer'
  | 'deduction'
  | 'lump_sum';

export type SarsStatus = 'active' | 'conditional' | 'deprecated';

export interface ParsedSarsRow {
  code: string;
  foreignCode: string | null;
  codePair: string | null;
  category: SarsCategory;
  status: SarsStatus;
  description: string;
  applicabilityNote: string | null;
  rationalisationNote: string | null;
  sourceDocument: string | null;
  sourceUrl: string | null;
  officialExcerpt: string | null;
}

export interface ParseResult {
  rows: ParsedSarsRow[];
  errors: string[];
}

const CATEGORY_MAP: Record<string, SarsCategory> = {
  'normal income / gross remuneration': 'income',
  'allowance': 'allowance',
  'fringe benefit / employer contribution': 'fringe',
  'employer contribution': 'employer',
  'deduction': 'deduction',
  'lump sum': 'lump_sum',
};

const STATUS_MAP: Record<string, SarsStatus> = {
  'active / general': 'active',
  'active / conditional by yoa': 'conditional',
  'deprecated / limited-use': 'deprecated',
};

function cellText(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  const s = typeof v === 'object' ? (v as { text?: string }).text ?? String(v) : String(v);
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

export async function parseSarsCodesXlsxBuffer(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return parseWorkbook(wb);
}

export async function parseSarsCodesXlsxFile(filePath: string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return parseWorkbook(wb);
}

function parseWorkbook(wb: ExcelJS.Workbook): ParseResult {
  const ws = wb.getWorksheet('Master_Codes');
  if (!ws) {
    return { rows: [], errors: ['Sheet "Master_Codes" not found in workbook'] };
  }

  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    const t = cellText(cell);
    if (t) header[t] = col;
  });

  for (const required of ['Code', 'Category', 'Description', 'Status']) {
    if (!header[required]) {
      return { rows: [], errors: [`Required column "${required}" missing in Master_Codes`] };
    }
  }

  const errors: string[] = [];
  const rows: ParsedSarsRow[] = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const code = cellText(row.getCell(header['Code']!));
    if (!code) continue;

    const rawCategory = cellText(row.getCell(header['Category']!));
    const rawStatus = cellText(row.getCell(header['Status']!));
    const description = cellText(row.getCell(header['Description']!));

    if (!rawCategory) {
      errors.push(`Row ${r}: missing Category for code ${code}`);
      continue;
    }
    if (!rawStatus) {
      errors.push(`Row ${r}: missing Status for code ${code}`);
      continue;
    }
    if (!description) {
      errors.push(`Row ${r}: missing Description for code ${code}`);
      continue;
    }

    const category = CATEGORY_MAP[rawCategory.toLowerCase()];
    const status = STATUS_MAP[rawStatus.toLowerCase()];

    if (!category) {
      errors.push(`Row ${r}: unknown category "${rawCategory}" for code ${code}`);
      continue;
    }
    if (!status) {
      errors.push(`Row ${r}: unknown status "${rawStatus}" for code ${code}`);
      continue;
    }

    rows.push({
      code,
      foreignCode: header['Foreign_Code'] ? cellText(row.getCell(header['Foreign_Code'])) : null,
      codePair: header['Code_Pair'] ? cellText(row.getCell(header['Code_Pair'])) : null,
      category,
      status,
      description,
      applicabilityNote: header['Applicability_Note']
        ? cellText(row.getCell(header['Applicability_Note']))
        : null,
      rationalisationNote: header['Rationalisation_or_Overview_Note']
        ? cellText(row.getCell(header['Rationalisation_or_Overview_Note']))
        : null,
      sourceDocument: header['Source_Document']
        ? cellText(row.getCell(header['Source_Document']))
        : null,
      sourceUrl: header['Source_URL'] ? cellText(row.getCell(header['Source_URL'])) : null,
      officialExcerpt: header['Official_Guide_Excerpt']
        ? cellText(row.getCell(header['Official_Guide_Excerpt']))
        : null,
    });
  }

  return { rows, errors };
}
