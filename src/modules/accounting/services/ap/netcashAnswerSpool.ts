/**
 * The local spool of a Netcash answer nothing else could record (AP-01 residual 3a). When both bounded settle attempts
 * fail AND the durable audit_log insert (netcashUnrecordedAnswer) fails too - the database is that unwell - the answer
 * is appended here as ONE JSON line (the metadata the audit record carries) and fsynced, so it survives the 500 and a
 * restart on a disk the database does not share. resolve refuses to FREE a pending row with a spooled acceptance, and
 * netcashAnswerSpoolReplay moves entries into audit_log once the database is back.
 *
 * One file per answer, named `<company>.<submission>.<settleToken>.jsonl` (all three are ours, never Netcash's): a
 * lookup by company and submission is a directory listing, and "replayed" is a rename to `<name>.replayed` - the line is
 * never deleted or rewritten. Written through fs.promises with a timeout (ANSWER_SPOOL_TIMEOUT_MS) rather than the sync
 * calls, so a stalled disk cannot freeze the event loop or hold the 500; a write that outlives the timeout may still
 * complete, which only adds evidence. Never throws into the request: a failure is log.error'd with the answer.
 *
 * Location: NETCASH_ANSWER_SPOOL_DIR, else `<STATE_DIRECTORY>/netcash-spool` (systemd StateDirectory=), else
 * ~/.isaflow/netcash-spool - never under the deploy directory (deploy.sh rsyncs --delete over /home/velo/isaflow). The
 * service unit runs ProtectSystem=strict with ReadWritePaths=/home/velo/isaflow /tmp: the default home path is read-only
 * to it until the unit also lists it (an ops step) or sets StateDirectory= / NETCASH_ANSWER_SPOOL_DIR. A test run
 * defaults to a per-process directory under the OS temp dir, so no test writes into a home directory.
 */
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { log } from '@/lib/logger';
import { ANSWER_SPOOL_TIMEOUT_MS } from './netcashTimeouts';

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

interface SpooledLine extends AnswerRecord { v: 1; spooledAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUFFIX = '.jsonl';
const REPLAYED = '.replayed';

export function spoolDir(): string {
  const configured = process.env.NETCASH_ANSWER_SPOOL_DIR?.trim();
  if (configured) return configured;
  const state = process.env.STATE_DIRECTORY?.split(':')[0]?.trim();
  if (state) return path.join(state, 'netcash-spool');
  if (process.env.NODE_ENV === 'test') return path.join(tmpdir(), `isaflow-netcash-spool-test-${process.pid}`);
  return path.join(homedir(), '.isaflow', 'netcash-spool');
}

const fileName = (r: AnswerRecord) =>
  `${r.companyId.toLowerCase()}.${r.submissionId.toLowerCase()}.${r.metadata.settleToken.replace(/[^0-9a-zA-Z-]/g, '_').slice(0, 64)}${SUFFIX}`;

/** Flush a directory's entries (a new or renamed file) to disk; a filesystem that cannot is warned about, not fatal. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    log.warn('netcash answer spool: directory fsync failed', { dir, error: err instanceof Error ? err.message : String(err) }, 'netcash');
  }
}

async function appendDurably(rec: AnswerRecord): Promise<void> {
  const dir = spoolDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ v: 1, ...rec, spooledAt: new Date().toISOString() } satisfies SpooledLine)}\n`;
  const handle = await fs.open(path.join(dir, fileName(rec)), 'a', 0o600);
  try {
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDir(dir);
}

/** Spool the answer. true once it is on disk; false (and log.error with the answer) when it could not be. Never throws. */
export async function spoolAnswer(rec: AnswerRecord): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!UUID.test(rec.companyId) || !UUID.test(rec.submissionId)) throw new Error('company or submission id is not a UUID');
    await Promise.race([
      appendDurably(rec),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`spool write exceeded ${ANSWER_SPOOL_TIMEOUT_MS} ms`)), ANSWER_SPOOL_TIMEOUT_MS); }),
    ]);
    log.warn('netcash answer spooled to local disk - the settle and audit_log could not record it', { submissionId: rec.submissionId, file: fileName(rec) }, 'netcash');
    return true;
  } catch (err) {
    log.error('netcash answer could not be spooled either - only this log and the 500 carry it', {
      submissionId: rec.submissionId, companyId: rec.companyId, status: rec.metadata.status, batchReference: rec.metadata.batchReference,
      answer: rec.metadata.answer, error: err instanceof Error ? err.message : String(err),
    }, 'netcash');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The directory's pending entries' names; none when the directory does not exist yet. Throws on any other failure. */
async function pendingNames(): Promise<string[]> {
  try {
    return (await fs.readdir(spoolDir())).filter((n) => n.endsWith(SUFFIX));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

function parse(text: string): SpooledLine | null {
  try {
    const v = JSON.parse(text) as Partial<SpooledLine> | null;
    return v && v.v === 1 && typeof v.companyId === 'string' && typeof v.submissionId === 'string' && v.metadata && typeof v.metadata.settleToken === 'string'
      ? v as SpooledLine : null;
  } catch {
    return null; // a torn or foreign file: the caller decides what that means
  }
}

/**
 * A spooled ACCEPTANCE for this submission in this company that is not in audit_log yet; null if none. resolve calls
 * it for a pending row it is asked to free. Company and submission come from the file NAME (ours), so an entry that
 * cannot be read still counts - fail closed, as `outcome: 'unreadable'` - and a directory that cannot be listed throws
 * (the resolve fails, never frees on a guess).
 */
export async function spooledAcceptedAnswer(companyId: string, submissionId: string): Promise<{ outcome: string; batchReference: string } | null> {
  const prefix = `${companyId.toLowerCase()}.${submissionId.toLowerCase()}.`;
  for (const name of (await pendingNames()).filter((n) => n.startsWith(prefix))) {
    const entry = parse(await fs.readFile(path.join(spoolDir(), name), 'utf8').catch(() => ''));
    if (!entry) return { outcome: 'accepted (spool entry unreadable)', batchReference: '' };
    if (entry.companyId.toLowerCase() === companyId.toLowerCase() && entry.metadata.status === 'submitted') {
      return { outcome: entry.metadata.outcome || 'accepted', batchReference: entry.metadata.batchReference ?? '' };
    }
  }
  return null;
}

/** Entries not yet replayed (an unreadable one is logged and left where it is). */
export async function pendingSpooled(): Promise<{ file: string; entry: AnswerRecord }[]> {
  const out: { file: string; entry: AnswerRecord }[] = [];
  for (const name of await pendingNames()) {
    const file = path.join(spoolDir(), name);
    const entry = parse(await fs.readFile(file, 'utf8').catch(() => ''));
    if (entry) out.push({ file, entry });
    else log.error('netcash answer spool: an entry cannot be read - left in place, still blocks its submission', { file }, 'netcash');
  }
  return out;
}

/** Mark an entry replayed: renamed, never deleted - the line stays on disk. */
export async function markReplayed(file: string): Promise<void> {
  await fs.rename(file, `${file}${REPLAYED}`);
  await syncDir(path.dirname(file));
}
