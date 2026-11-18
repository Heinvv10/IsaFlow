/**
 * Wave 6 HYa: actor ids on the payroll, SARS and tax tables are bound as text.
 *
 * users.id is varchar and a user id need not be UUID-shaped, but these tables' `*_by` columns are uuid until HYb turns
 * them to TEXT. Code that tolerates both writes `${userId}` (an untyped parameter: Postgres takes the column's type)
 * and compares `col::text = ${userId}`; `${userId}::uuid` fails for a non-UUID id today and keeps failing after HYb.
 *
 * The census, by table: every tracked src/ or pages/ file whose code (comments removed) names one of the tables, and
 * every line in it that names an actor column, is pinned below with its exact text (a moved or changed line fails
 * here and is re-read, the census-regex lesson). Multi-line VALUES binds, whose line does not name the column, are
 * pinned in VALUE_BINDS. No such line casts an actor value to uuid, apart from the reasoned exemption.
 * The behaviour is proved in tests/integration/hya-actor-ids-text.int.test.ts. Reads `git ls-files`.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const S = 'src/modules/accounting/services/';
const TABLE = /\b(payroll_run_headers|payroll_leave_requests|payroll_external_imports|sars_submissions|sars_efiling_events|tax_directives|tax_directive_payments|uif_declarations|vat_returns)\b/;
const COLUMN = /\b(approved_by|cancelled_by|created_by|prepared_by|requested_by|submitted_by)\b/;
/** An actor column cast to uuid, or `col = ${…}::uuid` on an actor column. */
const ACTOR_UUID_CAST = [
  /\b(approved_by|cancelled_by|created_by|prepared_by|requested_by|submitted_by)\s*::\s*uuid\b/i,
  /\b(approved_by|cancelled_by|created_by|prepared_by|requested_by|submitted_by)\s*=\s*\$\{[^}]*\}\s*::\s*uuid\b/i,
];
/**
 * Fail closed: in those files every `${…}::uuid` bind is refused unless its expression is listed here, verbatim, as
 * a non-actor id (a company, run, employee, directive, document, journal… row id). A new bind, whatever its name,
 * fails until it is added here or bound as text.
 */
const NON_ACTOR_UUID_BINDS: ReadonlySet<string> = new Set([
  // company
  'companyId', 'ctx.companyId', 'evt.companyId', 'opts.companyId', 'companyIds',
  // payroll runs, employees, leave
  'runId', 'opts.runId', 'scope.runId', 'excludeRunId', 'runIds', 'employeeId', 'employeeIds', 'input.employeeId', 'ins.employeeId',
  'scope.employeeId', 'filters.employeeId ?? null', 'movedEnd', 'input.leaveTypeId', 'importId',
  // tax directives, UIF, SARS submissions
  'directiveId', 'directive.id', 'l.directiveId', 'filter.directiveId ?? null', 'onlyStandalone', 'standaloneIds',
  'undone', 'declarationId', 'submissionId', 'evt.submissionId', 'String(open[0].id)',
  // journals, documents, generic row ids
  'journalId', 'journalEntryId', 'gate.replaces.journalEntryId', 'live.map((h) => String(h.journal_entry_id))',
  'entry.id', 'documentId', 'invoiceId', 'rootId', 'id', 'ids', 'l.id', 'p.id', 'prior.id', 'mapped',
  // wave 6 BF: salary bank files, the paying GL account, the file's employees
  'fileId', 'holder.account.id', 'pay.employeeIds',
  // wave 6 VR: the VAT201 version a settlement is posted against
  'basis.version.id', 'version.id',
  // entity-change log cursors
  'opts.before ?? null', 'opts.changeId ?? null', 'opts.entityId ?? null', 'window.excludeId ?? null',
]);
const unlistedUuidBinds = (line: string) => [...line.matchAll(/\$\{([^}]*)\}\s*::\s*uuid\b/gi)]
  .map((m) => m[1]!.trim()).filter((expr) => !NON_ACTOR_UUID_BINDS.has(expr));

