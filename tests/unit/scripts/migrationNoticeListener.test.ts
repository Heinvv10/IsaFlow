/**
 * K-081 review round 5 — L1. The migration runner's notice filter used to drop
 * EVERY notice carrying a non-zero SQLSTATE, in order to suppress the thousands
 * of `IF NOT EXISTS ... skipping` lines the corpus emits. That also swallowed
 * `identifier "..." will be truncated` (42622) — which means an object was
 * created under a DIFFERENT name than the migration wrote — and any migration
 * that raises its own notice with an explicit ERRCODE. Filter the specific
 * codes meant, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { makeNoticeListener } from '../../../scripts/migrationNoticeListener';

function collect(notices: Array<{ severity?: string; code?: string; message?: string }>) {
  const lines: string[] = [];
  const listen = makeNoticeListener((line) => lines.push(line));
  for (const n of notices) listen(n);
  return lines;
}

describe('makeNoticeListener', () => {
  it('drops the IF NOT EXISTS chatter that would bury a refusal', () => {
    expect(collect([
      { severity: 'NOTICE', code: '42P07', message: 'relation "loans" already exists, skipping' },
      { severity: 'NOTICE', code: '42710', message: 'constraint "x" ... already exists, skipping' },
      { severity: 'NOTICE', code: '42701', message: 'column "source" ... already exists, skipping' },
    ])).toEqual([]);
  });

  it('prints a migration\'s own RAISE NOTICE', () => {
    expect(collect([{ severity: 'NOTICE', code: '00000', message: 'rebuilt 7 row(s)' }]))
      .toEqual(['  [NOTICE] rebuilt 7 row(s)']);
  });

  it('prints a truncated-identifier notice rather than swallowing it (L1)', () => {
    expect(collect([{
      severity: 'NOTICE', code: '42622',
      message: 'identifier "a_very_long_name" will be truncated to "a_very_long"',
    }])).toEqual([
      '  [NOTICE] identifier "a_very_long_name" will be truncated to "a_very_long"',
    ]);
  });

  it('prints a notice a migration raised with its own ERRCODE (L1)', () => {
    expect(collect([{ severity: 'NOTICE', code: '01000', message: 'refusal: loan_key=LN-1' }]))
      .toEqual(['  [NOTICE] refusal: loan_key=LN-1']);
  });

  it('never filters WARNING and above, whatever the code', () => {
    expect(collect([
      { severity: 'WARNING', code: '42P07', message: 'refused: LN-1' },
      { severity: 'EXCEPTION', code: '42710', message: 'boom' },
    ])).toEqual(['  [WARNING] refused: LN-1', '  [EXCEPTION] boom']);
  });

  it('prints a multi-line refusal WARNING one line at a time', () => {
    expect(collect([{ severity: 'WARNING', message: 'refused:\nLN-1\nLN-2' }]))
      .toEqual(['  [WARNING] refused:', '  [WARNING] LN-1', '  [WARNING] LN-2']);
  });

  it('treats a notice with no severity or code as a plain notice', () => {
    expect(collect([{ message: 'bare' }])).toEqual(['  [NOTICE] bare']);
  });
});
