/**
 * Reading, moving and sweeping the Netcash answer spool (netcashAnswerSpool.ts has the write side and the rules): the
 * resolve lookup, the replay's listing, and the moves into replayed/ and quarantine/. Lines are never deleted.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { log } from '@/lib/logger';
import {
  ensureDir, errText, isEntry, isTemp, nameStatus, promotionOf, quarantineDir, quarantineNameOf, replayedDir, spoolDir, STALE_TEMP_MS, syncDir,
  type AnswerRecord, type SpooledLine,
} from './netcashAnswerSpoolFiles';

/** Unreadable entries already reported by this process: each is log.error'd once, not on every submit's replay. */
const reportedUnreadable = new Set<string>();
function reportUnreadable(file: string, message: string): void {
  if (reportedUnreadable.has(file)) return;
  reportedUnreadable.add(file);
  log.error(message, { file }, 'netcash');
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

/** What the resolve lookup found: Netcash's outcome and reference, and the file when it is not a plain pending entry. */
export interface SpooledAcceptance { outcome: string; batchReference: string; file?: string }

/**
 * A spooled ACCEPTANCE for this submission in this company that is not in audit_log yet (pending or quarantined); null
 * if none. resolve calls it for a pending row it is asked to free. Only an acceptance blocks - a spooled `unknown` or
 * rejected answer does not, exactly as audit_log's record. Company and submission come from the file NAME (ours), and so
 * does the answer's status: an entry - or a temp (in flight, or left by a write that never reached its rename, in the
 * directory or swept to quarantine/) - that cannot be read blocks unless its name says failed / unknown; with
 * `submitted`, or no status at all, it counts as an acceptance (fail closed, log.error once, and `file` names it for the
 * operator). A quarantined readable acceptance names its file too. A directory that cannot be listed throws (the
 * resolve fails, never frees on a guess).
 */
export async function spooledAcceptedAnswer(companyId: string, submissionId: string): Promise<SpooledAcceptance | null> {
  const prefix = `${companyId.toLowerCase()}.${submissionId.toLowerCase()}.`;
  const mine = (n: string) => (isEntry(n) && n.startsWith(prefix)) || (isTemp(n) && n.startsWith(`.${prefix}`));
  for (const dir of [spoolDir(), quarantineDir()]) {
    // A temp renamed to its final name between the listing and the read is 'gone' - list again, or the final name is missed.
    for (let pass = 0, again = true; again && pass < 3; pass += 1) {
      again = false;
      for (const name of await namesIn(dir, mine)) {
        const entry = await readEntry(path.join(dir, name));
        if (entry === 'gone') { again = true; continue; }
        // A file whose NAME says it is this company's and submission's but whose CONTENT says otherwise is as unreadable
        // as a torn one (a hostile or corrupt file): never trusted to say "not an acceptance".
        const contradicts = entry && (entry.companyId.toLowerCase() !== companyId.toLowerCase() || entry.submissionId.toLowerCase() !== submissionId.toLowerCase());
        if (!entry || contradicts) {
          const said = nameStatus(name);
          if (said === 'failed' || said === 'unknown') continue; // its name says it was never an acceptance
          reportUnreadable(path.join(dir, name), 'netcash answer spool: an entry (or unfinished temp) for this submission cannot be read - treated as an acceptance');
          return { outcome: 'accepted (spool entry unreadable)', batchReference: '', file: name };
        }
        if (entry.metadata.status === 'submitted') {
          return { outcome: entry.metadata.outcome || 'accepted', batchReference: entry.metadata.batchReference ?? '', ...(dir === spoolDir() && !isTemp(name) ? {} : { file: name }) };
        }
      }
    }
  }
  return null;
}

/**
 * Entries not yet replayed, oldest name first, read lazily: at most `max` entries are read and none after `deadline` (ms
 * since the epoch) - the replay's own bounds apply to the reads too, so a big spool costs one directory listing plus
 * what the call will use. An unreadable one is reported once and left where it is (it still blocks its submission).
 */
export async function pendingSpooled(opts: { max?: number; deadline?: number } = {}): Promise<{ file: string; entry: AnswerRecord }[]> {
  const out: { file: string; entry: AnswerRecord }[] = [];
  for (const name of (await entryNames(spoolDir())).sort()) {
    if (out.length >= (opts.max ?? Infinity) || Date.now() >= (opts.deadline ?? Infinity)) break;
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
 * Temp files left by writes that never finished (older than STALE_TEMP_MS; a fresh one is a write in flight). A COMPLETE
 * one - a crash after the fsync, before the rename - is promoted to its final name, so it is replayed like any entry
 * (then moved to replayed/) and blocks resolve meanwhile; one that does not parse goes to quarantine/ under a
 * final-style name (kept, never deleted) where the lookup still finds it and keeps blocking: an acceptance whose write
 * never finished must not stop blocking after a minute.
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
      if (Date.now() - mtimeMs <= STALE_TEMP_MS) continue;
      const entry = await readEntry(file);
      if (entry === 'gone') continue;
      // The final name comes from the temp's own NAME (validated: UUIDs, a plain token, a known status), never from its
      // content; a content that disagrees with the name, or a name that is not ours, is quarantined under a safe name.
      const named = promotionOf(name);
      if (entry && named && entry.companyId.toLowerCase() === named.companyId && entry.submissionId.toLowerCase() === named.submissionId) {
        log.warn('netcash answer spool: a complete but unrenamed temp promoted to an entry (it will be replayed)', { file }, 'netcash');
        await moveEntry(file, spoolDir(), named.finalName);
      } else {
        log.warn('netcash answer spool: an unreadable, foreign or mismatched unfinished temp moved to quarantine (it still blocks its submission)', { file }, 'netcash');
        await moveEntry(file, quarantineDir(), quarantineNameOf(name));
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') log.warn('netcash answer spool: temp sweep failed', { error: errText(err) }, 'netcash');
  }
}
