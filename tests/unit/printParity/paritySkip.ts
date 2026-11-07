/**
 * WHETHER A PRINT-PARITY TEST MAY SKIP: only where it cannot run by design, and never silently.
 *
 * The parity tests need docker (and access to its daemon), the production Gotenberg image
 * (`PRODUCTION_GOTENBERG_IMAGE`) and pdftotext. Inside GitHub Actions (GITHUB_ACTIONS=true, hosted or self-hosted) a
 * missing one SKIPS, with its actual cause in the reason: a hosted runner has no production image, and velo's
 * self-hosted runner user has no docker access. A required check must not go red for a reason that has nothing to do
 * with the PR (the day CI_HOSTED=off moves the jobs onto velo, say). Outside Actions (a local `bun run ci`, the
 * pre-push hook) a missing one FAILS the test file with its cause, unless PARITY_OPTIONAL=1 says to skip on purpose
 * (logged). They run on velo: by hand, and in a `bun run ci` there (the pre-push hook) when the change touches what
 * they hold (`parityScope.ts`). Re-run them whenever the gotenberg image or the pack's fonts change.
 *
 * Where velo runs production's own `gotenberg` container, its image must be the pinned one (read with a read-only
 * `docker inspect`; nothing is exec'd in it and nothing changed): a parity proven against another image says nothing.
 */
import { execFileSync } from 'node:child_process';
import { log } from '@/lib/logger';
import { PRODUCTION_GOTENBERG_IMAGE, parityUnavailable } from './gotenbergParity';
import { parityOutOfScope } from './parityScope';

/** The image the host's production `gotenberg` container runs, or null where there is no such container. */
export function productionContainerImage(): string | null {
  try {
    return execFileSync('docker', ['inspect', 'gotenberg', '--format', '{{.Image}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Null where the parity tests run; the reason where they may skip. Throws where they must run and cannot. */
export function paritySkip(
  env: NodeJS.ProcessEnv = process.env,
  host: { runningImage: () => string | null; missing: () => string | null; outOfScope: () => string | null } = {
    runningImage: productionContainerImage, missing: parityUnavailable, outOfScope: () => parityOutOfScope(env),
  },
): string | null {
  const scope = host.outOfScope();
  if (scope !== null) {
    log.info('print parity skipped: out of scope for this push', { reason: scope }, 'print-parity');
    return scope;
  }
  const running = host.runningImage();
  if (running !== null && running !== PRODUCTION_GOTENBERG_IMAGE) {
    throw new Error(`production's gotenberg container runs ${running}, not the pinned ${PRODUCTION_GOTENBERG_IMAGE}: re-measure and re-pin`);
  }
  const missing = host.missing();
  if (missing === null) return null;
  if (env.GITHUB_ACTIONS === 'true') {
    const runner = env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'a GitHub-hosted runner, which has no production image' : `a ${env.RUNNER_ENVIRONMENT ?? 'self-hosted'} Actions runner`;
    log.warn('print parity skipped inside GitHub Actions', { reason: missing, runner }, 'print-parity');
    return `${missing} (${runner})`;
  }
  if (env.PARITY_OPTIONAL === '1') {
    log.warn('print parity skipped on purpose (PARITY_OPTIONAL=1)', { reason: missing }, 'print-parity');
    return `${missing}; PARITY_OPTIONAL=1`;
  }
  throw new Error(`print parity cannot run here: ${missing}. Outside GitHub Actions it must run (on velo); PARITY_OPTIONAL=1 skips it on purpose`);
}
