/**
 * Golden afterAll cleanups (z20: put the flag override back, delete the run's versions) run through `runAllCleanups`:
 * every step runs even when an earlier one throws, and the failures are reported together afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAllCleanups } from '../../e2e/golden-paths/helpers/runAllCleanups';

describe('runAllCleanups', () => {
  it('runs every step when the first throws, then throws naming each failure', async () => {
    const second = vi.fn(async () => undefined);
    await expect(runAllCleanups([
      ['restore flag', async () => { throw new Error('db down'); }],
      ['delete versions', second],
    ])).rejects.toThrow(/restore flag: db down/);
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('runs the first when a later one throws; both failures named', async () => {
    const first = vi.fn(async () => undefined);
    await expect(runAllCleanups([
      ['restore flag', first],
      ['delete versions', async () => { throw new Error('404'); }],
      ['third', async () => { throw new Error('x'); }],
    ])).rejects.toThrow(/delete versions: 404; third: x/);
    expect(first).toHaveBeenCalledTimes(1);
  });
  it('resolves when every step does', async () => {
    await expect(runAllCleanups([['a', async () => undefined]])).resolves.toBeUndefined();
  });
});
