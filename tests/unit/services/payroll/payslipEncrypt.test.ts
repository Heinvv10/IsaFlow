/**
 * Wave 7 PX (W15; rulings 2, 17; grill F7): the emailed payslip is AES-256 (qpdf, R 6), not jsPDF's RC4-40.
 *  - the output opens with the password and with nothing else, and its encryption dictionary is V 5 / R 6 / AESV3;
 *  - qpdf is spawned with ONE argument, `@-`; the password reaches it on stdin only (never argv, /proc/<pid>/cmdline);
 *  - the plaintext lives in a 0700 directory under the tmpfs root, as a 0600 file, and is gone after a success, a
 *    qpdf failure and a missing qpdf; a missing tmpfs or qpdf is PayslipEncryptionFailed (the send refuses, sends nothing).
 * Needs /usr/bin/qpdf (velo and both hosted CI apt steps install it).
 */
import { spawn as realSpawn, type ChildProcess } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  encryptPayslipPdf, isAes256Pdf, PayslipEncryptionFailed, qpdfArguments, STALE_AFTER_MS, sweepStalePayslipDirs,
} from '@/modules/accounting/services/payroll/payslipEncrypt';

const ID_NUMBER = '8001015009087';
let root = '';
let plaintext: Buffer;

type Parser = new (o: { data: Buffer; password?: string }) => { getText(): Promise<{ text: string }> };
async function text(pdf: Buffer, password?: string): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: Parser };
  return (await new PDFParse({ data: Buffer.from(pdf), ...(password === undefined ? {} : { password }) }).getText()).text;
}

