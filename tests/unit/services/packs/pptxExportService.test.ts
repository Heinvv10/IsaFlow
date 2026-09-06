/**
 * The deck as bytes. A .pptx is a zip of OOXML parts, so "it rendered" is
 * checkable without PowerPoint: read the zip's own central directory and look
 * for the slide parts. The entry NAMES live there uncompressed, which is
 * exactly what is asserted here — no unzip dependency needed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { renderPackPptx } from '@/modules/accounting/services/packs/pptxExportService';
import type { DeckSlide } from '@/modules/accounting/services/packs/packDeckModel';

const slides: DeckSlide[] = [
  { kind: 'title', title: 'ISAFlow Demo', subtitle: 'Management Pack', footnote: '2026-01-01 to 2026-09-05' },
  { kind: 'table', title: 'Statement of Comprehensive Income', rows: [
    { label: 'Turnover', value: '4 812 345.67', emphasis: false },
    { label: 'Net Profit / (Loss)', value: '1 275 632.74', emphasis: true },
  ] },
  { kind: 'chart', title: 'Profit Bridge', categories: ['Revenue', 'Cost of Sales'], series: [{ name: 'Movement', values: [4812345.67, -2190000] }] },
  { kind: 'text', title: 'Commentary', body: 'Revenue grew.' },
];

/**
 * The entries of a zip, read through its End of Central Directory record.
 * Walking the whole buffer for the central-directory signature also finds it
 * inside the chart's EMBEDDED workbook, which would over-count the slides.
 */
interface ZipEntry { name: string; offset: number; compressed: boolean; size: number }

function zipEntries(buffer: Buffer): ZipEntry[] {
  const EOCD_SIGNATURE = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    entries.push({
      name: buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      offset: buffer.readUInt32LE(at + 42),
      compressed: buffer.readUInt16LE(at + 10) !== 0,
      size: buffer.readUInt32LE(at + 20),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const zipEntryNames = (buffer: Buffer): string[] => zipEntries(buffer).map((e) => e.name);

/** One entry's bytes, inflated when the archive deflated it. */
function readZipEntry(buffer: Buffer, name: string): string {
  const entry = zipEntries(buffer).find((e) => e.name === name);
  if (!entry) throw new Error(`no such zip entry: ${name}`);
  const nameLength = buffer.readUInt16LE(entry.offset + 26);
  const extraLength = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = buffer.subarray(start, start + entry.size);
  return (entry.compressed ? inflateRawSync(body) : body).toString('utf8');
}

describe('renderPackPptx', () => {
  it('produces a real OOXML package with one slide part per deck slide', async () => {
    const buffer = await renderPackPptx(slides);
    expect(buffer.subarray(0, 2).toString('binary')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(5000);

    const names = zipEntryNames(buffer);
    expect(names).toContain('ppt/presentation.xml');
    const slideParts = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slideParts).toHaveLength(slides.length);
  });

  it('writes a file a reader can open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pack-pptx-'));
    const path = join(dir, 'pack.pptx');
    writeFileSync(path, await renderPackPptx(slides));
    expect(zipEntryNames(readFileSync(path))).toContain('ppt/slides/slide1.xml');
  });

  it('adds a NATIVE chart part, not a picture of one', async () => {
    const buffer = await renderPackPptx([slides[2]!]);
    const names = zipEntryNames(buffer);
    expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    // The chart's own data sheet — what makes it editable in PowerPoint.
    expect(names.some((n) => /^ppt\/embeddings\/.+\.xlsx$/.test(n))).toBe(true);
    // Nothing but the (empty) directory entry under media: no picture of a chart.
    expect(names.filter((n) => n.startsWith('ppt/media/') && !n.endsWith('/'))).toEqual([]);
  });

  it('renders a deck with no slides rather than throwing', async () => {
    const buffer = await renderPackPptx([]);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('strips control characters, which XML 1.0 cannot carry at all', async () => {
    const bell = String.fromCharCode(7);
    const buffer = await renderPackPptx([
      { kind: 'text', title: `Commentary${bell}`, body: `Ledger${bell} note` },
    ]);
    const xml = readZipEntry(buffer, 'ppt/slides/slide1.xml');
    expect(xml).not.toContain(bell);
    expect(xml).toContain('Commentary');
    expect(xml).toContain('Ledger');
  });

  it('renders XML-significant ledger text without corrupting the package', async () => {
    const buffer = await renderPackPptx([
      { kind: 'table', title: 'Suppliers', rows: [{ label: 'Smith & Co <Pty> Ltd', value: '1 000.00', emphasis: false }] },
    ]);
    // pptxgenjs escapes on the way in; escaping again here would print
    // "&amp;amp;" on the slide.
    expect(readZipEntry(buffer, 'ppt/slides/slide1.xml')).toContain('Smith &amp; Co &lt;Pty&gt; Ltd');
  });
});
