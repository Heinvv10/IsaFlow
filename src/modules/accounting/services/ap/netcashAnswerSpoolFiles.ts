/**
 * Layout and naming of the Netcash answer spool (see netcashAnswerSpool.ts for what it is and why): where it lives, the
 * file names (`<company>.<submission>.<settleToken>.jsonl`; a temp is `.<name>.<random>.tmp`), and the two fsync /
 * 0700-directory helpers every writer and mover shares.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { log } from '@/lib/logger';
import type { ClaimSettlement } from './netcashClaimSettle';

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

/**
 * The statuses a spool file name can carry: one list for fileName, nameStatus and promotionOf, typed to the settle's own
 * statuses (the type check below fails the build when ClaimSettlement gains one). A status missing from this list makes
 * its temps fail promotionOf's name check: they are never promoted, they are quarantined and they BLOCK (a name that
 * says nothing). So a new ClaimSettlement status is added HERE, and to nameStatus's judgement of what blocks.
 */
export const NAME_STATUSES = ['submitted', 'failed', 'unknown'] as const satisfies readonly ClaimSettlement['status'][];
export type NameStatus = (typeof NAME_STATUSES)[number];
const _everyStatusNamed: Exclude<ClaimSettlement['status'], NameStatus> extends never ? true : never = true;
const STATUS_ALT = NAME_STATUSES.join('|');

/**
 * `<company>.<submission>.<token>.<status>.jsonl`: the answer's status is IN the name, so a file that cannot be read
 * (torn, a temp that never finished) can still be judged: a name that says failed / unknown is not an acceptance.
 */
export const fileName = (r: AnswerRecord) =>
  `${r.companyId.toLowerCase()}.${r.submissionId.toLowerCase()}.${r.metadata.settleToken.replace(/[^0-9a-zA-Z-]/g, '_').slice(0, 64)}`
  + `.${r.metadata.status.replace(/[^a-zA-Z]/g, '').toLowerCase() || 'unknown'}${SUFFIX}`;
/**
 * The status a spool file's NAME carries (`<c>.<s>.<token>.<status>.jsonl`, the same with a leading dot and `.jsonl.<rand>.tmp`
 * for a temp, or `.<status>.<rand>.stale.jsonl` swept), or null when it carries none (it cannot be told, so it blocks).
 */
export const nameStatus = (name: string): NameStatus | null =>
  (new RegExp(`^\\.?[0-9a-f-]{36}\\.[0-9a-f-]{36}\\.[0-9a-zA-Z_-]+\\.(${STATUS_ALT})\\.`, 'i').exec(name)?.[1]?.toLowerCase() as NameStatus | undefined) ?? null;
/** A final entry: not a dot-file (temps are), `.jsonl`. */
export const isEntry = (n: string) => n.endsWith(SUFFIX) && !n.startsWith('.');
/** A temp of a write in flight or never finished: `.<company>.<submission>.<token>.jsonl.<rand>.tmp`. */
export const isTemp = (n: string) => n.startsWith('.') && n.endsWith('.tmp') && !n.startsWith('.probe-');
/**
 * The final-style name a swept temp takes in quarantine/, which the company/submission prefix lookup matches. Always a
 * plain file name, and it ends in a short hash of the ORIGINAL name, so two names that sanitise alike never collide
 * (a rename would silently replace the first).
 */
export const quarantineNameOf = (temp: string) => {
  const hash = createHash('sha1').update(temp).digest('hex').slice(0, 8);
  const m = /^\.(.+)\.jsonl\.([^.]+)\.tmp$/.exec(temp);
  return (m ? `${m[1]}.${m[2]}-${hash}.stale${SUFFIX}` : `stale-${temp.replace(/^\./, '')}.${hash}${SUFFIX}`).replace(/[^0-9a-zA-Z._-]/g, '_');
};
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEMP_NAME = new RegExp(`^\\.(${UUID_PART})\\.(${UUID_PART})\\.([0-9a-zA-Z_-]+)\\.(${STATUS_ALT})\\.jsonl\\.[0-9a-zA-Z-]+\\.tmp$`, 'i');
/**
 * What a temp's own FILE NAME says it is - company, submission and the final name it would be promoted to - or null
 * when the name is not exactly ours (UUID company and submission, a plain token, a known status). The promotion never
 * trusts the temp's CONTENT for a path: a name built from content could carry `../`.
 */
export function promotionOf(temp: string): { companyId: string; submissionId: string; finalName: string } | null {
  const m = TEMP_NAME.exec(temp);
  return m ? { companyId: m[1]!.toLowerCase(), submissionId: m[2]!.toLowerCase(), finalName: temp.slice(1).replace(/\.jsonl\.[^.]+\.tmp$/, SUFFIX) } : null;
}
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

