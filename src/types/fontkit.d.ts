/**
 * The slice of fontkit (a pdfkit dependency, declared directly in package.json) the pack's glyph ruler uses
 * (`src/modules/accounting/services/packs/pages/packGlyphRuler.ts`). fontkit ships no types.
 */
declare module 'fontkit' {
  export interface GlyphPosition { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }
  export interface GlyphRun { positions: GlyphPosition[]; advanceWidth: number }
  /** A glyph before shaping, with the code points it stands for (`Font.glyphsForString`). */
  export interface Glyph { id: number; codePoints: number[] }
  export interface Font {
    unitsPerEm: number;
    characterSet: number[];
    hasGlyphForCodePoint(codePoint: number): boolean;
    glyphsForString(text: string): Glyph[];
    layout(text: string | Glyph[], features?: string[]): GlyphRun;
  }
  export function create(buffer: Buffer): Font;
  export function openSync(filename: string): Font;
}
