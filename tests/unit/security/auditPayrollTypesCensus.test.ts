/**
 * #1656 round 8 (breaker HIGH): the audit log returned `changes` / `metadata` for payroll entity types (an employee's email, a tax
 * directive's dates, a garnishee order's instalment and court reference, a payslip delivery, the portal email) to any member. A person
 * without Payroll read now gets none of them (list, entity history, CSV export). The list of those types
 * (PAYROLL_AUDIT_ENTITY_TYPES) is pinned here against EVERY audit write in the program: each logAudit / logAuditOrThrow call's `entityType`
 * is resolved by the type checker (constants and unions included), so a new payroll type that is not listed fails this test.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { programFor } from '../helpers/approveCensusProgram';
import { PAYROLL_AUDIT_ENTITY_TYPES } from '@/modules/accounting/services/core/auditPayrollTypes';

/** Audit types written from payroll code that carry no one person's data: the entity is the company or a company-level filing. */
const PAYROLL_SCOPE_NOT_PERSONAL: Readonly<Record<string, string>> = {
  company: 'a company setting (the pay week, the portal switch): no employee in the row',
  tax_return_version: 'a filed EMP201 / EMP501 / VAT201 version: company-level figures',
  sars_compliance_event: 'a filing mark: dates and a reference, no employee',
};
/** Files whose audit writes name the type at run time, each judged by hand. */
const DYNAMIC_OK: Readonly<Record<string, string>> = {
  'src/modules/accounting/services/core/approvePermission.ts': 'recordApproveWithheld: callers pass customer_invoice, supplier_invoice, journal_entry (no payroll caller)',
};
const PAYROLL_SCOPE = /payroll|payslip|tax[-_]?directive|employee[-_]?portal|garnishee|fringe|pay[-_]?run|payRun/i;
const PERSONAL_NAME = /payroll|payslip|employee|garnishee|tax_directive|fringe/i;

interface Write { file: string; values: string[] | 'dynamic' }
let memo: Write[] | undefined;
function audits(): Write[] {
  if (memo) return memo;
  const files = execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).map((f) => resolve(process.cwd(), f));
  const program = programFor(files);
  const checker = program.getTypeChecker();
  const out: Write[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^logAudit(OrThrow)?$/.test(n.expression.text) && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        const prop = n.arguments[0].properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'entityType');
        let values: string[] | 'dynamic' = 'dynamic';
        if (prop) {
          const t = ts.isPropertyAssignment(prop) ? checker.getTypeAtLocation(prop.initializer) : checker.getTypeAtLocation(prop.name);
          const parts = t.isUnion() ? t.types : [t];
          values = parts.every((p) => p.isStringLiteral()) ? parts.map((p) => (p as ts.StringLiteralType).value) : 'dynamic';
        }
        out.push({ file: sf.fileName.replace(`${process.cwd()}/`, ''), values });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return (memo = out);
}

