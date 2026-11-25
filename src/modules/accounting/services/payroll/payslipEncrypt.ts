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
 * checked to be AES-256 (/Encrypt, V 5, R 6, AESV3) before it is returned. Every failure (no tmpfs, a file error, no
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

/** AES-256 as written by qpdf: an /Encrypt dictionary with V 5, R 6 and the AESV3 crypt filter. */
export function isAes256Pdf(pdf: Buffer): boolean {
  const text = pdf.toString('latin1');
  return text.startsWith('%PDF-') && /\/Encrypt\s+\d+\s+\d+\s+R/.test(text)
    && /\/V\s+5\b/.test(text) && /\/R\s+6\b/.test(text) && /\/AESV3\b/.test(text);
}

/**
 * Removes this module's plaintext directories older than STALE_AFTER_MS under `root`: what a process killed
 * mid-render (SIGKILL, OOM, a deploy stopping the colour) left behind. Only our own prefix, only directories, never
 * through a symlink. Runs before every render, so a crash's plaintext lives at most until the next payslip email.
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
      if (!st.isDirectory() || now - st.mtimeMs < STALE_AFTER_MS) continue;
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
