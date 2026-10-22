/**
 * The local spool of a Netcash answer nothing else could record (AP-01 residual 3a). When both bounded settle attempts
 * fail AND the durable audit_log insert (netcashUnrecordedAnswer) fails too - the database is that unwell - the answer
 * is appended here as ONE JSON line (the metadata the audit record carries) and fsynced, so it survives the 500 and a
 * restart on a disk the database does not share. resolve refuses to FREE a pending row with a spooled acceptance, and
 * netcashAnswerSpoolReplay moves entries into audit_log once the database is back.
 *
 * One file per answer, named `<company>.<submission>.<settleToken>.jsonl` (all three are ours, never Netcash's): a
 * lookup by company and submission is a directory listing. A file is COMPLETE OR ABSENT: it is written under a temporary
 * name (`.<name>.<random>.tmp`, ignored by every lookup), fsynced, renamed to its final name and the directory fsynced,
 * so a crash mid-write leaves at most a stray temp, never a torn entry. A temp is not replayed, but it is NOT ignored
 * by the lookup either (fail closed): one carrying the company and submission blocks like an entry would - judged by
 * its content when it parses, blocking when it does not. One older than STALE_TEMP_MS is swept to quarantine/ under a
 * final-style name (`<company>.<submission>.<token>.<rand>.stale.jsonl`) so it keeps blocking. "Replayed" is a move to
 * `replayed/`, and an entry the database keeps refusing for its own content moves to
 * `quarantine/` - lines are never deleted or rewritten; a quarantined acceptance still blocks resolve. Written through
 * fs.promises with a timeout (ANSWER_SPOOL_TIMEOUT_MS) rather than the sync calls, so a stalled disk cannot freeze the
 * event loop or hold the 500; a write that outlives the timeout may still complete, which only adds evidence. Never
 * throws into the request: a failure is log.error'd with the answer.
 *
 * Location: NETCASH_ANSWER_SPOOL_DIR, else `<STATE_DIRECTORY>/netcash-spool` (systemd StateDirectory=), else
 * ~/.isaflow/netcash-spool - never under the deploy directory (deploy.sh rsyncs --delete over /home/velo/isaflow). The
 * service unit runs ProtectSystem=strict with ReadWritePaths=/home/velo/isaflow /tmp: the default home path is read-only
 * to it until the unit also lists it (an ops step) or sets StateDirectory= / NETCASH_ANSWER_SPOOL_DIR. A test run
 * defaults to a per-process directory under the OS temp dir, so no test writes into a home directory.
 */
import { randomUUID } from 'crypto';
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
/** A temp file this old was left by a write that did not finish (the write itself is given up on after ANSWER_SPOOL_TIMEOUT_MS). */
const STALE_TEMP_MS = 60_000;

export function spoolDir(): string {
  const configured = process.env.NETCASH_ANSWER_SPOOL_DIR?.trim();
  if (configured) return configured;
  const state = process.env.STATE_DIRECTORY?.split(':')[0]?.trim();
  if (state) return path.join(state, 'netcash-spool');
  if (process.env.NODE_ENV === 'test') return path.join(tmpdir(), `isaflow-netcash-spool-test-${process.pid}`);
  return path.join(homedir(), '.isaflow', 'netcash-spool');
}
const replayedDir = () => path.join(spoolDir(), 'replayed');
const quarantineDir = () => path.join(spoolDir(), 'quarantine');

const fileName = (r: AnswerRecord) =>
  `${r.companyId.toLowerCase()}.${r.submissionId.toLowerCase()}.${r.metadata.settleToken.replace(/[^0-9a-zA-Z-]/g, '_').slice(0, 64)}${SUFFIX}`;
