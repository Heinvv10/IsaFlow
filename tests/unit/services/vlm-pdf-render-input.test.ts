/**
 * Ghostscript only ever receives bytes starting `%PDF-`, and runs under
 * prlimit. gs runs a stream that does not start `%PDF-` as PostScript, and
 * `-dSAFER` alone still lets PostScript write under the temp dir, so whatever
 * precedes the header (up to 1 KB) is cut off before the spawn.
 */
import { existsSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ stdin: [] as Buffer[], argv: [] as string[][], tmp: [] as string[], throwOnSpawn: false }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      sent.argv.push([cmd, ...args]);
      if (opts.env?.TMPDIR) sent.tmp.push(opts.env.TMPDIR);
      if (sent.throwOnSpawn) throw new Error('spawn EAGAIN');
      const child = actual.spawn(cmd, args, opts);
      const end = child.stdin!.end.bind(child.stdin!);
      child.stdin!.end = ((chunk: Buffer) => { sent.stdin.push(chunk); return end(chunk); }) as typeof child.stdin.end;
      return child;
    }) as typeof actual.spawn,
  };
});

import { renderPdfFirstPage } from '@/modules/accounting/services/bank/vlmPdfRender';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
  + '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
  + '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n'
  + 'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

describe('what renderPdfFirstPage hands to gs', () => {
  it('cuts everything before the %PDF- header', async () => {
    sent.stdin.length = 0;
    await renderPdfFirstPage(Buffer.concat([Buffer.from('%!PS junk before the header\n'), PDF]));
    expect(sent.stdin).toHaveLength(1);
    expect(sent.stdin[0].subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sent.stdin[0].equals(PDF)).toBe(true);
  }, 30_000);

  it('finds a header that starts at byte 1023 (the last of the first 1 KB)', async () => {
    sent.stdin.length = 0;
    await renderPdfFirstPage(Buffer.concat([Buffer.alloc(1023, 0x20), PDF]));
    expect(sent.stdin).toHaveLength(1);
  }, 30_000);

  it('refuses a header that starts past the first 1 KB without spawning anything', async () => {
    sent.stdin.length = 0;
    expect(await renderPdfFirstPage(Buffer.concat([Buffer.alloc(1024, 0x20), PDF]))).toBeNull();
    expect(sent.stdin).toHaveLength(0);
  }, 30_000);

  it('gives each render its own private TMPDIR and removes it afterwards', async () => {
    sent.tmp.length = 0;
    await Promise.all([renderPdfFirstPage(PDF), renderPdfFirstPage(PDF)]);
    expect(sent.tmp).toHaveLength(2);
    expect(sent.tmp[0]).not.toBe(sent.tmp[1]);
    expect(sent.tmp.filter((dir) => existsSync(dir))).toEqual([]);
  }, 30_000);

  it('removes the temp dir when spawn itself throws', async () => {
    sent.tmp.length = 0;
    sent.throwOnSpawn = true;
    try {
      expect(await renderPdfFirstPage(PDF)).toBeNull();
    } finally {
      sent.throwOnSpawn = false;
    }
    expect(sent.tmp).toHaveLength(1);
    expect(existsSync(sent.tmp[0])).toBe(false);
  }, 30_000);

  it('runs gs under prlimit with memory and CPU caps', async () => {
    sent.argv.length = 0;
    await renderPdfFirstPage(PDF);
    expect(sent.argv[0].slice(0, 6)).toEqual(['prlimit', '--as=536870912', '--cpu=25:30', '--core=0', '--', 'gs']);
  }, 30_000);
});
