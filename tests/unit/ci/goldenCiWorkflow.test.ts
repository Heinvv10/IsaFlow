// The golden-paths job in ci.yml maps a runner to a slot with a shell `case`; slotConfig.ts owns the slot numbers. Nothing
// else ties them together, so a copy-pasted runner arm that reuses a slot (two runners on one company, the thing slots
// exist to prevent) or a slot with no runner would pass every other test.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GOLDEN_SLOTS } from '../../../scripts/ci/golden/slotConfig';

const CI = readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8');

/** The `runner) slot=n ;;` arms of the case on $RUNNER_NAME. */
function runnerSlotArms(workflow: string): Array<{ runner: string; slot: number }> {
  const body = /case "\$RUNNER_NAME" in([\s\S]*?)\n\s*esac/.exec(workflow)?.[1];
  if (body === undefined) throw new Error('ci.yml has no `case "$RUNNER_NAME" in` block');
  return [...body.matchAll(/^\s*([A-Za-z0-9_.-]+)\)\s*slot=(\d+)\s*;;/gm)].map((m) => ({ runner: m[1]!, slot: Number(m[2]) }));
}

describe('ci.yml runner to slot mapping', () => {
  const arms = runnerSlotArms(CI);

  it('has one arm per runner and uses each golden slot exactly once', () => {
    expect(arms.length).toBeGreaterThan(0);
    expect(new Set(arms.map((a) => a.runner)).size).toBe(arms.length);
    expect(arms.map((a) => a.slot).sort()).toEqual([...GOLDEN_SLOTS]);
  });

  it('names the runners the runbook names', () => {
    expect(Object.fromEntries(arms.map((a) => [a.runner, a.slot]))).toEqual({ 'velo-server-u': 1, 'velo-isaflow-u2': 2, 'velo-isaflow-u3': 3 });
  });

  it('refuses an unknown runner rather than falling back to Demo', () => {
    expect(CI).toMatch(/\*\)\s*\n\s*echo "::error::runner '\$RUNNER_NAME' has no golden slot[^\n]*\n\s*exit 1/);
  });

  describe('runnerSlotArms', () => {
    const wrap = (arms: string) => `run: |\n  case "$RUNNER_NAME" in\n${arms}\n    *) exit 1 ;;\n  esac\n`;

    it('reads the arms of a case block', () => {
      expect(runnerSlotArms(wrap('    a) slot=1 ;;\n    b) slot=2 ;;'))).toEqual([{ runner: 'a', slot: 1 }, { runner: 'b', slot: 2 }]);
    });

    it('sees a 4th runner that reuses a slot, which the test above then rejects', () => {
      const dup = runnerSlotArms(wrap('    a) slot=1 ;;\n    b) slot=2 ;;\n    c) slot=3 ;;\n    d) slot=3 ;;'));
      expect(dup.map((x) => x.slot).sort()).not.toEqual([...GOLDEN_SLOTS]);
    });

    it('throws when the workflow has no case block', () => {
      expect(() => runnerSlotArms('run: echo hi')).toThrow(/no `case/);
    });
  });
});
