/**
 * Migration Parser Service — CSV parsing for Xero, QuickBooks, Pastel
 * Handles column mapping, BOM stripping, comma/semicolon delimiters.
 */

import { log } from '@/lib/logger';
import type { GLAccountType } from '../types/gl.types';

export type MigrationSource = 'xero' | 'quickbooks' | 'pastel';

export interface ParsedAccount {
  sourceCode: string;
  sourceName: string;
  sourceType: string;
  openingBalance: number;
  // populated after auto-mapping
  mappedType?: GLAccountType;
  mappedNormalBalance?: 'debit' | 'credit';
  mappedSubtype?: string;
}

export interface ParsedEntity {
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  address?: string;
  balance?: number;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function detectDelimiter(line: string): ',' | ';' {
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function parseCSV(content: string): Array<Record<string, string>> {
  const clean = stripBom(content.trim());
  const lines = clean.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]!);
  const headers = splitCsvLine(lines[0]!, delimiter).map(h => h.toLowerCase().trim().replace(/^"|"$/g, ''));
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]!, delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.every(v => !v)) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }

  return rows;
}

/** Split a CSV line respecting quoted fields */
function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseBalance(val: string): number {
  if (!val) return 0;
  const cleaned = val.replace(/[R$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ── Account parsers per source ────────────────────────────────────────────────

function parseXeroAccounts(rows: Array<Record<string, string>>): ParsedAccount[] {
  return rows.map(r => ({
    sourceCode: r['*code'] ?? r['account code'] ?? r['code'] ?? '',
    sourceName: r['*name'] ?? r['account name'] ?? r['name'] ?? '',
    sourceType: r['*type'] ?? r['type'] ?? '',
    openingBalance: parseBalance(r['ytd balance'] ?? r['balance'] ?? ''),
  })).filter(a => a.sourceCode || a.sourceName);
}

function parseQuickBooksAccounts(rows: Array<Record<string, string>>): ParsedAccount[] {
  return rows.map(r => ({
    sourceCode: r['account'] ?? r['account number'] ?? r['number'] ?? '',
    sourceName: r['account name'] ?? r['name'] ?? r['account'] ?? '',
    sourceType: r['type'] ?? r['account type'] ?? '',
    openingBalance: parseBalance(r['balance'] ?? r['total'] ?? ''),
  })).filter(a => a.sourceCode || a.sourceName);
}

function parsePastelAccounts(rows: Array<Record<string, string>>): ParsedAccount[] {
  return rows.map(r => ({
    sourceCode: r['accnumber'] ?? r['account number'] ?? r['code'] ?? r['gl no'] ?? '',
    sourceName: r['description'] ?? r['account description'] ?? r['name'] ?? '',
    sourceType: r['acctype'] ?? r['type'] ?? r['account type'] ?? '',
    openingBalance: parseBalance(r['currentbalance'] ?? r['balance'] ?? r['closing balance'] ?? ''),
  })).filter(a => a.sourceCode || a.sourceName);
}

export function parseAccountsFile(source: MigrationSource, fileContent: string): ParsedAccount[] {
  try {
    const rows = parseCSV(fileContent);
    if (source === 'xero') return parseXeroAccounts(rows);
    if (source === 'quickbooks') return parseQuickBooksAccounts(rows);
    return parsePastelAccounts(rows);
  } catch (err) {
    log.error('Failed to parse accounts file', { source, error: err }, 'migration');
    throw err;
  }
}

// ── Contact parsers per source ────────────────────────────────────────────────

function parseXeroContacts(rows: Array<Record<string, string>>): ParsedEntity[] {
  return rows.map(r => ({
    name: r['*contact name'] ?? r['contact name'] ?? r['name'] ?? '',
    email: r['email address'] ?? r['email'] ?? undefined,
    phone: r['phone number'] ?? r['phone'] ?? undefined,
    vatNumber: r['tax number'] ?? r['vat number'] ?? undefined,
    address: r['postal address 1'] ?? r['street address'] ?? r['address'] ?? undefined,
    balance: parseBalance(r['outstanding balance'] ?? r['balance'] ?? '') || undefined,
  })).filter(e => e.name.trim());
}

function parseQuickBooksContacts(rows: Array<Record<string, string>>): ParsedEntity[] {
  return rows.map(r => ({
    name: r['customer'] ?? r['supplier'] ?? r['vendor'] ?? r['name'] ?? '',
    email: r['main email'] ?? r['email'] ?? undefined,
    phone: r['main phone'] ?? r['phone'] ?? undefined,
    vatNumber: r['vat/gst'] ?? r['tax id'] ?? undefined,
    address: r['billing address'] ?? r['address'] ?? undefined,
    balance: parseBalance(r['open balance'] ?? r['balance'] ?? '') || undefined,
  })).filter(e => e.name.trim());
}

function parsePastelContacts(rows: Array<Record<string, string>>): ParsedEntity[] {
  return rows.map(r => ({
    name: r['description'] ?? r['account'] ?? r['name'] ?? r['company name'] ?? '',
    email: r['email'] ?? r['email address'] ?? undefined,
    phone: r['telephone'] ?? r['phone'] ?? r['cell'] ?? undefined,
    vatNumber: r['vat number'] ?? r['vat reg no'] ?? undefined,
    address: r['address'] ?? r['address 1'] ?? r['postal address'] ?? undefined,
    balance: parseBalance(r['balance'] ?? r['current balance'] ?? '') || undefined,
  })).filter(e => e.name.trim());
}

export function parseCustomersFile(source: MigrationSource, fileContent: string): ParsedEntity[] {
  try {
    const rows = parseCSV(fileContent);
    if (source === 'xero') return parseXeroContacts(rows);
    if (source === 'quickbooks') return parseQuickBooksContacts(rows);
    return parsePastelContacts(rows);
  } catch (err) {
    log.error('Failed to parse customers file', { source, error: err }, 'migration');
    throw err;
  }
}

export function parseSuppliersFile(source: MigrationSource, fileContent: string): ParsedEntity[] {
  // Same column formats as customers for all three sources
  return parseCustomersFile(source, fileContent);
}

// ── Auto-mapping ─────────────────────────────────────────────────────────────

const XERO_TYPE_MAP: Record<string, { type: GLAccountType; normalBalance: 'debit' | 'credit'; subtype?: string }> = {
  'bank':            { type: 'asset',     normalBalance: 'debit',  subtype: 'bank' },
  'current':         { type: 'asset',     normalBalance: 'debit',  subtype: 'current_asset' },
  'currliab':        { type: 'liability', normalBalance: 'credit', subtype: 'current_liability' },
  'depreciatn':      { type: 'asset',     normalBalance: 'debit',  subtype: 'fixed_asset' },
  'directcosts':     { type: 'expense',   normalBalance: 'debit' },
  'equity':          { type: 'equity',    normalBalance: 'credit' },
  'expense':         { type: 'expense',   normalBalance: 'debit' },
  'fixed':           { type: 'asset',     normalBalance: 'debit',  subtype: 'fixed_asset' },
  'inventory':       { type: 'asset',     normalBalance: 'debit',  subtype: 'inventory' },
  'liability':       { type: 'liability', normalBalance: 'credit' },
  'noncurrent':      { type: 'asset',     normalBalance: 'debit' },
  'otherincome':     { type: 'revenue',   normalBalance: 'credit' },
  'overheads':       { type: 'expense',   normalBalance: 'debit' },
  'prepayment':      { type: 'asset',     normalBalance: 'debit' },
  'revenue':         { type: 'revenue',   normalBalance: 'credit' },
  'sales':           { type: 'revenue',   normalBalance: 'credit' },
  'termliab':        { type: 'liability', normalBalance: 'credit' },
};

const QB_TYPE_MAP: Record<string, { type: GLAccountType; normalBalance: 'debit' | 'credit'; subtype?: string }> = {
  'bank':                    { type: 'asset',     normalBalance: 'debit',  subtype: 'bank' },
  'accounts receivable':     { type: 'asset',     normalBalance: 'debit',  subtype: 'receivable' },
  'other current asset':     { type: 'asset',     normalBalance: 'debit',  subtype: 'current_asset' },
  'fixed asset':             { type: 'asset',     normalBalance: 'debit',  subtype: 'fixed_asset' },
  'other asset':             { type: 'asset',     normalBalance: 'debit' },
  'accounts payable':        { type: 'liability', normalBalance: 'credit', subtype: 'payable' },
  'credit card':             { type: 'liability', normalBalance: 'credit' },
  'other current liability': { type: 'liability', normalBalance: 'credit', subtype: 'current_liability' },
  'long term liability':     { type: 'liability', normalBalance: 'credit' },
  'equity':                  { type: 'equity',    normalBalance: 'credit' },
  'income':                  { type: 'revenue',   normalBalance: 'credit' },
  'other income':            { type: 'revenue',   normalBalance: 'credit' },
  'cost of goods sold':      { type: 'expense',   normalBalance: 'debit' },
  'expense':                 { type: 'expense',   normalBalance: 'debit' },
  'other expense':           { type: 'expense',   normalBalance: 'debit' },
};

function mapByPastelCodeRange(code: string): { type: GLAccountType; normalBalance: 'debit' | 'credit' } | null {
  const numeric = parseInt(code.replace(/\D/g, ''), 10);
  if (isNaN(numeric)) return null;
  if (numeric < 2000) return { type: 'asset',     normalBalance: 'debit'  };
  if (numeric < 3000) return { type: 'liability', normalBalance: 'credit' };
  if (numeric < 4000) return { type: 'equity',    normalBalance: 'credit' };
  if (numeric < 5000) return { type: 'revenue',   normalBalance: 'credit' };
  return                     { type: 'expense',   normalBalance: 'debit'  };
}

export function autoMapAccounts(source: MigrationSource, accounts: ParsedAccount[]): ParsedAccount[] {
  return accounts.map(acct => {
    const typeKey = acct.sourceType.toLowerCase().trim();
    let mapping: { type: GLAccountType; normalBalance: 'debit' | 'credit'; subtype?: string } | null = null;

    if (source === 'xero') {
      mapping = XERO_TYPE_MAP[typeKey] ?? null;
    } else if (source === 'quickbooks') {
      mapping = QB_TYPE_MAP[typeKey] ?? null;
    } else {
      // Pastel: try numeric range first, fall back to type string
      mapping = mapByPastelCodeRange(acct.sourceCode) ??
        QB_TYPE_MAP[typeKey] ?? XERO_TYPE_MAP[typeKey] ?? null;
    }

    if (!mapping) return acct;

    return {
      ...acct,
      mappedType: mapping.type,
      mappedNormalBalance: mapping.normalBalance,
      mappedSubtype: mapping.subtype,
    };
  });
}
