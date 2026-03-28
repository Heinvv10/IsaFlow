/**
 * Generate ISAFlow logos — Round 3: Biblical-spiritual undertones
 * Subtle, not obvious. Premium fintech meets timeless wisdom.
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
    filename: 'logo-sp-1.png',
    prompt: `Design an ultra-premium horizontal logo for "ISAFlow" — a fintech accounting platform. The brand embodies wisdom, integrity, and stewardship.

ICON CONCEPT: An abstract mark that is SIMULTANEOUSLY:
1. An open book/ledger (accounting)
2. A pair of wings in flight (spiritual elevation, dove-like but abstracted)
The two "pages" of the open book curve upward and outward like wings taking flight. The spine of the book becomes a subtle vertical axis of symmetry — like a pillar or cornerstone. The overall shape suggests ascension and balance.

STRICT DESIGN RULES:
- Pure white background
- Icon: teal #0d9488, clean flat geometric shapes, no gradients
- Wordmark: "Isa" in teal #0d9488, "Flow" in dark navy #0f172a
- Premium geometric sans-serif font, semibold
- Horizontal layout: icon left, wordmark right
- Maximum 3-4 shapes in the icon — radical simplicity
- Pentagram/Wolff Olins quality execution
- Must look like a $1B fintech logo, NOT a church logo`,
  },
  {
    filename: 'logo-sp-2.png',
    prompt: `Design a premium logo for "ISAFlow" fintech accounting software. The brand represents faithful stewardship and flowing abundance.

ICON CONCEPT: Three flowing parallel lines that curve gracefully — representing:
- The concept of three (trinity, completeness) without being religious
- Financial data flowing like living water
- The lines start straight/structured on the left (order, ledger) and transition to flowing curves on the right (flow, growth, abundance)
The three lines are slightly different lengths, creating a sense of movement and rhythm. They could subtly form an abstract "S" shape.

STRICT DESIGN RULES:
- Pure white background, no texture
- Three lines in varying teal tones: #0d9488, #14b8a6, #2dd4bf (dark to light)
- Wordmark: "Isa" in #0d9488, "Flow" in #0f172a
- Clean geometric sans-serif, medium weight
- Horizontal: icon + wordmark
- The feeling should be: wisdom, flow, trustworthiness — like water from a rock
- Must read as premium fintech, NOT spiritual or religious
- Pentagram-level design execution`,
  },
  {
    filename: 'logo-sp-3.png',
    prompt: `Create a logo for "ISAFlow" — a premium accounting platform built on principles of integrity and wise stewardship.

ICON CONCEPT: A perfect balanced scale abstracted into pure geometry:
- Two small circles (or dots) at equal heights, connected by a gentle arc or chevron below them — like an extremely simplified balance scale
- The arc curves downward like a smile or a cupped hand — suggesting both measurement and generosity
- The whole mark fits within a circle or rounded square boundary
- It simultaneously reads as: scales of balance (justice/fairness), an abstract face (human/personal), and the letter "A" or a roof (shelter/protection)

STRICT DESIGN RULES:
- Pure white background
- Icon: solid teal #0d9488, no gradients
- Wordmark: "Isa" in #0d9488, "Flow" in #0f172a
- Horizontal layout
- Ultra-minimal — a child could draw it, but a designer would admire it
- Think: Airbnb logo simplicity, Stripe confidence
- Must feel like premium fintech, the spiritual undertone is invisible to those not looking`,
  },
  {
    filename: 'logo-sp-4.png',
    prompt: `Design a wordmark logo for "ISAFlow" — premium accounting software. The brand carries deep meaning: "Isa" means Jesus in many cultures, "Flow" represents the flow of living water and financial abundance.

DESIGN: Pure typographic wordmark, NO separate icon.
- "ISA" in bold weight, dark navy #0f172a
- "Flow" in medium weight, teal #0d9488
- The letter "F" in Flow has a single horizontal crossbar that extends leftward, connecting to the "A" — creating visual continuity, a bridge between the old and new
- Below/through the crossbar connection, a single thin flowing curve — like a river or stream — runs subtly beneath the full word, from the "I" to the "w". This line is very subtle, light teal #5eead4
- The flowing line suggests: living water, financial flow, a foundation/underline of support

STRICT RULES:
- Pure white background
- No icon — the typography IS the logo
- The flowing underline is VERY subtle — almost invisible, like a watermark
- Premium geometric sans-serif (like Satoshi or Graphik)
- Must look like a $10 billion tech company wordmark
- The spiritual reference is hidden in plain sight — only those with eyes to see`,
  },
  {
    filename: 'logo-sp-5.png',
    prompt: `Design a premium logo for "ISAFlow" that embodies the concept of a cornerstone — the foundation everything is built upon.

ICON CONCEPT: An abstract cornerstone/keystone shape:
- A geometric shape that suggests a cornerstone block — perhaps a beveled rectangle or trapezoid
- From the cornerstone, subtle flowing lines extend outward like rays or branches — suggesting growth, an olive tree, or light radiating from a source
- The cornerstone anchors at the bottom, the growth extends upward — grounded yet ascending
- The overall silhouette is compact and balanced

COLORS:
- The cornerstone shape: deep teal #0d9488
- The flowing/radiating lines: lighter teal #14b8a6
- Wordmark "Isa" in #0d9488, "Flow" in #0f172a
- Pure white background

RULES:
- Horizontal: icon + wordmark
- Maximum 5 shapes total in the icon
- Premium, geometric, confident
- Reads as: foundation, growth, stability — a fintech you'd trust with your life savings
- The cornerstone reference is architectural, not obviously Biblical
- Pentagram/Landor quality`,
  },
  {
    filename: 'logo-sp-icon.png',
    prompt: `Design a premium app icon for "ISAFlow" — accounting software built on principles of faithful stewardship.

ICON:
- iOS-style rounded square (superellipse)
- Background: smooth gradient from deep teal #0d9488 (top-left) to warm teal #14b8a6 (bottom-right)
- White symbol centered on the gradient

SYMBOL CONCEPT: An abstract shape that combines:
1. An open book (two angled rectangles meeting at a spine) — the ledger
2. From the center spine, a single upward-flowing flame or leaf shape rises — suggesting life, spirit, growth
The book grounds it in accounting, the rising element elevates it. Together they form a shape like a chalice or cup overflowing — abundance.

The symbol should be BOLD, using thick white strokes/fills. Must read at 29x29px.
No thin lines, no complexity. 4-5 white shapes maximum.
Premium, Apple Design Award quality.`,
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
  console.log('ISAFlow Logo Generator v3 — Spiritual Undertones');
  console.log(`Generating ${LOGOS.length} logos...\n`);

  for (const logo of LOGOS) {
    await generateLogo(logo);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\nDone! Check public/landing/logo-sp-*.png');
}

main();
