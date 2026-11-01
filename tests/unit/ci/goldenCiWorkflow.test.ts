// TEXT GUARDS: these assert on ci.yml's source, not on what the job does when it runs. The free-port helper's
// real-listener behaviour and orphan cleanup are covered by goldenFreePort.test.ts and goldenKillSlotOrphans.test.ts.
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

describe('ci.yml dev-server port and process clean-up', () => {
  const step = CI.slice(CI.indexOf('slot_lo=$((3300'));

  it('cleans and picks a verified free port within the slot window before boot', () => {
    const at = (needle: string): number => step.indexOf(needle);
    expect(step).toContain('slot_lo=$((3300 + (slot - 1) * 166))');
    expect(step).toContain('slot_hi=$((slot_lo + 165))');
    expect(at('killSlotOrphans.ts "$slot_lo" "$slot_hi"')).toBeGreaterThan(-1);
    expect(at('golden-free-port.ts "$slot_lo" "$slot_hi"')).toBeGreaterThan(at('killSlotOrphans.ts'));
    expect(at('golden-free-port.ts "$slot_lo" "$slot_hi"')).toBeLessThan(at('setsid bunx next dev'));
  });

  it('starts a process group and stops that exact group on exit', () => {
    expect(step).toContain('setsid bunx next dev');
    expect(step).toContain("trap 'kill -- -$DEVPID 2>/dev/null || true;");
  });

  it('seeds the hosted Demo company before the suite runs (a hosted run without it tests empty books)', () => {
    const at = (needle: string): number => step.indexOf(needle);
    expect(at('bun scripts/ci/golden-hosted/seed-demo-app.ts')).toBeGreaterThan(at('boot_dev\n'));
    expect(at('bun scripts/ci/golden-hosted/seed-demo-app.ts')).toBeLessThan(at('bun run test:e2e:golden'));
  });

  it('gives the slot login only to the velo test command, never to the hosted one', () => {
    expect(step).toMatch(/\( export GOLDEN_SLOT_NUMBER GOLDEN_COMPANY_ID GOLDEN_USER_EMAIL GOLDEN_USER_PASSWORD; BASE_URL="http:\/\/localhost:\$GOLDEN_PORT" bun run test:e2e:golden \$SHARD \)/);
    expect(step).toMatch(/if \[ "\$HOSTED" = true \]; then\n\s+# shellcheck disable=SC2086\n\s+BASE_URL="http:\/\/localhost:\$GOLDEN_PORT" bun run test:e2e:golden \$SHARD/);
  });

  it('never kills by pattern', () => {
    expect(CI).not.toMatch(/\b(pkill|killall)\b|fuser\s+-k|kill\s+\$\(\s*pgrep/);
  });
});

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
