/**
 * THE GATE THAT HOLDS THE PAGE BACK UNTIL THE TYPE HAS ARRIVED.
 *
 * `packPrint.css` declares every face `font-display: block`, so text in a face
 * that has not loaded prints as nothing at all. These drive `packFontsLoaded`
 * against a stubbed `FontFaceSet` because that is the only way to hold the
 * cases apart: a face that arrives, a face that never does, and a browser with
 * no CSS Font Loading API to ask.
 *
 * AND THE FOURTH FACE, WHICH IS THE FOOTER'S. The page never sets a word in it;
 * it loads it so that Chromium — which draws the running footer in a document
 * of its own that may fetch nothing — finds the data URI it is about to ask
 * for already in the cache. Held here because the harness in
 * `tests/unit/print/renderPackPdf.tsx` performs those steps itself: without
 * this test the APP could stop doing them and the printed-file test would stay
 * green on the harness's own copy.
 */
import { describe, expect, it, vi } from 'vitest';
import { packFontsLoaded, PACK_FONT_WEIGHTS } from '@/components/accounting/packs/usePrintMode';
import {
  PACK_FOOTER_FACE_FILE, PACK_FOOTER_FONT_FAMILY, packFooterFaceCss,
} from '@/lib/charts/packFont';

interface Stub {
  fonts?: {
    load: (font: string, text?: string) => Promise<unknown[]>;
    check: (font: string, text?: string) => boolean;
    ready: Promise<unknown>;
  };
}

/** The one woff2 the footer face is cut from, as the browser would receive it. */
const FACE_BYTES = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x10]);

function stubFetch() {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    return { ok: true, arrayBuffer: async () => FACE_BYTES.buffer } as unknown as Response;
  }));
  return fetched;
}

function stub(check: (font: string) => boolean) {
  const load = vi.fn(async () => []);
  const head = { appendChild: vi.fn() };
  const styles: Array<{ id: string; textContent: string }> = [];
  const doc = {
    fonts: { load, check, ready: Promise.resolve(null) },
    head,
    getElementById: () => null,
    createElement: () => {
      const el = { id: '', textContent: '' };
      styles.push(el);
      return el;
    },
  } as unknown as Document;
  return { doc, load, styles };
}

describe('packFontsLoaded', () => {
  it('asks for every declared weight before it answers', async () => {
    const fetched = stubFetch();
    const { doc, load } = stub(() => true);
    await expect(packFontsLoaded(doc)).resolves.toBe(true);

    // `load()` REQUESTS a face; `document.fonts.ready` only observes the ones
    // something else has already asked for, which is why it is not the gate.
    expect(load).toHaveBeenCalledTimes(PACK_FONT_WEIGHTS.length + 1);
    for (const weight of PACK_FONT_WEIGHTS) {
      expect(load).toHaveBeenCalledWith(expect.stringContaining(`${weight} `), expect.any(String));
    }
    expect(load).toHaveBeenCalledWith(
      expect.stringContaining(PACK_FOOTER_FONT_FAMILY), expect.any(String),
    );
    expect(fetched).toEqual([`/fonts/${PACK_FOOTER_FACE_FILE}`]);
    vi.unstubAllGlobals();
  });

  it('injects the footer face as the footer template spells it, not as its own string', async () => {
    stubFetch();
    const { doc, styles } = stub(() => true);
    await packFontsLoaded(doc);

    // Byte-for-byte the same CSS `buildFooterHtml` emits — Chromium matches
    // the RESOURCE, so a second spelling is a second resource and the footer
    // falls back to a system face in silence.
    const expected = packFooterFaceCss(Buffer.from(FACE_BYTES).toString('base64'));
    expect(styles.map((s) => s.textContent)).toContain(expected);
    vi.unstubAllGlobals();
  });

  it('answers false when one weight is still unavailable afterwards', async () => {
    stubFetch();
    // The exact shape of the defect: the 400-weight prose printed and every
    // 500- and 600-weight figure, header and title did not.
    const { doc } = stub((font) => font.startsWith('400') && !font.includes(PACK_FOOTER_FONT_FAMILY));
    await expect(packFontsLoaded(doc)).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it('answers false when the footer face alone is unavailable', async () => {
    stubFetch();
    const { doc } = stub((font) => !font.includes(PACK_FOOTER_FONT_FAMILY));
    await expect(packFontsLoaded(doc)).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it('refuses to become ready when the footer face cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    const { doc } = stub(() => true);
    await expect(packFontsLoaded(doc)).rejects.toThrow(/footer face/i);
    vi.unstubAllGlobals();
  });

  it('does not block a document with no font-loading API', async () => {
    await expect(packFontsLoaded({} as Document)).resolves.toBe(true);
  });
});
