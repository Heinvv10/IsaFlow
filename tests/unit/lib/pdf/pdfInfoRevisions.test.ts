/**
 * The Info object is read from its NEWEST revision.
 *
 * An incremental update appends a new `N 0 obj` and leaves the old one where
 * it was. `readObjectDictionary` took the FIRST match — the stale revision —
 * so keys a later revision had added were dropped from the dictionary this
 * writer then wrote. Gotenberg's own exiftool pass produces exactly that shape
 * (two `1 0 obj`s: Skia's, then exiftool's).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writePdfInfoDictionary } from '@/lib/pdf/pdfInfoDictionary';


const META = { title: 'T', author: 'A', subject: 'S', creator: 'IsaFlow', custom: { IsaFlowPack: 'Board Pack' } };

/** Every `1 0 obj … endobj` in file order. */
function infoRevisions(text: string): string[] {
  return [...text.matchAll(/(?:^|[\r\n])1 0 obj([\s\S]*?)endobj/g)].map((m) => m[1]!);
}

/** A PDF whose Info object has been revised twice, the way an incremental
 *  update leaves it: the stale revision first, the newest later in the file. */
function twoRevisionPdf(): Buffer {
  let out = '%PDF-1.4\n';
  const a = out.length;
  out += '1 0 obj\n<< /Producer (Skia/PDF) /Title (Stale title) /Subject (Stale subject) >>\nendobj\n';
  const xref1 = out.length;
  out += `xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 2\n/Root 1 0 R\n/Info 1 0 R>>\nstartxref\n${xref1}\n%%EOF\n`;
  const b = out.length + 1;
  out += '\n1 0 obj\n<< /Producer (Skia/PDF) /Keywords (added by a later revision) >>\nendobj\n';
  const xref2 = out.length;
  out += `xref\n1 1\n${String(b).padStart(10, '0')} 00000 n \ntrailer\n<</Size 2\n/Root 1 0 R\n/Info 1 0 R\n/Prev ${xref1}>>\nstartxref\n${xref2}\n%%EOF\n`;
  void a;
  return Buffer.from(out, 'latin1');
}

describe('writePdfInfoDictionary reads the newest revision of the Info object', () => {
  it('keeps a key only the newest revision has, and does not resurrect the stale one', () => {
    const { pdf, written } = writePdfInfoDictionary(twoRevisionPdf(), META);
    expect(written).toBe(true);
    const revisions = infoRevisions(pdf.toString('latin1'));
    expect(revisions).toHaveLength(3);
    const latest = revisions[revisions.length - 1]!;
    expect(latest).toContain('/Keywords (added by a later revision)');
    expect(latest).not.toContain('Stale subject');
    expect(latest).toContain('/Title (T)');
    expect(latest).toContain('/IsaFlowPack (Board Pack)');
  });

  it('does the same on real Gotenberg output (a blank page, no tenant data)', () => {
    const real = readFileSync(path.join(__dirname, 'fixtures/gotenberg-blank.pdf'));
    const before = infoRevisions(real.toString('latin1'));
    // The fixture really is a two-revision file: Skia's, then exiftool's.
    expect(before).toHaveLength(2);
    expect(before[0]).toContain('/Title (blank)');
    expect(before[1]).toContain('/Author (A)');

    const { pdf, written } = writePdfInfoDictionary(real, META);
    expect(written).toBe(true);
    const latest = infoRevisions(pdf.toString('latin1')).at(-1)!;
    // Everything exiftool's revision carried that this writer does not set.
    expect(latest).toContain('/Producer (Skia/PDF m151)');
    expect(latest).toContain('/CreationDate');
    expect(latest).toContain('/IsaFlowPack (Board Pack)');
    // The original bytes are untouched: an incremental update.
    expect(pdf.subarray(0, real.length).equals(real)).toBe(true);
  });
});
