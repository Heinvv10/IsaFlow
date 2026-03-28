/**
 * ISAFlow Brand Identity Generator — NanoBanana 2 Pro
 * Generates a complete BI package with all logo variations
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('GEMINI_API_KEY required'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: API_KEY });
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'brand');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Base description of the chosen logo (logo-sp-4.png — the living water wordmark)
const LOGO_DESC = `The ISAFlow logo is a pure typographic wordmark:
- "ISA" in bold weight, dark navy (#0f172a)
- "Flow" in medium weight, teal (#0d9488)
- A subtle flowing curve/wave runs beneath the entire word, from the "I" to the "w"
- The wave is very light teal (#99f6e4), elegant and understated — like living water
- The transition between "A" and "F" has a smooth teal arc connecting the two halves
- Sans-serif geometric font, modern and clean
- The overall feel: premium fintech, $10 billion tech company wordmark
- NO icon, NO separate symbol — the typography IS the logo`;

const LOGOS = [
  // ── PRIMARY LOGO (Full Color on White) ──
  {
    filename: 'logo-primary.png',
    prompt: `${LOGO_DESC}

Generate this exact logo on a PURE WHITE (#FFFFFF) background.
The logo should be horizontally centered with generous padding (20% on each side).
Canvas size: wide horizontal format (roughly 2400x800 pixels).
ULTRA SHARP, vector-quality crispness. No blur, no artifacts, no shadows.
This is the PRIMARY logo — it must be PERFECT.`,
  },

  // ── REVERSED LOGO (White on Dark) ──
  {
    filename: 'logo-reversed.png',
    prompt: `${LOGO_DESC}

Generate this logo but REVERSED for dark backgrounds:
- "ISA" in WHITE (#FFFFFF) instead of navy
- "Flow" in light teal (#5eead4) instead of dark teal
- The flowing wave in medium teal (#14b8a6)
- Background: PURE DARK (#0f172a) — dark navy/slate

Horizontally centered, generous padding. Wide horizontal format.
ULTRA SHARP, vector-quality. This is the dark-mode version.`,
  },

  // ── LOGO ON TRANSPARENT (simulated with very clean white) ──
  {
    filename: 'logo-clean.png',
    prompt: `${LOGO_DESC}

Generate this exact logo on an absolutely PURE WHITE background with NO shadows, NO gradients, NO texture whatsoever. The background must be perfectly uniform #FFFFFF white so it can be easily made transparent in post-processing.

Horizontally centered. Wide format (3:1 ratio approximately).
MAXIMUM sharpness and crispness. Every edge must be pixel-perfect.
No anti-aliasing artifacts against the background.`,
  },

  // ── SQUARE ICON MARK ──
  {
    filename: 'icon-square.png',
    prompt: `Create a square icon/mark derived from the ISAFlow brand. This is the ICON-ONLY version (no full wordmark).

The icon should be:
- The letters "iF" merged into a single monogram, styled to match the ISAFlow wordmark
- The "i" in dark navy (#0f172a), the "F" in teal (#0d9488)
- A subtle flowing curve connects/wraps around the two letters
- OR alternatively: just the stylized "F" from "Flow" with the characteristic flowing curve beneath it

Background: PURE WHITE
Square canvas (1:1 ratio), centered with 15% padding on all sides.
Bold, chunky enough to read at small sizes (32x32px).
ULTRA SHARP, clean geometric sans-serif style matching the wordmark.`,
  },

  // ── APP ICON (iOS/Android style) ──
  {
    filename: 'icon-app.png',
    prompt: `Create an app icon for ISAFlow:

- Square with iOS-style rounded corners (superellipse shape)
- Background: smooth gradient from dark navy (#0f172a) at top-left to dark teal (#134e4a) at bottom-right
- Center symbol in WHITE: a stylized "iF" monogram or just the "F" with a flowing curve
- The symbol should match the ISAFlow wordmark style — geometric, clean sans-serif
- The flowing curve element from the wordmark should be subtly incorporated
- BOLD, readable at 29x29 pixels

1024x1024 pixel square. NO text other than the monogram.
Premium quality — Apple App Store / Google Play ready.`,
  },

  // ── FAVICON ──
  {
    filename: 'icon-favicon.png',
    prompt: `Create a tiny favicon for ISAFlow:

- Square canvas, will be used at 32x32 and 16x16 pixels
- Background: solid teal (#0d9488)
- Center: a single bold WHITE letter "F" with a subtle flowing curve at its base
- The "F" should be chunky and geometric, matching the ISAFlow brand
- EXTREMELY SIMPLE — must be legible at 16x16 pixels
- No fine details, no thin lines — just bold shapes

Render at 512x512 for maximum quality downscaling.`,
  },

  // ── SOCIAL MEDIA PROFILE (Circle crop ready) ──
  {
    filename: 'icon-social.png',
    prompt: `Create a social media profile picture for ISAFlow:

- Square canvas (will be circle-cropped by social platforms)
- Background: gradient from dark navy (#0f172a) to dark teal (#134e4a)
- Center: the "iF" monogram in WHITE, bold geometric sans-serif
- A subtle teal flowing curve accent
- Keep all important elements within the center 70% (safe zone for circle crop)
- Premium, polished, corporate feel

1024x1024 pixels. Ultra clean.`,
  },

  // ── STACKED LOGO (Vertical) ──
  {
    filename: 'logo-stacked.png',
    prompt: `${LOGO_DESC}

Generate this logo in a STACKED/VERTICAL layout:
- The "iF" monogram icon on top (dark navy "i" + teal "F" with flowing curve)
- "ISAFlow" wordmark below it (same colors: navy "ISA" + teal "Flow")
- The flowing wave runs beneath the wordmark
- Vertically centered on PURE WHITE background

Square-ish format (roughly 1:1 or 4:5 ratio).
This is for situations where horizontal space is limited.
ULTRA SHARP, vector-quality.`,
  },

  // ── MONOCHROME BLACK ──
  {
    filename: 'logo-mono-black.png',
    prompt: `${LOGO_DESC}

Generate this logo in SINGLE COLOR BLACK:
- Everything (ISA, Flow, and the flowing wave) in pure BLACK (#000000)
- "ISA" in bold weight, "Flow" in medium weight (same as original)
- The flowing wave in a lighter gray (#9ca3af) for subtle contrast
- Background: PURE WHITE (#FFFFFF)

Wide horizontal format. Used for single-color printing, fax, stamps.
ULTRA SHARP.`,
  },

  // ── MONOCHROME WHITE (for dark print) ──
  {
    filename: 'logo-mono-white.png',
    prompt: `${LOGO_DESC}

Generate this logo in SINGLE COLOR WHITE:
- Everything (ISA, Flow, and the flowing wave) in pure WHITE (#FFFFFF)
- "ISA" in bold weight, "Flow" in medium weight
- The flowing wave slightly transparent/lighter white
- Background: PURE BLACK (#000000)

Wide horizontal format. Used for dark merchandise, embossing.
ULTRA SHARP.`,
  },

  // ── WATERMARK VERSION ──
  {
    filename: 'logo-watermark.png',
    prompt: `${LOGO_DESC}

Generate this logo as a subtle WATERMARK version:
- The entire logo rendered in very light gray (#e5e7eb) — barely visible
- "ISA" slightly darker gray (#d1d5db), "Flow" in light gray (#e5e7eb)
- The flowing wave in ultra-light gray (#f3f4f6)
- Background: PURE WHITE (#FFFFFF)

Wide horizontal format. This will overlay on documents/invoices.
Subtle, professional, not distracting.`,
  },

  // ── EMAIL SIGNATURE ──
  {
    filename: 'logo-email.png',
    prompt: `${LOGO_DESC}

Generate this exact logo SMALL and COMPACT for email signatures:
- Same colors as primary (navy ISA, teal Flow, light teal wave)
- PURE WHITE background
- Tight horizontal format — minimal padding (5% max)
- Optimized for small display (will be shown at roughly 200x50 pixels)
- Every detail must be crisp even at small size

Wide format, compact. No wasted space.`,
  },
];

async function generateLogo(prompt: { filename: string; prompt: string }) {
  const outputPath = path.join(OUTPUT_DIR, prompt.filename);
  if (fs.existsSync(outputPath)) {
    console.log(`  Skipping ${prompt.filename} (exists — delete to regenerate)`);
    return;
  }

  console.log(`  Generating ${prompt.filename}...`);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: prompt.prompt,
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) { console.error(`  No response`); return; }

    for (const part of parts) {
      if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data!, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`  Saved ${prompt.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
        return;
      }
    }
    console.error(`  No image data returned`);
  } catch (err: unknown) {
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ISAFlow Brand Identity Generator');
  console.log('  NanoBanana 2 Pro (gemini-3-pro-image-preview)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  Assets: ${LOGOS.length} variations\n`);

  for (const logo of LOGOS) {
    await generateLogo(logo);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Brand Identity Package Complete!');
  console.log('═══════════════════════════════════════════════════');
  console.log('\n  Files generated:');
  console.log('  ├── logo-primary.png      — Full color on white (primary use)');
  console.log('  ├── logo-reversed.png     — White on dark (dark backgrounds)');
  console.log('  ├── logo-clean.png        — Clean white BG (for transparency)');
  console.log('  ├── logo-stacked.png      — Vertical/stacked layout');
  console.log('  ├── logo-mono-black.png   — Single color black (print)');
  console.log('  ├── logo-mono-white.png   — Single color white (dark print)');
  console.log('  ├── logo-watermark.png    — Subtle watermark (documents)');
  console.log('  ├── logo-email.png        — Compact email signature');
  console.log('  ├── icon-square.png       — Square icon mark');
  console.log('  ├── icon-app.png          — iOS/Android app icon');
  console.log('  ├── icon-favicon.png      — Favicon (32x32/16x16)');
  console.log('  └── icon-social.png       — Social media profile picture');
  console.log('');
}

main();
