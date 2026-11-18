/**
 * The run's whole-time limit. A stuck request or query must not hold the deploy locks (and so block every deploy) indefinitely:
 * after `ms` the process says so and exits non-zero, and the locks, each held by a child that ends with its stdin pipe, drop with it.
 * The timer is unref'd, so it never keeps a finished process alive.
 */
export function startWatchdog(ms: number, onTimeout: () => void = () => {
  process.stderr.write(`provision-verify-company: still running after ${Math.round(ms / 60_000)} minute(s); giving up (the deploy locks drop with this process; re-run once the cause is fixed)\n`);
  process.exit(3);
}): () => void {
  const timer = setTimeout(onTimeout, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
