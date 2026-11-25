/**
 * Intercompany F (i).17: since 1031 app_user cannot write a `payment` message, the suites that used `payment` as a generic probe kind moved to
 * `reject` / `credit_request`. This census keeps them honest: none of them sends a `payment` probe as app_user any more, and each still sends
 * at least one message (so it still tests the guard it was written for).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.join(process.cwd(), 'tests/integration/intercompany');
const SUITES = ['messages', 'messages-guards', 'messages-documents', 'group-race', 'group-race-bulk', 'group-race-rows', 'group-race-matrix',
  'group-race-serial', 'group-isolation', 'group-tables-grants', 'connections', 'company-delete', 'company-locks-scope', 'release-links',
  'link-uniqueness', 'allocation-tenancy', 'group-race-single'];

describe('the probe suites', () => {
  it.each(SUITES)('%s sends a message and no app_user payment probe', (name) => {
    const src = readFileSync(path.join(DIR, `${name}.int.test.ts`), 'utf8');
    expect(src).toMatch(/INSERT INTO intercompany_messages|plantMessage\(/);
    expect(src).not.toMatch(/'payment', 'payment', gen_random_uuid\(\)/);
    expect(src).not.toMatch(/kind: 'payment' \}/);
  });
});