/** file -> line -> exact trimmed text of every actor-column line in a file that names one of the tables. */
const SITES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  [`${S}core/payRunApproverGuard.ts`]: {
    78: 'id: string; requested_by: string; required_role: string | null; rule_role: string | null; authors: string[];',
    82: '`SELECT ar.id::TEXT AS id, ar.requested_by::TEXT AS requested_by, ar.required_role, rl.approver_role AS rule_role,',
    83: 'array_remove(ARRAY[h.prepared_by::TEXT] || COALESCE(ar.content_authors::TEXT[], \'{}\'::TEXT[]), NULL) AS authors',
    109: 'const requester = request.requested_by.toLowerCase();',
  },
  [`${S}gl/approvalDocuments.ts`]: { 167: 'AND prepared_by IS NOT NULL AND approval_plan_hash IS NOT NULL' },
  [`${S}payroll/payRunDecision.ts`]: {
    52: 'SELECT approved_plan_hash, prepared_by::text AS prepared_by, approval_grandfathered_at',
    59: 'const preparedBy = header.prepared_by == null ? null : String(header.prepared_by);',
  },
  [`${S}payroll/payrollApprovalService.ts`]: { 150: 'approved_by = ${approvedBy},' },
  [`${S}payroll/payrollExternalImportService.ts`]: { 59: 'payslip_count, components_present, created_by)' },
  [`${S}payroll/payrollLeaveService.ts`]: { 268: 'approved_by = ${update.approvedBy ?? null},' },
  [`${S}payroll/payrollRunDirectiveClaim.ts`]: { 177: 'company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, payroll_run_id, created_by' },
  [`${S}payroll/payrollRunHeaders.ts`]: { 120: 'company_id, period_month, period_year, created_by, pay_frequency, run_kind, period_start, period_end' },
  [`${S}payroll/payrollRunLock.ts`]: { 229: 'prepared_by     = ${preparedBy},' },
  [`${S}payroll/payrollRunReopen.ts`]: { 78: 'approved_by = NULL,          -- no longer approved; lines_confirmed_at stays (migration 718)' },
  // Wave 6 BF: payroll_bank_files.created_by is TEXT, restamped by its trigger from the session user (999h).
  [`${S}payroll/payrollBankFileService.ts`]: {
    121: 'INSERT INTO payroll_bank_files (company_id, run_id, format, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)',
  },
  [`${S}payroll/taxDirectiveApprover.ts`]: {
    32: 'SELECT requested_by::text AS requested_by, approvers_at_create FROM tax_directives WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid',
    34: 'const creator = row?.requested_by == null ? null : String(row.requested_by).toLowerCase();',
  },
  [`${S}payroll/taxDirectivePaymentService.ts`]: {
    94: 'createdBy: r.created_by != null ? String(r.created_by) : null,',
    209: 'bank_account_id, created_by',
  },
  [`${S}payroll/taxDirectiveService.ts`]: {
    88: 'effective_date, issued_date, expiry_date, status, sars_reference, notes, requested_by, approvers_at_create',
    193: 'approved_by = COALESCE(${approvedByUserId ?? null}, approved_by),',
  },
  [`${S}payroll/uifDeclarationService.ts`]: {
    93: 'submittedBy: r.submitted_by ? String(r.submitted_by) : null,',
    229: 'status, submitted_by, updated_at',
    269: 'submitted_by = ${submittedByUserId},',
  },
  [`${S}reports/sarsComplianceService.ts`]: {
    47: 'submittedBy: row.submitted_by ? String(row.submitted_by) : null,',
    121: 'submitted_by = ${userId}, updated_at = NOW()',
    125: 'INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, form_data, submitted_by)',
    205: 'submitted_by = ${actorUserId},',
  },
  [`${S}reports/sarsEfilingRepo.ts`]: {
    81: 'submitted_by = ${userId},',
    165: 'submitted_by = COALESCE(submitted_by, (SELECT i.created_by FROM sars_efiling_events i',
    217: '(company_id, submission_id, event_type, efiling_status, http_status, correlation_id, detail, message, created_by)',
    253: '(company_id, submission_id, event_type, efiling_status, http_status, correlation_id, detail, message, created_by)',
  },
  [`${S}reports/sarsSubmissionCoverage.ts`]: { 93: 'public.approval_company_member_name(company_id, submitted_by::TEXT) AS submitted_by_name' },
  [`${S}reports/taxDirectiveReportsService.ts`]: {
    33: 'requested_by: string | null;',
    34: 'approved_by: string | null;',
  },
  [`${S}reports/vatReturnsList.ts`]: {
    58: 'submittedBy:    row.submitted_by ? String(row.submitted_by) : undefined,',
  },
  [`${S}reports/vatSubmissionService.ts`]: {
    213: 'sars_reference, submitted_by, journal_entry_id,',
  },
};