/** A final entry: not a dot-file (temps are), `.jsonl`. */
const isEntry = (n: string) => n.endsWith(SUFFIX) && !n.startsWith('.');
/** A temp of a write in flight or never finished: `.<company>.<submission>.<token>.jsonl.<rand>.tmp`. */
const isTemp = (n: string) => n.startsWith('.') && n.endsWith('.tmp') && !n.startsWith('.probe-');
/** The final-style name a swept temp takes in quarantine/, which the company/submission prefix lookup matches. */
const quarantineNameOf = (temp: string) => {
  const m = /^\.(.+)\.jsonl\.([^.]+)\.tmp$/.exec(temp);
  return m ? `${m[1]}.${m[2]}.stale${SUFFIX}` : `stale-${temp.replace(/^\./, '')}${SUFFIX}`;
};
/** Unreadable entries already reported by this process: each is log.error'd once, not on every submit's replay. */
const reportedUnreadable = new Set<string>();
function reportUnreadable(file: string, message: string): void {
  if (reportedUnreadable.has(file)) return;
  reportedUnreadable.add(file);
  log.error(message, { file }, 'netcash');
}
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Flush a directory's entries (a new or renamed file) to disk; a filesystem that cannot is warned about, not fatal. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    log.warn('netcash answer spool: directory fsync failed', { dir, error: errText(err) }, 'netcash');
  }
}

/** The directory, 0700: made so, and an existing wider one narrowed (the entries hold payment answers). */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const { mode } = await fs.stat(dir);
  if ((mode & 0o077) === 0) return;
  try {
    await fs.chmod(dir, 0o700);
  } catch (err) {
    log.warn('netcash answer spool: directory is group/world accessible and could not be narrowed to 0700', { dir, mode: (mode & 0o777).toString(8), error: errText(err) }, 'netcash');
  }
}

