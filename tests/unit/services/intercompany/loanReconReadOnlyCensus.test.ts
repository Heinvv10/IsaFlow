/**
 * Intercompany P5 is READ ONLY ((j).11): a census of the report's own files (the service, its reads, the two routes and migration 1030's
 * function bodies). No INSERT / UPDATE / DELETE, no row lock, no advisory lock, no lock_timeout change, no VOLATILE group check
 * (intercompany_in_one_group takes intercompany_lock_companies locks), and the routes answer GET only. The integration suite proves the same
 * by outcome (no xid, no lock, nothing moved); this pins the text so a later edit is caught before it runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const FILES = [
  'src/modules/accounting/services/intercompany/loanReconReads.ts',
  'src/modules/accounting/services/intercompany/loanReconService.ts',
  'src/modules/accounting/services/intercompany/loanReconSummary.ts',
  'src/modules/accounting/services/intercompany/loanReconSections.ts',
  'pages/api/accounting/intercompany/loan-reconciliation.ts',
  'pages/api/accounting/intercompany/loan-reconciliation/[connectionId].ts',
];
const MIGRATION = 'scripts/migrations/sql/1030_intercompany_p5_loan_reconciliation.sql';

/** The function bodies of the migration ($$ ... $$), where a write or a lock would run. */
const bodies = (sqlText: string) => [...sqlText.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1]!);
const noComments = (t: string) => t.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/[^\n]*/g, '');

describe('the report writes and locks nothing', () => {
  it.each(FILES)('%s', (file) => {
    const text = noComments(read(file));
    expect(text).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(text).not.toMatch(/FOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b|pg_advisory|lock_timeout|intercompany_in_one_group|intercompany_lock_companies/i);
  });

  it('the migration creates functions only: no table, column or index change; its bodies write and lock nothing', () => {
    const text = read(MIGRATION);
    expect(noComments(text)).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TRIGGER)\b/i);
    const b = bodies(text);
    expect(b.length).toBe(5);
    for (const body of b) {
      const t = noComments(body);
      expect(t).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i);
      expect(t).not.toMatch(/FOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b|pg_advisory|lock_timeout|intercompany_in_one_group/i);
    }
  });

  it('the routes answer GET only and carry no CSRF / write wrapper (nothing to protect)', () => {
    for (const file of FILES.filter((f) => f.startsWith('pages/'))) {
      const text = read(file);
      expect(text, file).toMatch(/req\.method !== 'GET'/);
      expect(text, file).toMatch(/export default withAuth\(withErrorHandler\(handler/);
    }
  });
});
