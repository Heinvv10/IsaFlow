/**
 * Layout and naming of the Netcash answer spool (see netcashAnswerSpool.ts for what it is and why): where it lives, the
 * file names (`<company>.<submission>.<settleToken>.jsonl`; a temp is `.<name>.<random>.tmp`), and the two fsync /
 * 0700-directory helpers every writer and mover shares.
 */
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { log } from '@/lib/logger';

/** What the audit record carries, plus who/where: enough to write the record again later, company-scoped. */
export interface AnswerRecord {
  companyId: string;
  userId: string;
  /** The claims' `sub` (audit_log's RLS reads the user from it); null when the claims had none. */
  sub: string | null;
  submissionId: string;
  /** The reference only when it fits varchar(100) as is, else null (as the audit record's entity_ref). */
  entityRef: string | null;
  metadata: { status: string; outcome: string; batchReference: string; settleToken: string; answer: string };
}

export interface SpooledLine extends AnswerRecord { v: 1; spooledAt: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SUFFIX = '.jsonl';
/** A temp file this old was left by a write that did not finish (the write itself is given up on after ANSWER_SPOOL_TIMEOUT_MS). */
export const STALE_TEMP_MS = 60_000;

export function spoolDir(): string {
  const configured = process.env.NETCASH_ANSWER_SPOOL_DIR?.trim();
  if (configured) return configured;
  const state = process.env.STATE_DIRECTORY?.split(':')[0]?.trim();
  if (state) return path.join(state, 'netcash-spool');
  if (process.env.NODE_ENV === 'test') return path.join(tmpdir(), `isaflow-netcash-spool-test-${process.pid}`);
  return path.join(homedir(), '.isaflow', 'netcash-spool');
}
export const replayedDir = () => path.join(spoolDir(), 'replayed');
export const quarantineDir = () => path.join(spoolDir(), 'quarantine');

export const fileName = (r: AnswerRecord) =>
  `${r.companyId.toLowerCase()}.${r.submissionId.toLowerCase()}.${r.metadata.settleToken.replace(/[^0-9a-zA-Z-]/g, '_').slice(0, 64)}${SUFFIX}`;
/** A final entry: not a dot-file (temps are), `.jsonl`. */
export const isEntry = (n: string) => n.endsWith(SUFFIX) && !n.startsWith('.');
/** A temp of a write in flight or never finished: `.<company>.<submission>.<token>.jsonl.<rand>.tmp`. */
export const isTemp = (n: string) => n.startsWith('.') && n.endsWith('.tmp') && !n.startsWith('.probe-');
/** The final-style name a swept temp takes in quarantine/, which the company/submission prefix lookup matches. */
export const quarantineNameOf = (temp: string) => {
  const m = /^\.(.+)\.jsonl\.([^.]+)\.tmp$/.exec(temp);
  return m ? `${m[1]}.${m[2]}.stale${SUFFIX}` : `stale-${temp.replace(/^\./, '')}${SUFFIX}`;
};
export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Flush a directory's entries (a new or renamed file) to disk; a filesystem that cannot is warned about, not fatal. */
export async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    log.warn('netcash answer spool: directory fsync failed', { dir, error: errText(err) }, 'netcash');
  }
}

/** The directory, 0700: made so, and an existing wider one narrowed (the entries hold payment answers). */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const { mode } = await fs.stat(dir);
  if ((mode & 0o077) === 0) return;
  try {
    await fs.chmod(dir, 0o700);
  } catch (err) {
    log.warn('netcash answer spool: directory is group/world accessible and could not be narrowed to 0700', { dir, mode: (mode & 0o777).toString(8), error: errText(err) }, 'netcash');
  }
}

