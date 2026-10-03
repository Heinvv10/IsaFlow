/**
 * D10 O1 / O3 under concurrency: the bank reversal of a chain line (now unwinding the document through the chain's
 * root, and running the batch reversal for a batch journal) against its D8 neighbours — HTTP void, MCP void, receipt
 * cancel, batch reversal, member voids, a GL reverse of the head and a fresh match — at every lock point, both
 * directions, k = 0 (line on the root) and k = 2 (line on the head). Expected: no deadlock, no lock timeout, no wait
 * over 4 s, and every non-GL pair ends with the document, its bill / invoice, the chain and every line agreeing.
 * On master the bank reversal of a head line left the document live against a chain it took out, and the batch was
 * never reversed (brk-d8c O1 / O3: 44 and 222 BAD).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser, type Side } from './d10-helpers';
import { family } from './d10-families';
import { hunt } from './d10-interleave';

let c: Ctx;
let admin: Pool;
const PAIRS: Record<Side, [string, string][]> = {
  ap: [['BANKREV', 'HTTPV'], ['BANKREV', 'MCPV'], ['BANKREV', 'GLREV'], ['BANKREV', 'MATCH']],
  ar: [['BANKREV', 'RCPT'], ['BANKREV', 'MCPV'], ['BANKREV', 'GLREV']],
  batch: [['BANKREV', 'BATCH'], ['BANKREV', 'MCPV_M'], ['BANKREV', 'HTTPV_M'], ['BANKREV', 'GLREV']],
};

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D10: bank reversal of a chain line vs its neighbours', () => {
  beforeAll(async () => {
    assertNotProductionDb('D10 bank reversal interleave');
    ({ c } = await setupWithUser('D10BRI'));
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }, 120000);
  afterAll(async () => { await admin?.end(); await clearExtras(c); await teardown(c); }, 120000);

  for (const side of ['ap', 'ar', 'batch'] as Side[]) {
    it(`${side}: every lock point, both directions, k = 0 (root line) and 2 (head line) — 0 BAD`, async () => {
      const bad = await hunt({ fx: c.fx, admin, ks: [0, 2], pairs: PAIRS[side], maxPoints: 40,
        make: (k) => family(c, side, k, [k]) });
      expect(bad).toEqual([]);
    }, 1_800_000);
  }
});
