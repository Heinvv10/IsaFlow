/**
 * Import SARS IRP5/IT3(a) source codes from an annual master spreadsheet.
 *
 * Source-of-truth: SARS PAYE-AE-06-G06 Guide for Codes Applicable to Employees Tax Certificates.
 * Practical-format: the curated XLSX produced from that PDF (one sheet "Master_Codes",
 * one sheet "Latest_Changes", one sheet "Notes").
 *
 * Usage:
 *   bun scripts/import-sars-codes.ts \
 *     --year 2026 \
 *     --file "/path/to/IRP5 CODES FULL LIST.xlsx" \
 *     --brs v25.2.0 \
 *     [--set-current] \
 *     [--dry-run]
 *
 * Idempotent: re-running with the same year overwrites that year's rows.
 */

import * as path from 'node:path';
import ExcelJS from 'exceljs';
import { createSql, closeSql } from './_pg';

interface CliArgs {
  year: number;
  file: string;
  brs: string;
  setCurrent: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { setCurrent: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') args.year = parseInt(argv[++i], 10);
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--brs') args.brs = argv[++i];
    else if (a === '--set-current') args.setCurrent = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') printUsageAndExit(0);
  }
  if (!args.year || !args.file || !args.brs) {
    console.error('Missing required argument. --year, --file and --brs are required.\n');
    printUsageAndExit(1);
  }
  return args as CliArgs;
}

function printUsageAndExit(code: number): never {
  console.log(`
Usage:
  bun scripts/import-sars-codes.ts --year <YYYY> --file <path.xlsx> --brs <version> [--set-current] [--dry-run]

  --year         SA year of assessment (e.g. 2026)
  --file         Path to the master XLSX
  --brs          BRS version string (e.g. v25.2.0)
  --set-current  Mark this release as the active one in sars_code_releases
  --dry-run      Parse + diff only, no DB writes
`);
  process.exit(code);
}

const CATEGORY_MAP: Record<string, 'income' | 'allowance' | 'fringe' | 'employer' | 'deduction' | 'lump_sum'> = {
  'normal income / gross remuneration': 'income',
  'allowance': 'allowance',
  'fringe benefit / employer contribution': 'fringe',
  'employer contribution': 'employer',
  'deduction': 'deduction',
  'lump sum': 'lump_sum',
};

const STATUS_MAP: Record<string, 'active' | 'conditional' | 'deprecated'> = {
  'active / general': 'active',
  'active / conditional by yoa': 'conditional',
  'deprecated / limited-use': 'deprecated',
};

interface MasterRow {
  code: string;
  foreign_code: string | null;
  code_pair: string | null;
  category: string;
  status: string;
  description: string;
  applicability_note: string | null;
  rationalisation_note: string | null;
  source_document: string | null;
  source_url: string | null;
  official_excerpt: string | null;
}

async function parseMasterSheet(filePath: string): Promise<MasterRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet('Master_Codes');
  if (!ws) throw new Error(`Sheet "Master_Codes" not found in ${filePath}`);

  // Build column index from header row (row 1)
  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    header[String(cell.value).trim()] = col;
  });
  const required = ['Code', 'Category', 'Description', 'Status'];
  for (const r of required) {
    if (!header[r]) throw new Error(`Required column "${r}" missing in Master_Codes`);
  }

  const rows: MasterRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const codeRaw = row.getCell(header['Code']).value;
    if (codeRaw === null || codeRaw === undefined || String(codeRaw).trim() === '') continue;

    const get = (col: string): string | null => {
      if (!header[col]) return null;
      const v = row.getCell(header[col]).value;
      if (v === null || v === undefined) return null;
      const s = typeof v === 'object' ? (v as { text?: string }).text ?? String(v) : String(v);
      return s.trim() || null;
    };

    rows.push({
      code: String(codeRaw).trim(),
      foreign_code: get('Foreign_Code'),
      code_pair: get('Code_Pair'),
      category: String(row.getCell(header['Category']).value).trim(),
      status: String(row.getCell(header['Status']).value).trim(),
      description: String(row.getCell(header['Description']).value).trim(),
      applicability_note: get('Applicability_Note'),
      rationalisation_note: get('Rationalisation_or_Overview_Note'),
      source_document: get('Source_Document'),
      source_url: get('Source_URL'),
      official_excerpt: get('Official_Guide_Excerpt'),
    });
  }
  return rows;
}

function normaliseCategory(raw: string): MasterRow['category'] | null {
  const key = raw.toLowerCase().trim();
  return CATEGORY_MAP[key] ?? null;
}

