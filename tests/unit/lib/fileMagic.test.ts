/**
 * File magic-byte validation — WS-3 (pentest H5/H6/M15).
 * Binds the *actual* bytes to the *claimed* MIME so a client cannot spoof the
 * Content-Type / data-URL header (e.g. an HTML/EXE payload labelled image/png).
 */
import { describe, it, expect } from 'vitest';
import { detectMimeFromMagic, magicBytesMatchMime, decodeUploadPayload } from '@/lib/fileMagic';

const buf = (...hex: number[]) => Buffer.concat([Buffer.from(hex), Buffer.alloc(16)]);
const JPEG = buf(0xff, 0xd8, 0xff, 0xe0);
const PNG = buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF = buf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const PDF = buf(0x25, 0x50, 0x44, 0x46, 0x2d);
const ZIP = buf(0x50, 0x4b, 0x03, 0x04);
const HTML = Buffer.from('<html><script>alert(1)</script>', 'utf8');

describe('detectMimeFromMagic', () => {
  it('detects real types', () => {
    expect(detectMimeFromMagic(JPEG)).toBe('image/jpeg');
    expect(detectMimeFromMagic(PNG)).toBe('image/png');
    expect(detectMimeFromMagic(GIF)).toBe('image/gif');
    expect(detectMimeFromMagic(PDF)).toBe('application/pdf');
    expect(detectMimeFromMagic(ZIP)).toBe('application/zip');
  });
  it('returns null for unknown / too-short / html-polyglot bytes', () => {
    expect(detectMimeFromMagic(HTML)).toBeNull();
    expect(detectMimeFromMagic(Buffer.from([0x00, 0x01]))).toBeNull();
  });
});

describe('magicBytesMatchMime — bytes must match the claimed type', () => {
  it('accepts a matching claim', () => {
    expect(magicBytesMatchMime(PNG, 'image/png')).toBe(true);
    expect(magicBytesMatchMime(PDF, 'application/pdf')).toBe(true);
    expect(magicBytesMatchMime(GIF, 'image/gif')).toBe(true);
  });
  it('rejects a spoofed claim (HTML bytes labelled image/png)', () => {
    expect(magicBytesMatchMime(HTML, 'image/png')).toBe(false);
  });
  it('rejects a mismatched-but-real claim (PNG bytes labelled application/pdf)', () => {
    expect(magicBytesMatchMime(PNG, 'application/pdf')).toBe(false);
  });
  it('accepts ZIP bytes for openxml docx/xlsx claims', () => {
    expect(magicBytesMatchMime(ZIP, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(magicBytesMatchMime(ZIP, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
  it('rejects an empty/short buffer', () => {
    expect(magicBytesMatchMime(Buffer.alloc(2), 'image/png')).toBe(false);
  });
});

describe('decodeUploadPayload — raw base64 and data URLs', () => {
  it('decodes a raw base64 string', () => {
    const b64 = PNG.toString('base64');
    expect(decodeUploadPayload(b64)?.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
  it('decodes a data: URL by stripping the header', () => {
    const url = `data:image/png;base64,${PNG.toString('base64')}`;
    expect(decodeUploadPayload(url)?.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
  it('returns null for empty input', () => {
    expect(decodeUploadPayload('')).toBeNull();
  });
});
