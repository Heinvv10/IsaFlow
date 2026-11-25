/**
 * AES-256 for the emailed payslip (wave 7 PX, W15; Hein's rulings 2 and 17; grill F7).
 *
 * jsPDF can only encrypt with RC4 and a 40-bit key, which can be searched whatever the password is. The emailed slip
 * is rendered without a password and then encrypted by qpdf (`--encrypt … --bits=256`: the PDF 2.0 handler, V 5,
 * R 6, AES-256 with the AESV3 crypt filter). The password is the employee's ID number, else passport number
 * (payslipEmailPdf.payslipPassword), as user and owner password; printing allowed, changing and extracting not.
 *
 * NO PASSWORD ON ARGV (F7): qpdf is spawned with the single argument `@-` ("@- may be used to read arguments from
 * stdin", qpdf 11.9.0) and the argument list is written to its stdin, one argument per line, so the password never
 * appears in `ps` or /proc/<pid>/cmdline. A password containing a line break could split into two arguments: it is
 * refused (payslipPassword strips whitespace, so none reaches here).
 *
 * PLAINTEXT ON DISK, NAMED EXCEPTION (ruling 17): qpdf needs a seekable input file, so the unencrypted render is
 * written to a 0600 file in a fresh 0700 directory under /dev/shm (tmpfs: memory, never a disk block) and removed in
 * `finally`, whatever happens. A process killed mid-render (SIGKILL, OOM) cannot run `finally`: every render first
 * sweeps this module's directories older than a minute (sweepStalePayslipDirs). The isaflow@ units run
 * ProtectSystem=strict, which leaves /dev writable (proved in the PR under the unit's own options). (memfd_create is
 * not reachable from Node without a native module, so a tmpfs file it is.)
 *
 * qpdf is spawned by absolute path (/usr/bin/qpdf; PAYSLIP_QPDF_PATH overrides), never through PATH. Its output is
 * checked to be AES-256 from its structure (the trailer's /Encrypt object: V 5, R 6, AESV3) and by
 * `qpdf --requires-password` before it is returned. Every failure (no tmpfs, a file error, no
 * qpdf, a qpdf failure or timeout, an output that is not AES-256, a password that is not one line) is
 * PayslipEncryptionFailed: the send refuses 503 before anything is sent (payslipDeliveryService), never a 500.
 */
import { spawn as nodeSpawn } from 'child_process';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { log } from '@/lib/logger';

export const PAYSLIP_TMP_ROOT = '/dev/shm';
/** Absolute, so a PATH entry can never stand in for qpdf (PAYSLIP_QPDF_PATH overrides it, read at each call). */
export const QPDF_DEFAULT_PATH = '/usr/bin/qpdf';
const TMP_PREFIX = 'isaflow-payslip-';
const QPDF_TIMEOUT_MS = 10_000;
/** A plaintext directory older than this is a crashed render's (a render's qpdf is killed at 10 s): swept. */
export const STALE_AFTER_MS = 60_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export class PayslipEncryptionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayslipEncryptionFailed';
  }
}

export interface EncryptDeps { spawn?: typeof nodeSpawn; tmpRoot?: string; timeoutMs?: number; now?: () => number }

/** What qpdf reads from stdin: AES-256, the password as user and owner password, print only. */
export function qpdfArguments(password: string, inPath: string): string[] {
  return ['--encrypt', `--user-password=${password}`, `--owner-password=${password}`, '--bits=256',
    '--print=full', '--modify=none', '--extract=n', '--', inPath, '-'];
}

