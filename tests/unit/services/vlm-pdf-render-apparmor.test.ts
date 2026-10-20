/**
 * In production gs runs under the AppArmor profile `isaflow-gs`
 * (scripts/apparmor/isaflow-gs): GS_APPARMOR_PROFILE names it and the render
 * runs gs as `aa-exec -p <profile> -- gs`. A profile that is named but cannot
 * be applied fails the render; it never falls back to an unconfined gs.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { renderPdfFirstPage } from '@/modules/accounting/services/bank/vlmPdfRender';

function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 48 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Is the isaflow-gs profile loaded on this box? (gs may run under it; nothing else may.) */
function profileLoaded(): boolean {
  try {
    execFileSync('aa-exec', ['-p', 'isaflow-gs', '--', 'gs', '-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // no aa-exec, no AppArmor, or the profile is not loaded
  }
}

const originalProfile = process.env.GS_APPARMOR_PROFILE;
const originalPath = process.env.PATH;
afterEach(() => {
  if (originalProfile === undefined) delete process.env.GS_APPARMOR_PROFILE;
  else process.env.GS_APPARMOR_PROFILE = originalProfile;
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
});

describe('renderPdfFirstPage under AppArmor', () => {
  it.skipIf(!profileLoaded())('renders the same PNG under the isaflow-gs profile as without it', async () => {
    delete process.env.GS_APPARMOR_PROFILE;
    const unconfined = await renderPdfFirstPage(onePagePdf('TAX INVOICE 115.00'));
    process.env.GS_APPARMOR_PROFILE = 'isaflow-gs';
    const confined = await renderPdfFirstPage(onePagePdf('TAX INVOICE 115.00'));
    expect(unconfined).not.toBeNull();
    expect(confined).toBe(unconfined);
  }, 30_000);

  it.skipIf(!profileLoaded())('runs gs itself confined: a gs that tries to write outside its temp dir cannot', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vlm-render-bin-'));
    for (const name of ['prlimit', 'aa-exec']) symlinkSync(execFileSync('which', [name]).toString().trim(), join(bin, name));
    const marker = join(bin, 'escaped');
    writeFileSync(join(bin, 'gs'), `#!/bin/sh\necho escaped > ${marker}\n`, { mode: 0o755 });
    process.env.PATH = bin;
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    delete process.env.GS_APPARMOR_PROFILE;
    await renderPdfFirstPage(onePagePdf('UNCONFINED'));
    expect(existsSync(marker)).toBe(true);   // the probe works: unconfined, it writes
    rmSync(marker);
    process.env.GS_APPARMOR_PROFILE = 'isaflow-gs';
    expect(await renderPdfFirstPage(onePagePdf('CONFINED'))).toBeNull();
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('fails the render, as an outage, when the named profile does not exist: never an unconfined gs', async () => {
    process.env.GS_APPARMOR_PROFILE = 'isaflow-gs-no-such-profile';
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    expect(await renderPdfFirstPage(onePagePdf('NOT CONFINED'))).toBeNull();
    expect(error).toHaveBeenCalledWith('PDF render unavailable: AppArmor profile could not be applied',
      expect.objectContaining({ profile: 'isaflow-gs-no-such-profile' }), 'vlm-pdf-render');
  }, 30_000);

  it('treats a missing aa-exec as an outage when a profile is named', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'vlm-render-bin-'));
    for (const name of ['gs', 'prlimit']) symlinkSync(execFileSync('which', [name]).toString().trim(), join(bin, name));
    process.env.PATH = bin;
    process.env.GS_APPARMOR_PROFILE = 'isaflow-gs';
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    expect(await renderPdfFirstPage(onePagePdf('NO AA-EXEC'))).toBeNull();
    expect(error).toHaveBeenCalledWith('PDF render unavailable: gs or prlimit not found',
      expect.objectContaining({ error: 'not on PATH: aa-exec' }), 'vlm-pdf-render');
  }, 30_000);

  it('still renders unconfined when no profile is named (dev, CI)', async () => {
    delete process.env.GS_APPARMOR_PROFILE;
    const bin = mkdtempSync(join(tmpdir(), 'vlm-render-bin-'));
    for (const name of ['gs', 'prlimit']) symlinkSync(execFileSync('which', [name]).toString().trim(), join(bin, name));
    process.env.PATH = bin;   // no aa-exec here, and none needed
    expect(await renderPdfFirstPage(onePagePdf('DEV'))).not.toBeNull();
  }, 30_000);
});