function normaliseStatus(raw: string): 'active' | 'conditional' | 'deprecated' | null {
  const key = raw.toLowerCase().trim();
  return STATUS_MAP[key] ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const absFile = path.resolve(args.file);

  console.log(`Reading ${absFile} for tax year ${args.year} (BRS ${args.brs})…`);
  const rows = await parseMasterSheet(absFile);
  console.log(`Parsed ${rows.length} rows from Master_Codes.`);

  // Validate + normalise
  const errors: string[] = [];
  const normalised = rows.map((r, idx) => {
    const cat = normaliseCategory(r.category);
    const stat = normaliseStatus(r.status);
    if (!cat) errors.push(`Row ${idx + 2}: unknown category "${r.category}" for code ${r.code}`);
    if (!stat) errors.push(`Row ${idx + 2}: unknown status "${r.status}" for code ${r.code}`);
    return { ...r, category_norm: cat, status_norm: stat };
  });
  if (errors.length) {
    console.error(`Validation failed (${errors.length}):`);
    errors.forEach((e) => console.error(`  • ${e}`));
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('\n--- DRY RUN — no DB writes ---');
    const cats = normalised.reduce<Record<string, number>>((acc, r) => {
      acc[r.category_norm!] = (acc[r.category_norm!] ?? 0) + 1;
      return acc;
    }, {});
    console.log('Category counts:', cats);
    const sts = normalised.reduce<Record<string, number>>((acc, r) => {
      acc[r.status_norm!] = (acc[r.status_norm!] ?? 0) + 1;
      return acc;
    }, {});
    console.log('Status counts:', sts);
    await closeSql();
    return;
  }

  const sql = createSql();

  // Show diff vs prior year if exists
  const prior = (await sql<{ code: string; description: string }>`
    SELECT code, description FROM sars_source_codes WHERE effective_year = ${args.year - 1}
  `);
  const priorMap = new Map(prior.map((p) => [p.code, p.description]));
  const newCodes = normalised.filter((r) => !priorMap.has(r.code)).map((r) => r.code);
  const removedCodes = [...priorMap.keys()].filter((c) => !normalised.some((r) => r.code === c));
  console.log(`\nDiff vs ${args.year - 1}: +${newCodes.length} new, −${removedCodes.length} removed`);
  if (newCodes.length) console.log(`  New: ${newCodes.join(', ')}`);
  if (removedCodes.length) console.log(`  Removed: ${removedCodes.join(', ')}`);

  // Upsert
  let upserts = 0;
  for (const r of normalised) {
    await sql`
      INSERT INTO sars_source_codes (
        code, effective_year, category, description, status,
        foreign_code, code_pair, applicability_note, rationalisation_note,
        source_document, source_url, official_excerpt, brs_version
      ) VALUES (
        ${r.code}, ${args.year}, ${r.category_norm}, ${r.description}, ${r.status_norm},
        ${r.foreign_code}, ${r.code_pair}, ${r.applicability_note}, ${r.rationalisation_note},
        ${r.source_document}, ${r.source_url}, ${r.official_excerpt}, ${args.brs}
      )
      ON CONFLICT (code, effective_year) DO UPDATE SET
        category = EXCLUDED.category,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        foreign_code = EXCLUDED.foreign_code,
        code_pair = EXCLUDED.code_pair,
        applicability_note = EXCLUDED.applicability_note,
        rationalisation_note = EXCLUDED.rationalisation_note,
        source_document = EXCLUDED.source_document,
        source_url = EXCLUDED.source_url,
        official_excerpt = EXCLUDED.official_excerpt,
        brs_version = EXCLUDED.brs_version,
        imported_at = now()
    `;
    upserts++;
  }
  console.log(`Upserted ${upserts} codes.`);

  // Release row
  if (args.setCurrent) {
    await sql`UPDATE sars_code_releases SET is_current = false WHERE is_current = true`;
  }
  await sql`
    INSERT INTO sars_code_releases (effective_year, brs_version, released_at, is_current)
    VALUES (${args.year}, ${args.brs}, now(), ${args.setCurrent})
    ON CONFLICT (effective_year) DO UPDATE SET
      brs_version = EXCLUDED.brs_version,
      is_current = ${args.setCurrent} OR sars_code_releases.is_current
  `;

  console.log(`Done.${args.setCurrent ? ` Year ${args.year} marked as current.` : ''}`);
  await closeSql();
}

main().catch(async (err) => {
  console.error(err);
  await closeSql();
  process.exit(1);
});
