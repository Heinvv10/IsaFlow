/**
 * Round-17 review R17-5: OwnedReport.create when the placeholder cannot be written after the exclusive open (a full disk): it returns why,
 * and removes the file it just created, so no empty file is left to block the next run. node:fs's writeSync is made to fail with ENOSPC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../../../../scripts/sage-migration/runConsole', async (orig) => (await import('./sageCliConsoleSpy')).spied(await orig()));

const h = vi.hoisted(() => ({ fail: false, unlinkFails: false }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const writeSync = ((...a: Parameters<typeof real.writeSync>) => {
    if (h.fail) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return (real.writeSync as (...x: unknown[]) => number)(...a);
  }) as typeof real.writeSync;
  const unlinkSync = ((...a: Parameters<typeof real.unlinkSync>) => {
    if (h.unlinkFails) throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
    return real.unlinkSync(...a);
  }) as typeof real.unlinkSync;
  return { ...real, default: { ...real, writeSync, unlinkSync }, writeSync, unlinkSync };
});

import { OwnedReport } from '../../../../scripts/sage-migration/runReport';

const dirs: string[] = [];
afterEach(() => { h.fail = false; h.unlinkFails = false; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('R17-5: a placeholder that cannot be written', () => {
  it('returns why (nothing written) and leaves no file behind', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-create-'));
    dirs.push(d);
    const p = join(d, 'report.json');
    h.fail = true;
    expect(OwnedReport.create(p)).toEqual({ why: expect.stringMatching(/could not be written: ENOSPC/) });
    expect(existsSync(p)).toBe(false);
  });
  it('R18-4: the file it made could not be removed: `left` says so (the CLI must not say "not created")', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-create-'));
    dirs.push(d);
    const p = join(d, 'report.json');
    [h.fail, h.unlinkFails] = [true, true];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(OwnedReport.create(p)).toEqual({ why: expect.stringMatching(/ENOSPC/), left: true });
    expect(existsSync(p)).toBe(true);
  });
  it('a placeholder that can be written: the file stays', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-create-'));
    dirs.push(d);
    const r = OwnedReport.create(join(d, 'report.json'));
    expect(r).toBeInstanceOf(OwnedReport);
    (r as OwnedReport).close();
    expect(existsSync(join(d, 'report.json'))).toBe(true);
  });
});
