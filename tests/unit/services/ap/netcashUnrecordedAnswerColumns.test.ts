/**
 * AP-01 round 15: recordUnrecordedAnswer inserts into audit_log directly - logAuditOrThrow runs on the request's `sql`
 * transaction, which a 500 rolls back, and this record must survive that. So the two INSERTs must name the same
 * columns: a column logAuditOrThrow gains (a NOT NULL one, say) must not be missing here. Read from the two sources.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const columnsOf = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const m = /INSERT INTO audit_log \(([^)]*)\)/.exec(text);
  if (!m) throw new Error(`no audit_log INSERT in ${file}`);
  return m[1]!.split(',').map((c) => c.trim()).filter(Boolean);
};

describe('the durable unrecorded-answer record', () => {
  it('names exactly the columns logAuditOrThrow inserts, in the same order', () => {
    const general = columnsOf('src/modules/accounting/services/core/auditTrailService.ts');
    expect(general.length).toBeGreaterThan(5);
    expect(columnsOf('src/modules/accounting/services/ap/netcashUnrecordedAnswer.ts')).toEqual(general);
  });
});
