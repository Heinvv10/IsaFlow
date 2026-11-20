/**
 * The VAT201's readers hide a cancelled document's journals by ONE rule (reports/vatCancelledPairSql): the box basis,
 * the nil-rated aggregate and its drill each send the SAME fragment text, bound to the same company and period. Field 1
 * is the box basis less the nil-rated give-back, so a reader with its own copy would declare a journal twice or not at
 * all. The SQL is captured, never run: the placeholders are renumbered when a fragment is spliced, so they are compared
 * as `$?` with their bound values checked separately.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatPeriodLines } from '@/modules/accounting/services/reports/vatBoxBasisQuery';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { listNilRatedLines } from '@/modules/accounting/services/reports/vat201NilRatedDrill';
import {
  cancelledEntriesCteSql, uncodedLegCountsSql, untaxedJournalsCteSql,
} from '@/modules/accounting/services/reports/vatCancelledPairSql';

const CO = '7a7473e3-a3cf-4016-aaf3-fa310d40de6e';
const FROM = '2026-03-01';
const TO = '2026-03-31';

type Captured = { text: string; values: unknown[] };
let captured: Captured[] = [];
const proto = Object.getPrototypeOf(sql`SELECT 1`) as { then: (...a: unknown[]) => unknown };
const realThen = proto.then;

beforeEach(() => {
  captured = [];
  proto.then = function (this: Captured, res: unknown, rej: unknown) {
    captured.push({ text: this.text, values: this.values });
    return Promise.resolve([]).then(res as never, rej as never);
  };
});
afterEach(() => { proto.then = realThen; });

const shape = (text: string) => text.replace(/\$\d+/g, '$?').replace(/\s+/g, ' ').trim();

async function sent(read: () => Promise<unknown>): Promise<Captured> {
  await read();
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

/** `frag` appears in `q` once, and the values bound inside it are the fragment's own, in order. */
function embeds(q: Captured, frag: Captured): void {
  const whole = shape(q.text);
  const part = shape(frag.text);
  expect(whole.split(part)).toHaveLength(2);
  const before = whole.slice(0, whole.indexOf(part));
  const offset = (before.match(/\$\?/g) ?? []).length;
  expect(q.values.slice(offset, offset + frag.values.length)).toEqual(frag.values);
}

const READERS: [string, () => Promise<unknown>][] = [
  ['the box basis', () => getVatPeriodLines(CO, FROM, TO)],
  ['the nil-rated aggregate', () => getNilRatedSupplies(CO, FROM, TO)],
  ['the nil-rated drill', () => listNilRatedLines(CO, FROM, TO, '2')],
];

describe('one pair rule for every VAT201 reader', () => {
  it.each(READERS)('%s sends the shared cancelled_entries fragment, bound to this company and period', async (_n, read) => {
    const q = await sent(read);
    embeds(q, cancelledEntriesCteSql(CO, FROM, TO) as unknown as Captured);
    expect(shape(q.text)).toMatch(/^WITH RECURSIVE /);
  });

  it.each(READERS.slice(1))('%s hides those journals and counts uncoded legs by the shared rule', async (_n, read) => {
    const q = await sent(read);
    embeds(q, untaxedJournalsCteSql(CO) as unknown as Captured);
    expect(shape(q.text)).toContain(shape((uncodedLegCountsSql() as unknown as Captured).text));
    expect(shape(q.text)).toContain('AND je.id NOT IN (SELECT id FROM cancelled_entries)');
    expect(shape(q.text)).not.toMatch(/\bcancelled_entries AS \(.*\bcancelled_entries AS \(/);
  });
});
