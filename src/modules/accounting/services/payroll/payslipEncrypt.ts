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
 * `finally`, whatever happens. The isaflow@ units run ProtectSystem=strict, which leaves /dev writable (proved in the
 * PR under the unit's own options). No tmpfs, no qpdf, a qpdf failure or an output that is not a PDF:
 * PayslipEncryptionFailed, and the send refuses before anything is sent (payslipDeliveryService).
 */
import { spawn as nodeSpawn } from 'child_process';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import path from 'path';
import { log } from '@/lib/logger';

export const PAYSLIP_TMP_ROOT = '/dev/shm';
const QPDF_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export class PayslipEncryptionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayslipEncryptionFailed';
  }
}

export interface EncryptDeps { spawn?: typeof nodeSpawn; tmpRoot?: string }

/** What qpdf reads from stdin: AES-256, the password as user and owner password, print only. */
export function qpdfArguments(password: string, inPath: string): string[] {
  return ['--encrypt', `--user-password=${password}`, `--owner-password=${password}`, '--bits=256',
    '--print=full', '--modify=none', '--extract=n', '--', inPath, '-'];
}

/** The PDF, encrypted. Throws PayslipEncryptionFailed when it cannot be (never returns the plaintext). */
export async function encryptPayslipPdf(plaintext: Buffer, password: string, deps: EncryptDeps = {}): Promise<Buffer> {
  if (password === '' || /[\r\n\0]/.test(password)) throw new Error('A payslip password must be one line of text');
  let dir: string | null = null;
  try {
    try {
      dir = await mkdtemp(path.join(deps.tmpRoot ?? PAYSLIP_TMP_ROOT, 'isaflow-payslip-'));
    } catch (err) {
      throw new PayslipEncryptionFailed(`No private memory directory for the payslip render (${errCode(err)})`);
    }
    await chmod(dir, 0o700);
    const inPath = path.join(dir, 'in.pdf');
    await writeFile(inPath, plaintext, { mode: 0o600, flag: 'wx' });
    const out = await runQpdf(deps.spawn ?? nodeSpawn, qpdfArguments(password, inPath), password);
    if (out.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PayslipEncryptionFailed('qpdf did not write a PDF');
    return out;
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
  }
}

const errCode = (err: unknown): string => String((err as { code?: unknown } | null)?.code ?? (err instanceof Error ? err.message : err));

function runQpdf(spawn: typeof nodeSpawn, args: string[], password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, out?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out!);
    };
    const child = spawn('qpdf', ['@-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new PayslipEncryptionFailed(`qpdf did not finish within ${QPDF_TIMEOUT_MS} ms`));
    }, QPDF_TIMEOUT_MS);
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