/** The dictionary that starts at the first `<<` at or after `from` (nested dictionaries counted); null if none. */
function dictAt(text: string, from: number): string | null {
  const start = text.indexOf('<<', from);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < text.length - 1; j += 1) {
    if (text.startsWith('<<', j)) { depth += 1; j += 1; } else if (text.startsWith('>>', j)) {
      depth -= 1;
      j += 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

/**
 * AES-256 as written by qpdf, judged from the file's STRUCTURE, never from text anywhere in it (#1904 breaker S2: a
 * payslip line reading "/Encrypt 9 0 R /V 5 /R 6 /AESV3" must not pass): the last `startxref` points at an xref
 * table whose trailer, or at an xref stream whose dictionary, names /Encrypt n g R; that object's dictionary is the
 * Standard handler with V 5, R 6 and the AESV3 crypt filter.
 */
export function isAes256Pdf(pdf: Buffer): boolean {
  const text = pdf.toString('latin1');
  if (!text.startsWith('%PDF-')) return false;
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text.slice(-1024));
  if (!end) return false;
  const at = Number(end[1]);
  if (!Number.isSafeInteger(at) || at <= 0 || at >= text.length) return false;
  let trailer: string | null = null;
  if (text.startsWith('xref', at)) {
    const t = text.indexOf('trailer', at);
    trailer = t < 0 ? null : dictAt(text, t);
  } else if (/^\d+\s+\d+\s+obj\b/.test(text.slice(at, at + 40))) {
    const d = dictAt(text, at);
    trailer = d && /\/Type\s*\/XRef\b/.test(d) ? d : null;
  }
  const ref = trailer ? /\/Encrypt\s+(\d+)\s+(\d+)\s+R\b/.exec(trailer) : null;
  if (!ref) return false;
  // The object's last definition (an incremental update may redefine it).
  const defs = [...text.matchAll(new RegExp(`(?:^|\\s)${ref[1]}\\s+${ref[2]}\\s+obj\\b`, 'g'))];
  const def = defs.at(-1);
  const enc = def?.index === undefined ? null : dictAt(text, def.index);
  return !!enc && /\/Filter\s*\/Standard\b/.test(enc) && /\/V\s+5\b/.test(enc) && /\/R\s+6\b/.test(enc) && /\/AESV3\b/.test(enc);
}

/**
 * qpdf's own answer on the written output (#1904 breaker S2): `qpdf --requires-password <file>` exits 0 only when the
 * file is encrypted and cannot be opened without a password. No password is on this command line. Real spawn,
 * absolute path, bounded.
 */
function requiresPassword(qpdf: string, file: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = nodeSpawn(qpdf, ['--requires-password', file], { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/**
 * Removes this module's plaintext directories older than STALE_AFTER_MS under `root`: what a process killed
 * mid-render (SIGKILL, OOM, a deploy stopping the colour) left behind. Only our own prefix, only directories owned by
 * this user with no group or other permission bits (as mkdtemp makes them), never through a symlink. Runs before every render, so a crash's plaintext lives at most until the next payslip email.
 */
export async function sweepStalePayslipDirs(root: string = PAYSLIP_TMP_ROOT, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    log.warn('Payslip plaintext sweep could not read the tmpfs root', { root, error: errCode(err) }, 'payslip-encrypt');
    return 0;
  }
  let swept = 0;
  for (const name of names.filter((n) => n.startsWith(TMP_PREFIX))) {
    const dir = path.join(root, name);
    try {
      const st = await lstat(dir);
      // Only a directory this process's user made as mkdtemp makes it (0700): never another user's, never one anyone
      // else can write into (#1904 breaker S1: a planted dir could swap a symlink in under the recursive rm).
      const ours = st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
      if (!st.isDirectory() || !ours || now - st.mtimeMs < STALE_AFTER_MS) continue;
      await rm(dir, { recursive: true, force: true });
      swept += 1;
    } catch (err) {
      log.warn('Payslip plaintext sweep could not remove a stale directory', { dir, error: errCode(err) }, 'payslip-encrypt');
    }
  }
  if (swept > 0) log.warn('Swept stale payslip plaintext directories (a render was interrupted)', { root, swept }, 'payslip-encrypt');
  return swept;
}

/**
 * The PDF, encrypted. Throws PayslipEncryptionFailed whenever it cannot be (the route answers 503, never 500), and
 * never returns the plaintext or anything that is not AES-256.
 */
export async function encryptPayslipPdf(plaintext: Buffer, password: string, deps: EncryptDeps = {}): Promise<Buffer> {
  if (password === '' || /[\r\n\0]/.test(password)) throw new PayslipEncryptionFailed('A payslip password must be one line of text');
  const root = deps.tmpRoot ?? PAYSLIP_TMP_ROOT;
  await sweepStalePayslipDirs(root, (deps.now ?? Date.now)());
  let dir: string | null = null;
  try {
    try {
      dir = await mkdtemp(path.join(root, TMP_PREFIX)); // mode 0700
      await writeFile(path.join(dir, 'in.pdf'), plaintext, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      throw new PayslipEncryptionFailed(`No private memory directory for the payslip render (${errCode(err)})`);
    }
    const qpdf = process.env.PAYSLIP_QPDF_PATH || QPDF_DEFAULT_PATH;
    const out = await runQpdf(deps.spawn ?? nodeSpawn, qpdf, qpdfArguments(password, path.join(dir, 'in.pdf')), password,
      deps.timeoutMs ?? QPDF_TIMEOUT_MS);
    if (!isAes256Pdf(out)) throw new PayslipEncryptionFailed('qpdf did not write an AES-256 (R 6) PDF');
    const outPath = path.join(dir, 'out.pdf');
    try {
      await writeFile(outPath, out, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      throw new PayslipEncryptionFailed(`The encrypted payslip could not be checked (${errCode(err)})`);
    }
    if (!(await requiresPassword(qpdf, outPath, deps.timeoutMs ?? QPDF_TIMEOUT_MS))) {
      throw new PayslipEncryptionFailed('qpdf does not confirm that the payslip needs a password');
    }
    return out;
  } finally {
    if (dir !== null) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        // A plaintext that could not be removed: refuse (the sweep retries it), never send.
        throw new PayslipEncryptionFailed(`The payslip render could not be removed (${errCode(err)})`);
      }
    }
  }
}

const errCode = (err: unknown): string => String((err as { code?: unknown } | null)?.code ?? (err instanceof Error ? err.message : err));

function runQpdf(spawn: typeof nodeSpawn, qpdf: string, args: string[], password: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, out?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out!);
    };
    const child = spawn(qpdf, ['@-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new PayslipEncryptionFailed(`qpdf did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.on('error', (err) => finish(new PayslipEncryptionFailed(
      errCode(err) === 'ENOENT' ? 'qpdf is not installed on this server' : `qpdf could not start (${errCode(err)})`)));
    child.stdout!.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new PayslipEncryptionFailed('qpdf output too large'));
      } else chunks.push(c);
    });
    child.stderr!.on('data', (c: Buffer) => { if (stderr.length < 2000) stderr += c.toString('utf8'); });
    // qpdf may exit before reading stdin (a bad input): the close handler answers, this only stops an EPIPE throw.
    child.stdin!.on('error', (err) => log.warn('qpdf stdin closed early', { error: errCode(err) }, 'payslip-encrypt'));
    child.on('close', (code, signal) => {
      // 3 = "operation succeeded with warnings" (qpdf exit codes); anything else failed.
      const detail = stderr.split(password).join('[password]').slice(0, 500);
      if (code === 0 || code === 3) {
        if (code === 3) log.warn('qpdf encrypted with warnings', { detail }, 'payslip-encrypt');
        finish(null, Buffer.concat(chunks));
      } else {
        log.error('qpdf could not encrypt a payslip', { code, signal, detail }, 'payslip-encrypt');
        finish(new PayslipEncryptionFailed(`qpdf exited ${code ?? signal}`));
      }
    });
    child.stdin!.end(`${args.join('\n')}\n`);
  });
}
