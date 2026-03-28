/**
 * Generate premium ISAFlow logos — Round 2
 * Using gemini-3-pro-image-preview for highest quality
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('GEMINI_API_KEY required'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: API_KEY });
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'landing');

const LOGOS = [
  {
    filename: 'logo-pro-1.png',
    prompt: `You are a world-class brand designer at Pentagram. Design a $500,000 logo for "ISAFlow" — a premium fintech accounting platform.

STRICT RULES:
- Pure white background, no textures, no gradients on background
- The logo must be CRISP, SHARP, VECTOR-QUALITY — no blur, no artifacts
- Horizontal layout: icon on the left, "ISAFlow" wordmark on the right
- The icon must be SIMPLE — no more than 3 geometric shapes
- Think: Stripe, Linear, Vercel, Notion level of refinement

ICON CONCEPT: Two overlapping curved parallelograms forming an abstract "flow" or infinity-like shape — suggesting continuous financial flow. Clean geometric construction with perfect curves.

COLORS:
- Icon: solid teal #0d9488, no gradients
- "Isa" text: teal #0d9488
- "Flow" text: near-black #0f172a
- Font: clean geometric sans-serif like Satoshi, Inter, or Graphik — medium weight

OUTPUT: Perfectly centered on white canvas with generous padding. The logo should look like it costs a million dollars through its restraint and precision.`,
  },
  {
    filename: 'logo-pro-2.png',
    prompt: `You are the lead designer at Wolff Olins. Create an iconic brand mark for "ISAFlow" fintech software.

STRICT RULES:
- Pure white background
- Vector-quality sharpness — this must look like it was made in Adobe Illustrator
- Horizontal layout: distinctive icon mark + "ISAFlow" wordmark

ICON CONCEPT: A single, bold, geometric lettermark — the letters "i" and "f" cleverly merged into one unified abstract symbol. The "i" dot becomes part of the "f" crossbar. Minimal, bold, unforgettable. Like the old Beats logo or the FedEx arrow — simple but genius.

COLORS:
- Icon: deep teal to cyan gradient (#0d9488 to #06b6d4) — the ONLY gradient in the entire logo
- "Isa" text: #0d9488 solid teal
- "Flow" text: #0f172a dark slate
- Font: geometric sans-serif, semibold weight, slightly wide letter-spacing

The result should be so refined and minimal that it looks effortless — but every proportion is mathematically perfect. Pentagram-quality execution.`,
  },
  {
    filename: 'logo-pro-3.png',
    prompt: `Design an ultra-premium logomark (ICON ONLY, absolutely no text) for "ISAFlow" fintech platform.

STRICT REQUIREMENTS:
- Square canvas, pure white background
- ONE single mark, perfectly centered
- Must work at 16x16 pixels (favicon) AND at billboard scale
- No more than 2 colors: teal #0d9488 and a lighter teal #14b8a6

CONCEPT: An abstract, geometric mark that suggests BOTH a book/ledger AND flowing water/data. Think of it as a square or rounded-square that has one corner that flows or curves elegantly — like a page turning, or water flowing off an edge. The negative space is as important as the positive space.

STYLE: Absolutely minimal. Think: the Apple logo, the Airbnb logo, the Spotify logo — icons so simple a child could draw them, but so perfect they're worth billions. No complexity, no ornamentation, no 3D effects. Flat, bold, iconic.

This icon should be instantly recognizable from across a room.`,
  },
  {
    filename: 'logo-pro-4.png',
    prompt: `Create a wordmark-only logo for "ISAFlow" — no icon, just pure typography mastery.

STRICT RULES:
- Pure white background, horizontally centered
- ONLY the word "ISAFlow" — nothing else
- The genius must be in the typography itself

DESIGN:
- Custom letterforms where the "F" in "Flow" has an elegant horizontal stroke that extends leftward, subtly connecting to the "A" — creating visual flow
- "ISA" in bold weight, dark navy #0f172a
- "Flow" in medium weight, teal #0d9488
- The transition from dark to teal should feel seamless and elegant
- Sans-serif, geometric, modern — like the Google wordmark meets the Stripe wordmark
- Slightly tighter kerning than normal for a premium feel
- The "F" could have a very subtle curved tail or the "w" could have a slight flourish — ONE small detail that makes it unique

This should look like a $10 billion tech company wordmark. Clean enough for a bank, modern enough for a startup.`,
  },
  {
    filename: 'logo-pro-5.png',
    prompt: `You are Paula Scher designing a logo for "ISAFlow", a premium South African fintech accounting platform worth $1 billion.

REQUIREMENTS:
- Pure white background
- Horizontal: icon + wordmark
- Icon must be BOLD, GEOMETRIC, MEMORABLE

ICON: An abstract "S" shape made from two perfect semicircles offset vertically — like a yin-yang simplified to its essence, or like the Slack logo's geometric precision. The shape suggests flow, balance (like a balance sheet), and the letter S for South Africa.

The two semicircles should interlock or overlap slightly, creating a dynamic tension. One semicircle in #0d9488 (teal), the other in #06b6d4 (cyan) — where they overlap, the color blends.

WORDMARK: "ISAFlow" in a premium geometric sans-serif.
- "Isa" in #0d9488
- "Flow" in #0f172a
- Tracking: slightly loose (+20)
- Weight: semibold

The overall composition should have Bauhaus-level geometric harmony. Every element relates to every other element through proportion and grid.`,
  },
  {
    filename: 'logo-pro-icon.png',
    prompt: `Design an app icon for "ISAFlow" that would win an Apple Design Award.

REQUIREMENTS:
- Square with standard iOS rounded corners (superellipse)
- Background: smooth gradient from #0d9488 (top-left) to #06b6d4 (bottom-right)
- Central symbol: pure white, bold, geometric
- The symbol must be DEAD SIMPLE — recognizable at 29x29 pixels

SYMBOL CONCEPT: An abstract open book seen from above, reduced to its absolute geometric essence — two rectangles or parallelograms angled like an open book, with a single upward-trending line/arrow cutting through the center. The book represents accounting/ledger, the arrow represents growth/flow.

Maximum 4-5 white shapes total. No thin lines — everything should be bold and chunky enough to read at tiny sizes. No shadows, no 3D effects, no skeuomorphism.

Study the Stripe app icon, the Revolut app icon, the Robinhood app icon — that level of iconic simplicity.`,
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
    // Try pro model first, fall back to flash
    let model = 'gemini-3-pro-image-preview';
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: prompt.prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });
    } catch {
      console.log(`  Pro model unavailable, using flash...`);
      model = 'gemini-3.1-flash-image-preview';
      response = await ai.models.generateContent({
        model,
        contents: prompt.prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });
    }

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) { console.error(`  No response`); return; }

    for (const part of parts) {
      if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data!, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`  Saved ${prompt.filename} (${(buffer.length / 1024).toFixed(0)} KB) [${model}]`);
        return;
      }
    }
    console.error(`  No image data returned`);
  } catch (err: unknown) {
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log('ISAFlow Logo Generator v2 — Premium Round');
  console.log(`Generating ${LOGOS.length} premium logos...\n`);

  for (const logo of LOGOS) {
    await generateLogo(logo);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\nDone!');
}

main();