async function appendDurably(rec: AnswerRecord): Promise<void> {
  const dir = spoolDir();
  await ensureDir(dir);
  const line = `${JSON.stringify({ v: 1, ...rec, spooledAt: new Date().toISOString() } satisfies SpooledLine)}\n`;
  const final = path.join(dir, fileName(rec));
  const temp = path.join(dir, `.${fileName(rec)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, final); // complete or absent
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
      answer: rec.metadata.answer, error: errText(err),
    }, 'netcash');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let probed = false;
/**
 * Once per process, on the first submit: is the spool directory writable? The service unit may leave it read-only
 * (ProtectSystem=strict), and without this nobody learns that until the outage the spool was for. log.error once; never throws.
 */
export async function probeSpoolWritable(): Promise<boolean> {
  if (probed) return true;
  probed = true;
  const dir = spoolDir();
  const probe = path.join(dir, `.probe-${process.pid}-${randomUUID()}.tmp`);
  try {
    await ensureDir(dir);
    await (await fs.open(probe, 'wx', 0o600)).close();
    await fs.unlink(probe);
    return true;
  } catch (err) {
    log.error('netcash answer spool directory is NOT writable - an accepted answer the database cannot record would be lost on restart; fix the service unit (ReadWritePaths / StateDirectory) or NETCASH_ANSWER_SPOOL_DIR', {
      dir, error: errText(err),
    }, 'netcash');
    return false;
  }
}

/** Names in `dir` for `keep`; none when it does not exist. Throws on any other failure. */
async function namesIn(dir: string, keep: (n: string) => boolean): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter(keep);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}
const entryNames = (dir: string) => namesIn(dir, isEntry);

/** The entry in `file`; 'gone' when it was moved meanwhile (a peer replayed it); null when it cannot be read. */
async function readEntry(file: string): Promise<SpooledLine | 'gone' | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? 'gone' : null;
  }
  try {
    const v = JSON.parse(text) as Partial<SpooledLine> | null;
    return v && v.v === 1 && typeof v.companyId === 'string' && typeof v.submissionId === 'string' && v.metadata && typeof v.metadata.settleToken === 'string'
      ? v as SpooledLine : null;
  } catch {
    return null;
  }
}

/**
 * A spooled ACCEPTANCE for this submission in this company that is not in audit_log yet (pending or quarantined); null
 * if none. resolve calls it for a pending row it is asked to free. Only an acceptance blocks - a spooled `unknown` or
 * rejected answer does not, exactly as audit_log's record. Company and submission come from the file NAME (ours): an
 * entry - or a temp (in flight, or left by a write that never reached its rename, in the directory or swept to
 * quarantine/) - that cannot be read still counts: fail closed, log.error once. A directory that cannot be listed
 * throws (the resolve fails, never frees on a guess).
 */
export async function spooledAcceptedAnswer(companyId: string, submissionId: string): Promise<{ outcome: string; batchReference: string } | null> {
  const prefix = `${companyId.toLowerCase()}.${submissionId.toLowerCase()}.`;
  const mine = (n: string) => (isEntry(n) && n.startsWith(prefix)) || (isTemp(n) && n.startsWith(`.${prefix}`));
  for (const dir of [spoolDir(), quarantineDir()]) {
    // A temp renamed to its final name between the listing and the read is 'gone' - list again, or the final name is missed.
    for (let pass = 0, again = true; again && pass < 3; pass += 1) {
      again = false;
      for (const name of await namesIn(dir, mine)) {
        const entry = await readEntry(path.join(dir, name));
        if (entry === 'gone') { again = true; continue; }
        if (!entry) {
          reportUnreadable(path.join(dir, name), 'netcash answer spool: an entry (or unfinished temp) for this submission cannot be read - treated as an acceptance');
          return { outcome: 'accepted (spool entry unreadable)', batchReference: '' };
        }
        if (entry.companyId.toLowerCase() === companyId.toLowerCase() && entry.metadata.status === 'submitted') {
          return { outcome: entry.metadata.outcome || 'accepted', batchReference: entry.metadata.batchReference ?? '' };
        }
      }
    }
  }
  return null;
}

/** Entries not yet replayed, oldest name first (an unreadable one is logged and left where it is). */
export async function pendingSpooled(): Promise<{ file: string; entry: AnswerRecord }[]> {
  const out: { file: string; entry: AnswerRecord }[] = [];
  for (const name of (await entryNames(spoolDir())).sort()) {
    const file = path.join(spoolDir(), name);
    const entry = await readEntry(file);
    if (entry === 'gone') continue;
    if (entry) out.push({ file, entry });
    else reportUnreadable(file, 'netcash answer spool: an entry cannot be read - left in place, still blocks its submission');
  }
  return out;
}

/** Move an entry into `to` (replayed/ or quarantine/): never deleted. An entry a peer already moved is not an error. */
async function moveEntry(file: string, to: string, as = path.basename(file)): Promise<void> {
  await ensureDir(to);
  try {
    await fs.rename(file, path.join(to, as));
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
    return;
  }
  await syncDir(path.dirname(file));
  await syncDir(to);
}
export const markReplayed = (file: string) => moveEntry(file, replayedDir());
export const quarantineEntry = (file: string) => moveEntry(file, quarantineDir());

/**
 * Temp files left by writes that never finished go to quarantine/ under a final-style name (kept, never deleted, and
 * still found by the lookup - an acceptance whose write never reached its rename must not stop blocking after a minute);
 * a fresh one is a write in flight.
 */
export async function sweepStaleTemps(): Promise<void> {
  try {
    for (const name of (await fs.readdir(spoolDir())).filter(isTemp)) {
      const file = path.join(spoolDir(), name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') continue; // finished (renamed) meanwhile
        throw err;
      }
      if (Date.now() - mtimeMs > STALE_TEMP_MS) {
        log.warn('netcash answer spool: an unfinished temp file moved to quarantine (it still blocks its submission)', { file }, 'netcash');
        await moveEntry(file, quarantineDir(), quarantineNameOf(name));
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') log.warn('netcash answer spool: temp sweep failed', { error: errText(err) }, 'netcash');
  }
}
