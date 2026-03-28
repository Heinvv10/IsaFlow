/**
 * Generate ISAFlow logo using NanoBanana 2 Pro (Google Gemini Image API)
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('GEMINI_API_KEY required');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'landing');

const LOGO_PROMPTS = [
  {
    filename: 'logo-v1.png',
    prompt: `Design a premium, modern logo for "ISAFlow" — a South African cloud accounting software company. The logo should be:

- A sleek, minimal icon/mark paired with the wordmark "ISAFlow"
- The icon should subtly represent financial flow, ledger, or accounting — think abstract flowing lines, a stylized book/ledger, or interconnected nodes suggesting data flow
- Color palette: deep teal (#0d9488) as the primary color with a gradient to cyan (#06b6d4), on a pure white background
- Typography: clean, geometric sans-serif font. "Isa" in teal, "Flow" in dark charcoal/black
- The overall feel should be: premium, trustworthy, modern, fintech — like a company worth millions
- High contrast, vector-quality crispness
- No tagline, no extra text — just the icon + "ISAFlow"
- Style reference: think Stripe, Xero, or Mercury bank logos — minimal, confident, expensive
- Square format, centered composition, generous whitespace
- The logo should work at both large and small sizes`,
  },
  {
    filename: 'logo-v2.png',
    prompt: `Create an ultra-premium logomark (icon only, no text) for "ISAFlow", a fintech accounting platform. Requirements:

- Abstract geometric mark that suggests financial flow, balance, and precision
- Could incorporate: stylized "I" or "IF" monogram, flowing curves, balanced scales abstracted into geometry, or a dynamic swoosh suggesting movement/flow
- Color: gradient from deep teal (#0d9488) to bright cyan (#06b6d4)
- Clean white background
- The mark should feel like it belongs on a $1 billion fintech company — think Stripe's gradient, Revolut's precision, or Square's simplicity
- Must be perfectly symmetrical or intentionally asymmetric in an elegant way
- Minimal, no more than 2-3 visual elements
- Would look stunning as an app icon, favicon, or embossed on a business card
- Square canvas, centered, generous padding`,
  },
  {
    filename: 'logo-v3.png',
    prompt: `Design a luxury fintech logo for "ISAFlow" — a premium South African accounting software platform. The design should be:

- A sophisticated combination mark: distinctive icon + "ISAFlow" wordmark side by side
- The icon: an elegant abstract representation of a flowing ledger or financial data stream — perhaps two curved parallel lines forming an abstract "S" shape that also suggests flow and balance, or a modernist book icon with dynamic energy
- Colors: rich teal (#0d9488) to emerald gradient for the icon. The word "Isa" in the same teal gradient, "Flow" in slate-900 (#0f172a)
- Typography: premium weight, slightly rounded geometric sans-serif — modern but warm
- White background, plenty of breathing room
- The aesthetic should scream "premium SaaS" — sophisticated, trustworthy, worth every penny
- Think: the elegance of Apple meets the trust of a Swiss bank
- Horizontal layout, centered vertically`,
  },
  {
    filename: 'logo-v4.png',
    prompt: `Create a stunning, award-winning logo for "ISAFlow" accounting software. Design brief:

- Concept: The letters "ISA" cleverly integrated with a flowing/dynamic element that transitions into "Flow"
- The icon element should be built from the negative space or letterforms themselves — smart, clever design that reveals itself on closer inspection
- Primary color: teal (#0d9488) with subtle gradient highlights
- Secondary: dark navy/charcoal (#1e293b) for the wordmark
- Pure white background
- Style: ultra-modern, Silicon Valley fintech quality — Notion-level design sophistication
- Should work as: full logo, icon-only mark, single-color version
- Perfectly balanced proportions with mathematical precision
- No decorative elements — every line and curve has purpose
- Horizontal format`,
  },
  {
    filename: 'logo-icon-v1.png',
    prompt: `Design a premium app icon for "ISAFlow" fintech accounting software:

- Square format with rounded corners (like an iOS app icon)
- Background: rich gradient from deep teal (#0d9488) to vibrant cyan (#06b6d4), slightly angled
- Icon: a white abstract symbol representing financial flow — could be a stylized abstract book/ledger with a dynamic flow line, or interlocking geometric shapes suggesting balance and movement
- The symbol should be bold, immediately recognizable at small sizes
- Ultra-clean, no text in the icon
- Premium feel — like it belongs next to the Stripe or Revolut app icons
- Subtle depth through soft shadow or gradient variation
- Perfectly centered with ideal padding ratio (about 20% from edges)`,
  },
];

async function generateLogo(prompt: { filename: string; prompt: string }) {
  const outputPath = path.join(OUTPUT_DIR, prompt.filename);
  if (fs.existsSync(outputPath)) {
    console.log(`  Skipping ${prompt.filename} (exists)`);
    return;
  }

  console.log(`  Generating ${prompt.filename}...`);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: prompt.prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) { console.error(`  No response for ${prompt.filename}`); return; }

    for (const part of parts) {
      if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data!, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`  Saved ${prompt.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
        return;
      }
    }
    console.error(`  No image data for ${prompt.filename}`);
  } catch (err: unknown) {
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log('ISAFlow Logo Generator — NanoBanana 2 Pro');
  console.log(`Generating ${LOGO_PROMPTS.length} logo variations...\n`);

  for (const prompt of LOGO_PROMPTS) {
    await generateLogo(prompt);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\nDone! Logos saved to public/landing/');
}

main();