describe('payroll audit entity types (PAYROLL_AUDIT_ENTITY_TYPES)', () => {
  it('the census sees the audit writes (it is not empty)', () => {
    expect(audits().length).toBeGreaterThan(60);
    expect(audits().filter((w) => PAYROLL_SCOPE.test(w.file)).length).toBeGreaterThan(15);
  }, 180_000);

  it('every audit write in payroll code names a listed payroll type, or one listed as not personal; none is dynamic unless judged', () => {
    const listed = new Set([...PAYROLL_AUDIT_ENTITY_TYPES, ...Object.keys(PAYROLL_SCOPE_NOT_PERSONAL)]);
    const bad = audits().filter((w) => PAYROLL_SCOPE.test(w.file)).flatMap((w) => (
      w.values === 'dynamic' ? (DYNAMIC_OK[w.file] ? [] : [`${w.file}: type not static`]) : w.values.filter((v) => !listed.has(v)).map((v) => `${w.file}: ${v}`)));
    expect(bad, 'List the type in auditPayrollTypes.ts (it holds a person\'s data) or in PAYROLL_SCOPE_NOT_PERSONAL (with the reason)').toEqual([]);
  }, 180_000);

  it('a type that is NAMED like payroll data, written from anywhere, is on the list', () => {
    const missing = audits().flatMap((w) => (w.values === 'dynamic' ? [] : w.values.filter((v) => PERSONAL_NAME.test(v) && !PAYROLL_AUDIT_ENTITY_TYPES.includes(v)).map((v) => `${w.file}: ${v}`)));
    expect(missing).toEqual([]);
  }, 180_000);

  it('every listed type is still written somewhere (no stale pin) and every NOT_PERSONAL one too', () => {
    const written = new Set(audits().flatMap((w) => (w.values === 'dynamic' ? [] : w.values)));
    expect([...PAYROLL_AUDIT_ENTITY_TYPES].filter((t) => !written.has(t))).toEqual([]);
    expect(Object.keys(PAYROLL_SCOPE_NOT_PERSONAL).filter((t) => !written.has(t))).toEqual([]);
  }, 180_000);

  it('the dynamic exemptions still exist as dynamic writes', () => {
    const dynamicFiles = new Set(audits().filter((w) => w.values === 'dynamic').map((w) => w.file));
    expect(Object.keys(DYNAMIC_OK).filter((f) => !dynamicFiles.has(f))).toEqual([]);
  }, 180_000);

  it('no MCP tool reads the audit_log table (audit_trail reads GL journals): a new reader there needs this filter', () => {
    const mcp = execFileSync('git', ['ls-files', 'src/lib/mcp'], { encoding: 'utf8' }).split('\n').filter((f) => /\.ts$/.test(f));
    const readers = mcp.filter((f) => /\b(?:FROM|JOIN)\s+(?:public\.)?audit_log\b/i.test(readFileSync(f, 'utf8')));
    expect(readers).toEqual([]);
  });

  // Round 9: the audit writers the type-checker census cannot see (a raw INSERT INTO audit_log). Pinned, each judged; a new one fails here.
  const RAW_TS_WRITERS: Readonly<Record<string, string>> = {
    'src/modules/accounting/services/core/memberWrites.ts': "'company_user': approve_withheld changes (no pay data)",
    'src/modules/accounting/services/ar/customerInvoiceWipLinks.ts': "'time_entry': a time entry released from a draft invoice",
    'src/modules/accounting/services/ap/netcashUnrecordedAnswer.ts': 'a Netcash submission answer (AP)',
    'src/modules/bureau/services/signupBureauService.ts': "'bureau': a bureau signup",
    'src/modules/accounting/services/core/auditTrailService.ts': 'logAuditOrThrow itself: the census above judges its callers',
  };
  const RAW_SQL_WRITERS: Readonly<Record<string, string>> = {
    '855_retire_data_archiving.sql': "'archive_run': data archiving (retired)",
    '872_approval_request_definer_writes.sql': "'approval_request': a pay_run request is filtered by metadata.documentType (auditTrailService)",
    '880_audit_log_append_only.sql': 'the append-only probe',
    '881_approval_rule_enforcement_definer_writes.sql': "'approval_rule' / 'approval_enforcement'",
    '885_bank_rule_switch_definer.sql': "'approval_enforcement'",
    '908_relabel_sage_history_journals.sql': "'gl_journal_entry': a journal relabel",
    '947_budget_versions.sql': "'budget'",
  };
  const RAW = /\bINSERT\s+INTO\s+(?:public\.)?audit_log\b/i;

  it('every raw INSERT INTO audit_log in the served TypeScript is a pinned writer (none writes a payroll type)', () => {
    const files = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f) && !f.includes('/tests/'));
    const found = files.filter((f) => RAW.test(readFileSync(f, 'utf8'))).sort();
    expect(found).toEqual(Object.keys(RAW_TS_WRITERS).sort());
  });

  it('every migration that inserts into audit_log is a pinned definer / writer (none writes a payroll type; 872 is filtered)', () => {
    const files = execFileSync('git', ['ls-files', 'scripts/migrations/sql'], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.sql'));
    const found = files.filter((f) => RAW.test(readFileSync(f, 'utf8'))).map((f) => f.split('/').pop()!).sort();
    expect(found).toEqual(Object.keys(RAW_SQL_WRITERS).sort());
  });
});
