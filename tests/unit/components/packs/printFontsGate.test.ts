/**
 * THE GATE THAT HOLDS THE PAGE BACK UNTIL THE TYPE HAS ARRIVED.
 *
 * `packPrint.css` declares every face `font-display: block`, so text in a face
 * that has not loaded prints as nothing at all. These drive `packFontsLoaded`
 * against a stubbed `FontFaceSet` because that is the only way to hold the
 * three cases apart: a face that arrives, a face that never does, and a
 * browser with no CSS Font Loading API to ask.
 */
import { describe, expect, it, vi } from 'vitest';
import { packFontsLoaded, PACK_FONT_WEIGHTS } from '@/components/accounting/packs/usePrintMode';

interface Stub {
  fonts?: {
    load: (font: string, text?: string) => Promise<unknown[]>;
    check: (font: string, text?: string) => boolean;
    ready: Promise<unknown>;
  };
}

function stub(check: (font: string) => boolean) {
  const load = vi.fn(async () => []);
  return {
    doc: { fonts: { load, check, ready: Promise.resolve(null) } } as Stub as Document,
    load,
  };
}

describe('packFontsLoaded', () => {
  it('asks for every declared weight before it answers', async () => {
    const { doc, load } = stub(() => true);
    await expect(packFontsLoaded(doc)).resolves.toBe(true);

    // `load()` REQUESTS a face; `document.fonts.ready` only observes the ones
    // something else has already asked for, which is why it is not the gate.
    expect(load).toHaveBeenCalledTimes(PACK_FONT_WEIGHTS.length);
    for (const weight of PACK_FONT_WEIGHTS) {
      expect(load).toHaveBeenCalledWith(expect.stringContaining(`${weight} `), expect.any(String));
    }
  });

  it('answers false when one weight is still unavailable afterwards', async () => {
    // The exact shape of the defect: the 400-weight prose printed and every
    // 500- and 600-weight figure, header and title did not.
    const { doc } = stub((font) => font.startsWith('400'));
    await expect(packFontsLoaded(doc)).resolves.toBe(false);
  });

  it('does not block a document with no font-loading API', async () => {
    await expect(packFontsLoaded({} as Document)).resolves.toBe(true);
  });
});
