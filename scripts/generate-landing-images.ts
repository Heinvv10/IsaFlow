/**
 * Generate landing page images using NanoBanana 2 Pro (Google Gemini Image API)
 *
 * Usage:
 *   GEMINI_API_KEY=your-key bun run scripts/generate-landing-images.ts
 *
 * This generates all images needed for the ISAFlow landing page
 * and saves them to public/landing/
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Error: GEMINI_API_KEY environment variable is required.');
  console.error('Get your key at: https://aistudio.google.com/apikey');
  console.error('Usage: GEMINI_API_KEY=your-key bun run scripts/generate-landing-images.ts');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'landing');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

interface ImagePrompt {
  filename: string;
  prompt: string;
}

const IMAGE_PROMPTS: ImagePrompt[] = [
  {
    filename: 'hero-dashboard.png',
    prompt: `Create a ultra-realistic screenshot mockup of a modern cloud accounting software dashboard. Dark theme with a slate-900 background. The dashboard shows:
- A top navigation bar with "ISAFlow" logo in teal color
- KPI stat cards showing Revenue (R 1,247,350), Expenses (R 892,100), Net Profit (R 355,250), and Cash Position (R 2.1M) with green/red trend arrows
- A large area chart showing monthly revenue vs expenses over 12 months in teal and gray colors
- A smaller pie chart showing expense breakdown by category
- A recent transactions table with bank reconciliation status indicators
- Clean, professional design with rounded corners, subtle shadows, and teal accent color
The design should look like a real SaaS product screenshot, polished and modern. 16:10 aspect ratio.`,
  },
  {
    filename: 'general-ledger.png',
    prompt: `Create a ultra-realistic screenshot mockup of a General Ledger / Chart of Accounts page in a modern accounting application. Dark theme (slate-900 background). Shows:
- A hierarchical tree view of accounts (Assets > Current Assets > Bank, Cash | Liabilities > Current Liabilities > Accounts Payable | Revenue > Sales | Expenses > Operating)
- Each account shows: account code (e.g., 1000, 1100), name, type badge, and balance in South African Rand (R)
- A journal entry form on the right side with debit/credit columns, balanced totals
- Teal accent colors for active items and buttons
- Professional, clean design like Xero or QuickBooks. 16:10 aspect ratio.`,
  },
  {
    filename: 'invoicing.png',
    prompt: `Create a ultra-realistic screenshot mockup of a customer invoice creation page in a modern accounting SaaS. Dark theme (slate-900 background). Shows:
- A professional invoice form with ISAFlow branding
- Customer details section (company name, VAT number, address)
- Line items table with Description, Qty, Unit Price, VAT (15%), Amount columns
- Three line items with realistic South African business items
- Subtotal, VAT (15%), and Total in South African Rand (R 45,750.00)
- Action buttons: Save Draft, Send Invoice (teal), Download PDF
- Status badge showing "Draft" in amber
- Clean, modern design with teal accents. 16:10 aspect ratio.`,
  },
  {
    filename: 'banking.png',
    prompt: `Create a ultra-realistic screenshot mockup of a bank reconciliation page in a modern accounting app. Dark theme (slate-900 background). Shows:
- A header showing "Bank Reconciliation - FNB Business Account" with statement balance vs GL balance comparison
- A transaction list with columns: Date, Description, Reference, Amount (R), Status, Allocation
- Mix of matched (green checkmark), unmatched (amber), and auto-categorised transactions
- Confidence score dots (green, amber) next to auto-suggested categorisations
- Smart categorisation suggestions showing "Woolworths" matched to "Office Supplies" with 95% confidence
- A side panel showing match candidates for a selected transaction
- Split transaction and Import Statement buttons
- Teal accent color, modern rounded design. 16:10 aspect ratio.`,
  },
  {
    filename: 'sars.png',
    prompt: `Create a ultra-realistic screenshot mockup of a SARS (South African Revenue Service) tax compliance dashboard in a modern accounting app. Dark theme (slate-900 background). Shows:
- VAT201 Return summary with Output VAT, Input VAT, and Net VAT payable amounts in Rands
- A compliance calendar showing upcoming deadlines (VAT201 Due, EMP201 Due) with status badges (upcoming in amber, submitted in green)
- SARS submission history table showing form type, period, status, submission date
- A VAT breakdown section showing: Standard (15%), Zero-Rated, Exempt, and DRC amounts
- "Generate VAT201" and "Submit to SARS" buttons in teal
- Professional, authoritative design suitable for tax compliance. 16:10 aspect ratio.`,
  },
];

async function generateImage(prompt: ImagePrompt): Promise<void> {
  const outputPath = path.join(OUTPUT_DIR, prompt.filename);

  // Skip if already exists
  if (fs.existsSync(outputPath)) {
    console.log(`  Skipping ${prompt.filename} (already exists)`);
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

    if (!response.candidates || response.candidates.length === 0) {
      console.error(`  Error: No candidates returned for ${prompt.filename}`);
      return;
    }

    const parts = response.candidates[0].content?.parts;
    if (!parts) {
      console.error(`  Error: No parts in response for ${prompt.filename}`);
      return;
    }

    let saved = false;
    for (const part of parts) {
      if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data!, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`  Saved ${prompt.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
        saved = true;
        break;
      }
    }

    if (!saved) {
      // Try text response for debugging
      for (const part of parts) {
        if (part.text) {
          console.log(`  Text response for ${prompt.filename}: ${part.text.substring(0, 200)}`);
        }
      }
      console.error(`  Error: No image data returned for ${prompt.filename}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Error generating ${prompt.filename}: ${message}`);
  }
}

async function main() {
  console.log('ISAFlow Landing Page Image Generator');
  console.log('Using NanoBanana 2 Pro (Gemini Image API)');
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Images to generate: ${IMAGE_PROMPTS.length}`);
  console.log('---');

  for (const prompt of IMAGE_PROMPTS) {
    await generateImage(prompt);
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('---');
  console.log('Done! Images saved to public/landing/');
  console.log('Run `bun run dev` to see the landing page.');
}

main();
