/**
 * An afterAll's cleanups, each in its own try: every step runs even when an earlier one throws (z19: a failed flag
 * restore must never skip deleting the run's versions, nor the reverse), and the failures are thrown together after.
 */
export async function runAllCleanups(steps: ReadonlyArray<readonly [string, () => Promise<void>]>): Promise<void> {
  const failures: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`cleanup failed: ${failures.join('; ')}`);
}
