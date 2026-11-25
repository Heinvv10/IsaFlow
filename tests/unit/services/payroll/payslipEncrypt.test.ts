/**
 * Wave 7 PX (W15; rulings 2, 17; grill F7): the emailed payslip is AES-256 (qpdf, R 6), not jsPDF's RC4-40.
 *  - the output opens with the password and with nothing else, and its encryption dictionary is V 5 / R 6 / AESV3;
 *  - qpdf is spawned with ONE argument, `@-`; the password reaches it on stdin only (never argv, /proc/<pid>/cmdline);
 *  - the plaintext lives in a 0700 directory under the tmpfs root, as a 0600 file, and is gone after a success, a
 *    qpdf failure and a missing qpdf; a missing tmpfs or qpdf is PayslipEncryptionFailed (the send refuses, sends nothing).
 * Needs /usr/bin/qpdf (velo and both hosted CI apt steps install it).
 */
import { spawn as realSpawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { encryptPayslipPdf, PayslipEncryptionFailed, qpdfArguments } from '@/modules/accounting/services/payroll/payslipEncrypt';

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
    expect(calls[0]!.command).toBe('qpdf');
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

  it('no tmpfs: PayslipEncryptionFailed, qpdf never started', async () => {
    const { spawn, calls } = spySpawn();
    await expect(encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: '/dev/shm/px-no-such-dir', spawn })).rejects.toBeInstanceOf(PayslipEncryptionFailed);
    expect(calls).toEqual([]);
  });

  it('a password that is not one line is refused before anything is written', async () => {
    const { spawn, calls } = spySpawn();
    await expect(encryptPayslipPdf(plaintext, 'a\nb', { tmpRoot: root, spawn })).rejects.toThrow(/one line/);
    await expect(encryptPayslipPdf(plaintext, '', { tmpRoot: root, spawn })).rejects.toThrow(/one line/);
    expect(calls).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('two encryptions of the same plaintext differ (random salt): pdf_sha256 is per send, plaintext_sha256 is not', async () => {
    const a = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    const b = await encryptPayslipPdf(plaintext, ID_NUMBER, { tmpRoot: root });
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});
