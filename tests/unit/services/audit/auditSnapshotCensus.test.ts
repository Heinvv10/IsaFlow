/**
 * Census for forensic-controls step 4 (migration 889) — every writer and entry
 * point pinned, so a new one fails here and has to be decided on:
 *  1. the six audit tables are written only by 889's two definers, called only
 *     from the snapshot and check-run services, and read only by snapshotRead;
 *  2. audit_trail_exports is written only where the pack flow writes it;
 *  3. every statement that closes or locks a fiscal period, a year or a VAT
 *     period is in a pinned function, and every such function queues the
 *     automatic snapshot (or is the year close's own lock, covered by the close);
 *  4. the fifteen integrity checks are run only by their MCP tool and the audit
 *     adapter.
 * Read from disk with comments stripped (tests/unit/helpers/sourceCensus).
 */
import { describe, expect, it } from 'vitest';
import { sourceFiles, stripComments } from '../../helpers/sourceCensus';

const MIGRATIONS = 'scripts/migrations/sql/';
const code = () => sourceFiles().filter(({ file }) => !file.startsWith(MIGRATIONS))
  .map(({ file, text }) => ({ file, text: stripComments(text, file) }));
const filesMatching = (re: RegExp) => code().filter(({ text }) => re.test(text)).map(({ file }) => file).sort();

/** The body of `function name(` up to the next top-level `\nexport ` or `\n}` at column 0. */
function body(file: string, name: string): string {
  const text = code().find((f) => f.file === file)?.text ?? '';
  const start = text.search(new RegExp(`function ${name}\\(`));
  if (start < 0) return '';
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

const AUDIT_TABLE = /\baudit_(?:snapshots|snapshot_tb|snapshot_journals|snapshot_lines|check_runs|check_results)\b/;

describe('the audit tables', () => {
  it('only snapshotRead.ts names them outside 889 (the writers are definers); the MCP tool shares one name', () => {
    expect(filesMatching(AUDIT_TABLE)).toEqual([
      'src/lib/mcp/clientMetadata.ts',
      'src/lib/mcp/tools/auditSnapshots.ts',
      'src/modules/accounting/services/audit/snapshotRead.ts',
    ]);
    // In those two the only mention is the tool's name — never a table in SQL (FROM / JOIN / INTO / UPDATE / TABLE).
    for (const f of code().filter(({ file }) => file.startsWith('src/lib/mcp/'))) {
      for (const m of f.text.matchAll(new RegExp(AUDIT_TABLE.source, 'g'))) {
        expect(m[0], f.file).toBe('audit_snapshots');
        expect(f.text.slice(Math.max(0, m.index! - 30), m.index!), f.file).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:public\.)?$/i);
      }
    }
  });

  it('no source statement writes them', () => {
    const write = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:public\.)?audit_(?:snapshot|check)/i;
    expect(filesMatching(write)).toEqual([]);
  });

  it('the two writers are called from the snapshot and check-run services only', () => {
    expect(filesMatching(/\baudit_snapshot_record\b/)).toEqual(['src/modules/accounting/services/audit/snapshotService.ts']);
    expect(filesMatching(/\baudit_check_run_record\b/)).toEqual(['src/modules/accounting/services/audit/checks/checkRunService.ts']);
  });
});

describe('audit_trail_exports', () => {
  it('is written only by the export service, the snapshot pack, its route and the QA seed', () => {
    const write = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?audit_trail_exports\b/i;
    expect(filesMatching(write)).toEqual([
      'pages/api/accounting/audit-exports/index.ts',
      'scripts/seed-prd05-qa-data.ts',
      'src/modules/accounting/services/audit/packExport.ts',
      'src/modules/accounting/services/capture/auditTrailExportService.ts',
    ]);
  });
});

describe('close and lock entry points queue the automatic snapshot', () => {
  it('every statement that closes or locks a period, year or VAT period is in a pinned file', () => {
    expect(filesMatching(/UPDATE\s+fiscal_periods[\s\S]{0,80}?SET\s+status\s*=\s*'(?:closed|locked)'/i)).toEqual([
      'src/modules/accounting/services/gl/fiscalPeriodService.ts',
      'src/modules/accounting/services/gl/yearEndJournalPoster.ts',
    ]);
    expect(filesMatching(/INSERT\s+INTO\s+vat_period_locks\b/i)).toEqual(['src/modules/accounting/services/reports/vatPeriodLockService.ts']);
  });

  it('each closing or locking function schedules a snapshot', () => {
    const at: [string, string, string][] = [
      ['src/modules/accounting/services/gl/fiscalPeriodService.ts', 'closePeriod', 'period_close'],
      ['src/modules/accounting/services/gl/fiscalPeriodService.ts', 'lockPeriod', 'period_close'],
      ['src/modules/accounting/services/gl/fiscalPeriodService.ts', 'closeYear', 'year_close'],
      ['src/modules/accounting/services/gl/yearEndCloseService.ts', 'closeFiscalYear', 'year_close'],
      ['src/modules/accounting/services/reports/vatPeriodLockService.ts', 'lockVatPeriod', 'vat_lock'],
    ];
    for (const [file, fn, trigger] of at) {
      expect(body(file, fn), `${fn} schedules ${trigger}`).toMatch(new RegExp(`scheduleAutoSnapshot\\('${trigger}'`));
    }
    // yearEndJournalPoster's lockYear runs only inside closeFiscalYear, which schedules the year_close snapshot.
    expect(filesMatching(/\blockYear\(/)).toEqual(['src/modules/accounting/services/gl/yearEndJournalPoster.ts']);
  });

  it('nothing else schedules one', () => {
    expect(filesMatching(/\bscheduleAutoSnapshot\(/)).toEqual([
      'src/modules/accounting/services/audit/autoSnapshotQueue.ts',
      'src/modules/accounting/services/gl/fiscalPeriodService.ts',
      'src/modules/accounting/services/gl/yearEndCloseService.ts',
      'src/modules/accounting/services/reports/vatPeriodLockService.ts',
    ]);
  });
});

describe('the fifteen integrity checks', () => {
  it('are run only by data_integrity_checks and the audit check runs', () => {
    expect(filesMatching(/\brunIntegrityChecks\(/)).toEqual([
      'src/lib/mcp/tools/integrity.ts',
      'src/modules/accounting/services/audit/checks/integrityAdapter.ts',
      'src/modules/accounting/services/gl/integrityChecks/index.ts',
    ]);
  });
});
