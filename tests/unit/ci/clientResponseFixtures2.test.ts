/**
 * Adversarial pass 2 on the client-response gate: 55 evasions (26 detected, 29 stated limits that are asserted to
 * STILL be missed, so a fix flips them on purpose) and 16 correct shapes that must stay quiet (no false positives).
 * See clientResponseFixtures2.ts for the limit groups.
 */
import { describe, expect, it } from 'vitest';
import { analyzeSources } from '../../../scripts/ci/clientResponseRule';
import { selectClientFiles } from '../../../scripts/ci/clientResponseSelect';
import { FIXTURES, LIMIT_GROUPS, NEGATIVES, type Fx } from './clientResponseFixtures2';

/** Selection and analysis together, as the CLI does: a file the selection drops is never analysed. */
function run(f: Fx) {
  const selected = selectClientFiles(Object.keys(f.files), (p) => f.files[p]!);
  return analyzeSources(selected.map((p) => ({ file: p, text: f.files[p]! }))).hits;
}

describe('pass 2 evasions', () => {
  for (const f of FIXTURES) {
    if (f.expectedLimit) it(`${f.id} ${f.name} -> stated limit (${f.limitGroup}), still missed`, () => expect(run(f).some((h) => h.kind === f.kind)).toBe(false));
    else it(`${f.id} ${f.name} -> detected as class ${f.kind}`, () => expect(run(f).some((h) => h.kind === f.kind)).toBe(true));
  }
  it('every limit group names fixtures that exist, and each fixture is in one group', () => {
    const ids = new Set(FIXTURES.map((f) => f.id));
    const all = Object.values(LIMIT_GROUPS).flatMap((g) => g.ids);
    for (const id of all) expect(ids.has(id)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('pass 2 correct code: no false positives', () => {
  for (const f of NEGATIVES) it(`${f.id} ${f.name} -> quiet`, () => expect(run(f)).toEqual([]));
  it('there are 16 of them', () => expect(NEGATIVES).toHaveLength(16));
});
