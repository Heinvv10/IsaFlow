/**
 * Supplier bank-detail verification (forensic-controls step 1): the census
 * that keeps the gate in front of EVERY way money leaves. Money leaves
 * through a bank file (eft-generate, via eftService's generators) or a
 * Netcash submission (netcash/submit, via submitEftBatch) — nothing else
 * calls either, and both routes run the gate on exactly the bank columns they
 * send, after reading them and before building or sending anything. The
 * fingerprint is computed only by the SQL function (migration 876), never
 * re-implemented in TypeScript; and a verification — the switch-on baseline
 * included — is written only from the cookie-session API, never by an MCP tool.
 *
 * A new caller of a generator, of submitEftBatch, of the fingerprint or of a
 * verification writer fails this census until it is classified here. Walks
 * the tree on disk, as supplierPaymentApprovalCensus does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVER_RANK } from '@/modules/accounting/services/gl/approvalRank';
import { SUPPLIER_BANK_VERIFIER_FLOOR } from '@/modules/accounting/services/gl/approvalEnforcement';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'scripts', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const AP = 'src/modules/accounting/services/ap/';
const EFT = 'pages/api/accounting/eft-generate.ts';
const NETCASH = 'pages/api/accounting/netcash/submit.ts';

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
}

const files = (() => {
  const all: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), all);
  return all.map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
})();
const cache = new Map<string, string>();
const text = (rel: string) => {
  if (!cache.has(rel)) cache.set(rel, readFileSync(path.join(ROOT, rel), 'utf8'));
  return cache.get(rel)!;
};
const matching = (re: RegExp) => files.filter((f) => re.test(text(f)));

describe('every way money leaves', () => {
  it('the EFT generators are called only by eft-generate (and defined in eftService)', () => {
    expect(matching(/\bgenerate(StandardBankACB|FNBEFT|ABSAEFT|NedbankEFT|CapitecEFT)\b/)).toEqual([EFT, `${AP}eftService.ts`]);
    expect(matching(/\bGENERATORS\[/)).toEqual([EFT]);
  });

  it('submitEftBatch is called only by netcash/submit (and defined in netcashService)', () => {
    expect(matching(/\bsubmitEftBatch\b/)).toEqual([NETCASH, `${AP}netcashService.ts`]);
  });
});

describe('both routes run the gate on what they send', () => {
  it('exactly the two routes call the gate (and the gate module defines it)', () => {
    expect(matching(/\bassertSuppliersBankVerified\(/)).toEqual([EFT, NETCASH, `${AP}supplierBankVerificationGate.ts`]);
    expect(matching(/\bassertRawPaymentListAllowed\(/)).toEqual([NETCASH, `${AP}supplierBankVerificationGate.ts`]);
  });

  it('eft-generate: the payee SELECT carries the fingerprint of its own bank columns; the gate runs before the file is built', () => {
    const t = text(EFT);
    expect(t).toMatch(/s\.bank_account_number, s\.bank_branch_code, s\.bank_account_type, s\.bank_name,\s+supplier_bank_fingerprint\(s\.bank_name, s\.bank_account_number, s\.bank_branch_code, s\.bank_account_type,\s+s\.bank_account_holder\) AS bank_fingerprint\s+FROM supplier_payments sp/);
    const gate = t.indexOf('await assertSuppliersBankVerified(companyId, payments.map(');
    expect(gate).toBeGreaterThan(t.indexOf('AS bank_fingerprint'));
    expect(gate).toBeLessThan(t.indexOf('validateEFTBatch(header'));
    expect(gate).toBeLessThan(t.indexOf('generator(header, eftPayments)'));
  });

  it('netcash/submit: batch mode gates the rows it sends, raw mode is refused, both before anything is sent or recorded', () => {
    const t = text(NETCASH);
    expect(t).toMatch(/s\.bank_account_number as account_number,\s+supplier_bank_fingerprint\(s\.bank_name, s\.bank_account_number, s\.bank_branch_code, s\.bank_account_type,\s+s\.bank_account_holder\) AS bank_fingerprint\s+FROM supplier_payments sp/);
    const batchGate = t.indexOf('await assertSuppliersBankVerified(companyId, rows.map(');
    const rawGate = t.indexOf('await assertRawPaymentListAllowed(companyId);');
    expect(batchGate).toBeGreaterThan(t.indexOf('AS bank_fingerprint'));
    expect(rawGate).toBeLessThan(t.indexOf('payments = rawPayments;'));
    for (const gate of [batchGate, rawGate]) {
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(t.indexOf('await submitEftBatch('));
      expect(gate).toBeLessThan(t.indexOf('INSERT INTO netcash_submissions'));
    }
  });
});

describe('one fingerprint, in SQL', () => {
  it('only these files name supplier_bank_fingerprint', () => {
    expect(matching(/supplier_bank_fingerprint\(/)).toEqual([
      EFT, NETCASH,
      `${AP}supplierBankBaseline.ts`, `${AP}supplierBankVerification.ts`, `${AP}supplierBankVerificationGate.ts`,
    ]);
  });

  it('no source hashes bank details in TypeScript', () => {
    const hashing = matching(/createHash|subtle\.digest|\bsha256\b/);
    expect(hashing.filter((f) => /bank_account_number|bankAccountNumber|accountNumber/.test(text(f)))).toEqual([]);
  });
});

describe('the database guard ranks on the same ladder', () => {
  it("migration 876's verifier-floor role list is exactly the ladder's roles at or above the floor", () => {
    const sql = readFileSync(path.join(ROOT, 'scripts/migrations/sql/876_supplier_bank_verification.sql'), 'utf8');
    const lists = [...sql.matchAll(/IN \(('super_admin'[^)]*)\)/g)].map((m) => m[1]!.split(',').map((r) => r.trim().replace(/'/g, '')).sort());
    const expected = Object.keys(APPROVER_RANK).filter((r) => APPROVER_RANK[r]! >= APPROVER_RANK[SUPPLIER_BANK_VERIFIER_FLOOR]!).sort();
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual(expected);
  });
});

describe('who writes a verification', () => {
  it('a verify only from the cookie-session API route; the baseline only from switching on', () => {
    expect(matching(/\bverifySupplierBankDetails\(/)).toEqual([
      'pages/api/accounting/supplier-bank-verification.ts', `${AP}supplierBankVerification.ts`,
    ]);
    expect(matching(/\brecordBankBaseline\(/)).toEqual([
      `${AP}supplierBankBaseline.ts`, 'src/modules/accounting/services/gl/approvalEnforcement.ts',
    ]);
    expect(matching(/INSERT\s+INTO\s+supplier_bank_verifications/)).toEqual([
      `${AP}supplierBankBaseline.ts`, `${AP}supplierBankVerification.ts`,
    ]);
  });

  it('no MCP tool reaches a verification writer', () => {
    expect(files.filter((f) => f.startsWith('src/lib/mcp/') && /supplierBankVerification|supplierBankBaseline|supplier_bank_verifications/
      .test(text(f)))).toEqual([]);
  });
});
