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
 * so a crash mid-write leaves at most a stray temp, never a torn entry. A temp is not replayed while fresh, but it is NOT
 * ignored by the lookup (fail closed): one carrying the company and submission blocks like an entry would - judged by
 * its content when it parses, blocking when it does not. One older than STALE_TEMP_MS is swept: a COMPLETE one (crash
 * after the fsync, before the rename) is promoted to its final name and replayed like any entry; an unparseable one
 * moves to quarantine/ under a final-style name (`<company>.<submission>.<token>.<rand>.stale.jsonl`) and keeps
 * blocking. "Replayed" is a move to `replayed/`, and an entry the database keeps refusing for its own content moves to
 * `quarantine/` - lines are never deleted or rewritten; a quarantined acceptance still blocks resolve. Written through
 * fs.promises with a timeout (ANSWER_SPOOL_TIMEOUT_MS) rather than the sync calls, so a stalled disk cannot freeze the
 * event loop or hold the 500; a write that outlives the timeout may still complete, which only adds evidence. Never
 * throws into the request: a failure is log.error'd with the answer.
 *
 * Split: this file writes (and probes); netcashAnswerSpoolRead reads, moves and sweeps; netcashAnswerSpoolFiles holds the
 * layout and naming; netcashAnswerSpoolReplay moves entries into audit_log.
 *
 * Location: NETCASH_ANSWER_SPOOL_DIR, else `<STATE_DIRECTORY>/netcash-spool` (systemd StateDirectory=), else
 * ~/.isaflow/netcash-spool - never under the deploy directory (deploy.sh rsyncs --delete over /home/velo/isaflow). The
 * service unit runs ProtectSystem=strict with ReadWritePaths=/home/velo/isaflow /tmp: the default home path is read-only
 * to it until the unit also lists it (an ops step) or sets StateDirectory= / NETCASH_ANSWER_SPOOL_DIR. A test run
 * defaults to a per-process directory under the OS temp dir, so no test writes into a home directory.
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { log } from '@/lib/logger';
import { ANSWER_SPOOL_TIMEOUT_MS } from './netcashTimeouts';
import {
  ensureDir, errText, fileName, spoolDir, syncDir, UUID, type AnswerRecord, type SpooledLine,
} from './netcashAnswerSpoolFiles';

export { spoolDir, type AnswerRecord };
export {
  markReplayed, pendingSpooled, quarantineEntry, spooledAcceptedAnswer, sweepStaleTemps,
} from './netcashAnswerSpoolRead';

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

