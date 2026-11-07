/**
 * WHETHER A PUSH TOUCHES WHAT THE PRINT-PARITY TESTS HOLD. They print every 127th grid pack to PDF in two engines and
 * take about five minutes; the pre-push hook (`scripts/ci/hooks/pre-push`, PARITY_SCOPE=diff) runs them only when the
 * branch's change against origin/master touches the pack's print or fit code, its stylesheets, its fonts, the print or
 * parity tests, their fixtures or config, the PDF transports (and so the image pin), or the dependencies. Otherwise
 * they skip, saying so. Run by hand, or anywhere PARITY_SCOPE is not `diff`, they always run.
 */
import { execFileSync } from 'node:child_process';

export const PARITY_PATHS: readonly RegExp[] = [
  /^styles\//, /^public\/fonts\//, /^src\/modules\/accounting\/services\/packs\//, /^src\/components\/accounting\/packs\//,
  /^src\/lib\/pdf\//, /^src\/lib\/charts\//, /^tests\/unit\/print\//, /^tests\/unit\/printParity\//,
  /^tests\/unit\/services\/packs\/fixtures\//, /^vitest\.print\.config\.ts$/, /^package\.json$/, /^bun\.lock$/,
];

/** The files this branch changes against origin/master (committed or not). */
export function changedFiles(): string[] {
  const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], { encoding: 'utf8' }).trim();
  return execFileSync('git', ['diff', '--name-only', base], { encoding: 'utf8' }).split('\n').filter((f) => f !== '');
}

/** Why the parity tests may skip this run (out of scope), or null where they run. */
export function parityOutOfScope(env: NodeJS.ProcessEnv = process.env, changed: () => string[] = changedFiles): string | null {
  if (env.PARITY_SCOPE !== 'diff') return null;
  const touched = changed().filter((f) => PARITY_PATHS.some((p) => p.test(f)));
  return touched.length > 0 ? null : 'PARITY_SCOPE=diff and this change touches no pack print, fit, font, parity or image-pin file';
}
