/**
 * The upload path's "complete file" rule: a polyglot PDF (content after its end) and a truncated image are refused; a
 * phone photo with an MP4 appended after FFD9 (a "motion photo") or padding after a PNG's IEND is a genuine receipt.
 */
import { describe, expect, it } from 'vitest';
import { uploadStructureComplete } from '@/lib/mcp/uploadBytesCheck';

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const EOI = Buffer.from([0xff, 0xd9]);
const PNG_HEAD = Buffer.from('89504e470d0a1a0a', 'hex');
const IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const MP4 = Buffer.from('\0\0\0\x18ftypmp42 motion photo video', 'latin1');

describe('uploadStructureComplete', () => {
  it('accepts a motion-photo JPEG (MP4 after FFD9) and refuses a JPEG with no end marker', () => {
    expect(uploadStructureComplete(Buffer.concat([JPEG_SOI, Buffer.from('img'), EOI, MP4]), 'image/jpeg')).toBe(true);
    expect(uploadStructureComplete(Buffer.concat([JPEG_SOI, Buffer.from('img'), EOI]), 'image/jpeg')).toBe(true);
    expect(uploadStructureComplete(Buffer.concat([JPEG_SOI, Buffer.from('truncated')]), 'image/jpeg')).toBe(false);
  });

  it('accepts a PNG padded after IEND and refuses one with no IEND', () => {
    expect(uploadStructureComplete(Buffer.concat([PNG_HEAD, Buffer.from('px'), IEND, Buffer.alloc(16)]), 'image/png')).toBe(true);
    expect(uploadStructureComplete(Buffer.concat([PNG_HEAD, Buffer.from('px')]), 'image/png')).toBe(false);
  });

  it('still refuses a PDF whose %%EOF is not in its last 1024 bytes (a polyglot tail)', () => {
    const pdf = Buffer.from('%PDF-1.4\nbody\n%%EOF\n');
    expect(uploadStructureComplete(pdf, 'application/pdf')).toBe(true);
    expect(uploadStructureComplete(Buffer.concat([pdf, Buffer.from(`<html>${'x'.repeat(2000)}</html>`)]), 'application/pdf')).toBe(false);
    // a SHORT tail after %%EOF is refused too (review round 2 REPRO B)
    expect(uploadStructureComplete(Buffer.from('%PDF-1.4\n%%EOF\n<html><script>alert(1)</script></html>\n'), 'application/pdf')).toBe(false);
    // whitespace / NUL padding after %%EOF is how real PDFs end
    expect(uploadStructureComplete(Buffer.from('%PDF-1.4\nbody\n%%EOF\r\n\0\0'), 'application/pdf')).toBe(true);
  });
});
