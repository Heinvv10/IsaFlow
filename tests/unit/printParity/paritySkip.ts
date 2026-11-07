/**
 * WHETHER A PRINT-PARITY TEST MAY SKIP: only where it cannot run by design, and never silently.
 *
 * The parity tests need docker, the production Gotenberg image (`PRODUCTION_GOTENBERG_IMAGE`) and pdftotext: velo has
 * them; GitHub's hosted runners do not, and there (GITHUB_ACTIONS=true) they skip, saying why. Anywhere else a missing
 * one FAILS the test file, unless PARITY_OPTIONAL=1 says to skip on purpose (logged). They run on velo: by hand, in a
 * velo `bun run ci` and the pre-push hook. Re-run them whenever the gotenberg image or the pack's fonts change.
 *
 * Where velo runs production's own `gotenberg` container, its image must be the pinned one (read with a read-only
 * `docker inspect`; nothing is exec'd in it and nothing changed): a parity proven against another image says nothing.
 */
import { execFileSync } from 'node:child_process';
import { log } from '@/lib/logger';
import { PRODUCTION_GOTENBERG_IMAGE, parityUnavailable } from './gotenbergParity';

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
  host: { runningImage: () => string | null; missing: () => string | null } = { runningImage: productionContainerImage, missing: parityUnavailable },
): string | null {
  const running = host.runningImage();
  if (running !== null && running !== PRODUCTION_GOTENBERG_IMAGE) {
    throw new Error(`production's gotenberg container runs ${running}, not the pinned ${PRODUCTION_GOTENBERG_IMAGE}: re-measure and re-pin`);
  }
  const missing = host.missing();
  if (missing === null) return null;
  if (env.GITHUB_ACTIONS === 'true') return `${missing}; GitHub's hosted runners have no production image`;
  if (env.PARITY_OPTIONAL === '1') {
    log.warn('print parity skipped on purpose (PARITY_OPTIONAL=1)', { reason: missing }, 'print-parity');
    return `${missing}; PARITY_OPTIONAL=1`;
  }
  throw new Error(`print parity cannot run here: ${missing}. It must run on velo; PARITY_OPTIONAL=1 skips it on purpose`);
}