/** The VALUES line that binds the actor of a multi-line INSERT pinned above (the column is named on another line). */
const VALUE_BINDS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  [`${S}payroll/payrollExternalImportService.ts`]: { 63: '${JSON.stringify(input.componentsPresent)}::jsonb, ${input.createdBy})' },
  [`${S}payroll/payrollRunDirectiveClaim.ts`]: { 181: '${l.gross}, ${l.paye}, ${Math.round((l.gross - l.paye) * 100) / 100}, h.id, ${userId}' },
  [`${S}payroll/payrollRunHeaders.ts`]: { 123: "${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}, 'monthly', 'regular'," },
  [`${S}payroll/taxDirectivePaymentService.ts`]: { 213: '${bankAccountId}, ${userId}' },
  [`${S}payroll/taxDirectiveService.ts`]: { 105: '${requestedByUserId},' },
  [`${S}payroll/uifDeclarationService.ts`]: { 234: "'draft', ${generatedByUserId}, NOW()" },
  [`${S}reports/sarsComplianceService.ts`]: {
    126: "VALUES (${companyId}::UUID, ${formType}, ${periodStart}, ${periodEnd}, 'draft', ${JSON.stringify(formData)}::jsonb, ${userId})",
  },
  [`${S}reports/sarsEfilingRepo.ts`]: {
    220: 'evt.correlationId ?? null, JSON.stringify(evt.detail ?? {}), evt.message ?? null, evt.createdBy ?? null],',
    257: '${JSON.stringify(evt.detail ?? {})}::jsonb, ${evt.message ?? null}, ${evt.createdBy ?? null}',
  },
  [`${S}reports/vatSubmissionService.ts`]: { 224: '${safeUserId}, -- uuid column until HYb: an untyped bind, no ::uuid on the actor (HYa census)' },
};

/** file:line -> why an actor value is still cast to uuid there. */
const UUID_CAST_EXEMPT: Readonly<Record<string, string>> = {
};

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/(^|\n)\s*--[^\n]*/g, '$1');
}
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f));
}
const lines = (f: string) => readFileSync(resolve(ROOT, f), 'utf8').split('\n');
const castsActorToUuid = (line: string) => ACTOR_UUID_CAST.some((re) => re.test(line)) || unlistedUuidBinds(line).length > 0;

describe('actor ids on the payroll, SARS and tax tables are bound as text (HYa census)', () => {
  const found: Record<string, Record<number, string>> = {};
  const castLines: string[] = [];
  for (const f of trackedFiles()) {
    const stripped = code(readFileSync(resolve(ROOT, f), 'utf8'));
    if (!TABLE.test(stripped)) continue;
    stripped.split('\n').forEach((l, i) => {
      if (COLUMN.test(l)) (found[f] ??= {})[i + 1] = l.trim();
      if (castsActorToUuid(l)) castLines.push(`${f}:${i + 1}`);
    });
  }

  it('every actor-column line in a file that names one of the tables is pinned, with its exact text', () => {
    expect(found).toEqual(SITES);
  });

  it('every pinned multi-line VALUES bind is still on its line', () => {
    const actual = Object.fromEntries(Object.entries(VALUE_BINDS).map(([f, pins]) =>
      [f, Object.fromEntries(Object.keys(pins).map((n) => [n, lines(f)[Number(n) - 1]?.trim()]))]));
    expect(actual).toEqual(VALUE_BINDS);
  });

  it('no actor value is cast to uuid in those files, apart from the reasoned exemption', () => {
    expect(castLines.filter((at) => !(at in UUID_CAST_EXEMPT))).toEqual([]);
    expect(Object.keys(UUID_CAST_EXEMPT).filter((at) => !castLines.includes(at))).toEqual([]);
  });

  it('the cast patterns see what they are for (not dead)', () => {
    expect(castsActorToUuid('approved_by = ${approvedBy}::uuid,')).toBe(true);
    expect(castsActorToUuid("'draft', ${generatedByUserId}::uuid, NOW()")).toBe(true);
    expect(castsActorToUuid('SELECT i.created_by::UUID FROM sars_efiling_events i')).toBe(true);
    expect(castsActorToUuid('approved_by = ${x}::uuid')).toBe(true);
    expect(castsActorToUuid('VALUES (${companyId}::uuid, ${actor}::uuid)')).toBe(true);
    expect(castsActorToUuid('VALUES (${companyId}::uuid, ${runId}::uuid, ${actor})')).toBe(false);
    expect(castsActorToUuid('WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid')).toBe(false);
    expect(castsActorToUuid('prepared_by::text AS prepared_by')).toBe(false);
    expect(TABLE.test(code('// payroll_run_headers in a comment only'))).toBe(false);
  });
});

describe('payroll_employees.tax_directive_number is dead (HYa; migration 999b marks it deprecated, wave 7 drops it)', () => {
  it('nothing outside the change-log masking list (and its test) names it', () => {
    const named = execFileSync('git', ['ls-files', '--', 'src', 'pages', 'scripts', 'tests'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(tsx?|mjs|js|sql)$/.test(f) && !f.startsWith('scripts/migrations/')
        && f !== 'tests/unit/guards/actorIdTextCensus.test.ts')
      .flatMap((f) => lines(f).flatMap((l, i) => (/\btax_directive_number\b/.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(named).toEqual([
      `${S}core/entityChanges/entityChangeMasking.ts:18`,
      'tests/unit/services/core/entityChangeTypes.test.ts:117',
    ]);
  });
});