beforeAll(async () => {
  root = mkdtempSync('/dev/shm/px-encrypt-test-');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  doc.text('Payslip for Zanele Slip', 10, 10);
  plaintext = Buffer.from(doc.output('arraybuffer'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A spawn that records each call and, at spawn time, what the tmpfs root holds. */
function spySpawn(command = 'qpdf') {
  const calls: Array<{ command: string; args: readonly string[]; dirs: Array<{ mode: number; files: Array<{ name: string; mode: number }> }> }> = [];
  const spawn = ((cmd: string, args: readonly string[], opts: object): ChildProcess => {
    const dirs = readdirSync(root).map((d) => {
      const dir = path.join(root, d);
      return { mode: statSync(dir).mode & 0o777, files: readdirSync(dir).map((f) => ({ name: f, mode: statSync(path.join(dir, f)).mode & 0o777 })) };
    });
    calls.push({ command: cmd, args, dirs });
    return realSpawn(command, args as string[], opts);
  }) as unknown as typeof realSpawn;
  return { spawn, calls };
}

describe('encryptPayslipPdf', () => {
  it('AES-256 (V 5, R 6, AESV3): opens with the password only', async () => {
    const pdf = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    const bytes = pdf.toString('latin1');
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes).toMatch(/\/V 5\b/);
    expect(bytes).toMatch(/\/R 6\b/);
    expect(bytes).toMatch(/\/AESV3\b/);
    expect(bytes).not.toContain('Zanele');
    await expect(text(pdf)).rejects.toThrow(/password/i);
    await expect(text(pdf, '8001015009088')).rejects.toThrow(/password/i);
    expect(await text(pdf, ID_NUMBER)).toContain('Payslip for Zanele Slip');
  });

  it('the password is never on argv: qpdf gets `@-` alone, the arguments on stdin', async () => {
    const { spawn, calls } = spySpawn();
    await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/bin/qpdf'); // absolute: never resolved through PATH
    expect(calls[0]!.args).toEqual(['@-']);
    expect(calls[0]!.args.some((a) => a.includes(ID_NUMBER))).toBe(false);
    // What goes on stdin names the password (twice) and 256 bits.
    const stdinArgs = qpdfArguments(ID_NUMBER, '/dev/shm/x/in.pdf');
    expect(stdinArgs.filter((a) => a.includes(ID_NUMBER))).toHaveLength(2);
    expect(stdinArgs).toContain('--bits=256');
  });

  it('the plaintext is a 0600 file in a 0700 directory under the tmpfs root while qpdf runs, and gone after', async () => {
    const { spawn, calls } = spySpawn();
    await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn });
    expect(calls[0]!.dirs).toEqual([{ mode: 0o700, files: [{ name: 'in.pdf', mode: 0o600 }] }]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a qpdf failure is PayslipEncryptionFailed, and the plaintext is removed', async () => {
    const { spawn } = spySpawn();
    await expect(encryptPayslipPdf(Buffer.from('not a pdf'), ID_NUMBER, { tmpRoot: root, spawn })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    expect(readdirSync(root)).toEqual([]);
  });

  it('no qpdf on the host: PayslipEncryptionFailed, nothing left behind', async () => {
    const { spawn } = spySpawn('qpdf-not-installed-px');
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    expect(readdirSync(root)).toEqual([]);
  });

  it('PAYSLIP_QPDF_PATH pointing nowhere: PayslipEncryptionFailed, nothing left behind', async () => {
    process.env.PAYSLIP_QPDF_PATH = '/nonexistent-px/qpdf';
    try {
      await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root })).rejects.toThrow(/not installed/);
    } finally {
      delete process.env.PAYSLIP_QPDF_PATH;
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('no tmpfs: PayslipEncryptionFailed, qpdf never started', async () => {
    const { spawn, calls } = spySpawn();
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: '/dev/shm/px-no-such-dir', spawn })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    expect(calls).toEqual([]);
  });

  it('a password that is not one line is refused before anything is written', async () => {
    const { spawn, calls } = spySpawn();
    for (const bad of ['a\nb', 'a\rb', 'a\0b', '']) {
      await expect(encryptPayslipPdf(plaintext, bad, { tmpRoot: root, spawn })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    }
    expect(calls).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('two encryptions of the same plaintext differ (random salt): pdf_sha256 is per send, plaintext_sha256 is not', async () => {
    const a = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    const b = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('S2 (#1904 breaker): an UNENCRYPTED PDF whose text carries the markers is refused, structurally and by qpdf', async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    doc.text('Employee: /Encrypt 9 0 R /V 5 /R 6 /AESV3 /Filter /Standard salary R 45 000.00', 10, 10);
    const spoof = Buffer.from(doc.output('arraybuffer'));
    expect(isAes256Pdf(spoof)).toBe(false);
    // A "qpdf" that just copies its input file (stdin line 9 is the input path) back out.
    const copying = ((_c: string, _a: readonly string[], opts: object) =>
      realSpawn('/bin/bash', ['-c', 'f=$(sed -n 9p); cat "$f"'], opts)) as unknown as typeof realSpawn;
    await expect(encryptPayslipPdf(spoof, ID_NUMBER, { tmpRoot: root, spawn: copying })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    expect(readdirSync(root)).toEqual([]);
  });

  it('S2: even a file that passes the structural check is refused unless qpdf says it needs a password', async () => {
    // A real AES-256 file, but encrypted with an EMPTY user password: structurally R 6 / AESV3, opens without one.
    const realAes = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    expect(isAes256Pdf(realAes)).toBe(true);
    const emptyUser = ((_c: string, args: readonly string[], opts: object) => {
      const child = realSpawn('/usr/bin/qpdf', args as string[], opts);
      const write = child.stdin!.end.bind(child.stdin!);
      // Rewrite the argument list on its way in: user password empty, owner password kept.
      (child.stdin as unknown as { end: (s: string) => void }).end = (stdin: string) =>
        write(stdin.replace(/--user-password=[^\n]*/, '--user-password='));
      return child;
    }) as unknown as typeof realSpawn;
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn: emptyUser })).rejects.toThrow(/needs a password/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('an output that is not AES-256 (R 6, AESV3) is refused, never returned', async () => {
    // A "qpdf" that writes a plain, unencrypted PDF and exits 0.
    const spawn = ((_c: string, _a: readonly string[], opts: object) =>
      realSpawn('/bin/sh', ['-c', 'cat >/dev/null; printf "%%PDF-1.4 plain"'], opts)) as unknown as typeof realSpawn;
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn })).rejects.toThrow(/AES-256/);
    expect(isAes256Pdf(plaintext)).toBe(false);
    expect(isAes256Pdf(await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root }))).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('sweepStalePayslipDirs (a render killed mid-way cannot run finally)', () => {
  it('removes only our directories older than a minute; fresh ones, other names and symlinks stay', async () => {
    const sweepRoot = mkdtempSync('/dev/shm/px-sweep-test-');
    try {
      const old = (Date.now() - STALE_AFTER_MS - 5_000) / 1000;
      mkdirSync(path.join(sweepRoot, 'isaflow-payslip-stale'), { mode: 0o700 });
      writeFileSync(path.join(sweepRoot, 'isaflow-payslip-stale', 'in.pdf'), 'plaintext');
      utimesSync(path.join(sweepRoot, 'isaflow-payslip-stale'), old, old);
      mkdirSync(path.join(sweepRoot, 'isaflow-payslip-fresh'), { mode: 0o700 });
      mkdirSync(path.join(sweepRoot, 'someone-else'));
      utimesSync(path.join(sweepRoot, 'someone-else'), old, old);
      const target = mkdtempSync('/dev/shm/px-sweep-target-');
      symlinkSync(target, path.join(sweepRoot, 'isaflow-payslip-link'));
      // S1 (#1904 breaker): a stale dir that group or others can write into is not ours as mkdtemp makes it: left alone.
      for (const mode of [0o770, 0o707, 0o755]) {
        const d = path.join(sweepRoot, `isaflow-payslip-open-${mode.toString(8)}`);
        mkdirSync(d);
        chmodSync(d, mode);
        utimesSync(d, old, old);
      }
      expect(await sweepStalePayslipDirs(sweepRoot)).toBe(1);
      expect(readdirSync(sweepRoot).sort()).toEqual([
        'isaflow-payslip-fresh', 'isaflow-payslip-link', 'isaflow-payslip-open-707', 'isaflow-payslip-open-755', 'isaflow-payslip-open-770',
        'someone-else']);
      expect(statSync(target).isDirectory()).toBe(true);
      rmSync(target, { recursive: true, force: true });
    } finally {
      rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  it('every render sweeps first: a crashed render\'s plaintext is gone after the next one', async () => {
    const old = (Date.now() - STALE_AFTER_MS - 5_000) / 1000;
    mkdirSync(path.join(root, 'isaflow-payslip-crashed'), { mode: 0o700 });
    writeFileSync(path.join(root, 'isaflow-payslip-crashed', 'in.pdf'), 'salary R 45 000.00');
    utimesSync(path.join(root, 'isaflow-payslip-crashed'), old, old);
    await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    expect(readdirSync(root)).toEqual([]);
  });
});

/** Ported from the #1904 breaker's repros (px-breaker.test.ts). */
describe('breaker repros', () => {
  it('the real qpdf child: neither /proc/<pid>/cmdline nor /proc/<pid>/environ holds the password', async () => {
    const seen: Array<{ cmdline: string; environ: string }> = [];
    const spawn = ((cmd: string, args: readonly string[], opts: object): ChildProcess => {
      const child = realSpawn(cmd, args as string[], opts);
      for (let i = 0; i < 20000 && seen.length === 0; i += 1) {
        try {
          const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, 'latin1');
          if (cmdline.includes('qpdf')) seen.push({ cmdline, environ: readFileSync(`/proc/${child.pid}/environ`, 'latin1') });
        } catch { /* the child is not exec'd yet: try again */ }
      }
      return child;
    }) as unknown as typeof realSpawn;
    await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmdline.split('\0').filter(Boolean)).toEqual(['/usr/bin/qpdf', '@-']);
    expect(seen[0]!.environ).not.toContain(ID_NUMBER);
  });

  it('a qpdf failure: neither the error nor the logs carry the password', async () => {
    const { log } = await import('@/lib/logger');
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
    const err = await encryptPayslipPdf(Buffer.from(`not a pdf ${ID_NUMBER}`), ID_NUMBER, { tmpRoot: root }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayslipEncryptionFailed);
    const all = JSON.stringify([vi.mocked(log.error).mock.calls, vi.mocked(log.warn).mock.calls]) + String((err as Error).message) + String((err as Error).stack);
    expect(all).not.toContain(ID_NUMBER);
  });

  it('a qpdf that hangs is killed at the timeout, and the plaintext is removed', async () => {
    const spawn = ((_c: string, _a: readonly string[], opts: object) => realSpawn('sleep', ['60'], opts)) as unknown as typeof realSpawn;
    const t0 = Date.now();
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root, spawn, timeoutMs: 500 })).rejects.toThrow(/did not finish/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(readdirSync(root)).toEqual([]);
  });

  it('40 at once: no collision, each opens with its own password, nothing left', async () => {
    const outs = await Promise.all(Array.from({ length: 40 }, (_, i) => encryptPayslipPdf(plaintext, `${ID_NUMBER}${i}`, { tmpRoot: root })));
    for (const [i, out] of outs.entries()) expect(await text(out, `${ID_NUMBER}${i}`)).toContain('Payslip for Zanele Slip');
    expect(readdirSync(root)).toEqual([]);
  }, 60_000);
});
