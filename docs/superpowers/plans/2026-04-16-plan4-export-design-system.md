# Plan 4 — Export & Design System (PDF, DOCX, WeasyPrint, Brand Profiles)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver production-grade export infrastructure for the AFS engine — PDF via WeasyPrint, DOCX via `docx`, brand profiles, image library, pre-export quality checks, and a proof-copy watermark workflow.

**Plans 1–3 assumed complete.** Types from Plan 1 live at `@/modules/accounting/services/afs/afsTypes.ts`.

**Architecture:** Four execution waves. Wave α lands database migrations and the brand profile + image library services (parallelisable). Wave β lands the HTML renderer and WeasyPrint integration (renderer must exist before PDF orchestration). Wave γ delivers the PDF, DOCX, and Caseware export services plus the pre-export quality check (renderer must be done). Wave δ wires up all API routes (all services must be done).

**Tech stack:** Next.js 14 · TypeScript (strict) · Neon Postgres (`sql` tagged templates) · Vitest · `docx` npm package (add via `bun add docx`). WeasyPrint runs as a Docker sidecar on velo (`http://weasyprint:5001`). Google Fonts inlined as base64 data URIs for offline PDF rendering.

**Spec:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` Sections 4, 4b, 4c.

**Autonomy envelope:** Wave α runs unattended (additive migrations, no breaking changes). Hard stop after α for human review of migration SQL. Waves β–δ run sequentially with controller review between each wave.

---

## Per-task workflow (applies to every task)

```
1. Create worktree: git worktree add ../isaflow-<TASK> master -b feat/<TASK>-<slug>
2. Read the relevant plan section + CLAUDE.md.
3. Write failing test first (RED) where tests are specified.
4. Run `bunx vitest run <test-path>` → confirm FAIL.
5. Implement minimum code to pass.
6. Run test → confirm PASS.
7. Run `bunx tsc --noEmit` → zero new errors.
8. Commit on branch with message: feat(afs-plan4): <summary>
9. Report diff + status to controller.
10. Controller rebases onto latest master, reviews diff + CLAUDE.md compliance,
    FF-merges, removes worktree, marks task complete.
```

**Migration numbers** start at **340** (332 is the last committed migration). Advance sequentially.

**Commit message template:** `feat(afs-plan4): <one-line summary>` followed by a brief body, ending with:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## File Inventory

### New files — Wave α (migrations + foundation services)
- `scripts/migrations/sql/340_brand_profiles.sql`
- `scripts/migrations/sql/341_afs_uploaded_images.sql`
- `src/modules/accounting/services/afs/brandProfileService.ts`
- `src/modules/accounting/services/afs/imageLibraryService.ts`
- `tests/unit/services/afs/brandProfileService.test.ts`

### New files — Wave β (HTML renderer + WeasyPrint)
- `src/modules/accounting/services/afs/afsHtmlRendererService.ts`
- `src/modules/accounting/services/afs/weasyprintService.ts`
- `tests/unit/services/afs/afsHtmlRendererService.test.ts`

### New files — Wave γ (export orchestration)
- `src/modules/accounting/services/afs/pdfExportService.ts`
- `src/modules/accounting/services/afs/docxExportService.ts`
- `src/modules/accounting/services/afs/casewareExportExtService.ts`

### New files — Wave δ (API routes)
- `pages/api/accounting/afs/[documentId]/export.ts`
- `pages/api/accounting/afs/brand-profile.ts`
- `pages/api/accounting/afs/images.ts`
- `pages/api/accounting/afs/images/[imageId].ts`
- `pages/api/accounting/afs/[documentId]/proof-copy.ts`

---

# WAVE α — Database migrations + foundation services

Tasks α.1 and α.2 (migrations) must land first and be reviewed. Tasks α.3 and α.4 (services) can run concurrently after migrations are applied.

---

## Task α.1 — Migration: brand_profiles table

**File:** `scripts/migrations/sql/340_brand_profiles.sql`

- [ ] **Step 1: Write migration**

```sql
-- Plan 4 / AFS Export — brand profile per company
CREATE TABLE IF NOT EXISTS brand_profiles (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  logo_url       TEXT,
  primary_colour VARCHAR(7)  NOT NULL DEFAULT '#1a3a5c',  -- hex e.g. '#1a3a5c'
  secondary_colour VARCHAR(7) NOT NULL DEFAULT '#c8a86b',
  font_family    VARCHAR(20) NOT NULL DEFAULT 'professional'
                               CHECK (font_family IN ('professional','modern','executive','bold')),
  cover_style    VARCHAR(10) NOT NULL DEFAULT 'classic'
                               CHECK (cover_style IN ('classic','modern','bold','minimal')),
  report_footer_text TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_profiles_company_unique UNIQUE (company_id)
);

CREATE INDEX IF NOT EXISTS brand_profiles_company_id_idx ON brand_profiles(company_id);
```

- [ ] **Step 2: Verify** — run `bun run migrate` (or equivalent migration runner) in dev. Confirm table exists with `\d brand_profiles` in psql.
- [ ] **Step 3: Commit** — `feat(afs-plan4): add 340_brand_profiles migration`

---

## Task α.2 — Migration: afs_uploaded_images table

**File:** `scripts/migrations/sql/341_afs_uploaded_images.sql`

- [ ] **Step 1: Write migration**

```sql
-- Plan 4 / AFS Export — image library per company
CREATE TABLE IF NOT EXISTS afs_uploaded_images (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename        TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  tag             VARCHAR(20) NOT NULL
                                CHECK (tag IN ('cover','section_divider','inline')),
  width_px        INT,
  height_px       INT,
  dpi             INT,
  low_res_warning BOOLEAN     NOT NULL DEFAULT FALSE,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS afs_uploaded_images_company_id_idx ON afs_uploaded_images(company_id);
CREATE INDEX IF NOT EXISTS afs_uploaded_images_tag_idx        ON afs_uploaded_images(company_id, tag);
```

Storage path convention: `/storage/afs-images/{companyId}/{filename}` on velo. `url` stores the public URL.

DPI check rule: if `dpi < 150`, set `low_res_warning = TRUE` at insert time. This feeds the pre-export quality check.

- [ ] **Step 2: Verify** — run migration, confirm table in psql.
- [ ] **Step 3: Commit** — `feat(afs-plan4): add 341_afs_uploaded_images migration`

---

## Task α.3 — brandProfileService.ts

**File:** `src/modules/accounting/services/afs/brandProfileService.ts`

**Depends on:** α.1 migration applied.

### Types (import from `@/modules/accounting/services/afs/afsTypes.ts`)

```typescript
export interface BrandProfile {
  id: string;
  companyId: string;
  logoUrl: string | null;
  primaryColour: string;    // hex e.g. '#1a3a5c'
  secondaryColour: string;
  fontFamily: 'professional' | 'modern' | 'executive' | 'bold';
  coverStyle: 'classic' | 'modern' | 'bold' | 'minimal';
  reportFooterText: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type UpsertBrandProfileInput = Omit<BrandProfile, 'id' | 'companyId' | 'createdAt' | 'updatedAt'>;
```

### Implementation requirements

- `getBrandProfile(companyId: string): Promise<BrandProfile | null>` — SELECT by company_id. Returns null if not yet set.
- `upsertBrandProfile(companyId: string, input: UpsertBrandProfileInput): Promise<BrandProfile>` — INSERT ... ON CONFLICT (company_id) DO UPDATE SET ... Returns the upserted row.
- Validate `primaryColour` and `secondaryColour` are valid 7-char hex strings (`/^#[0-9a-fA-F]{6}$/`). Throw `new Error('Invalid hex colour: ...')` on failure.
- Use `sql` tagged template from `@/lib/neon`. Never string concatenation.
- Use `log` from `@/lib/logger`. Never `console.log`.
- Map DB snake_case → camelCase in a private `mapRow(row)` helper.
- File must be ≤ 300 lines.

- [ ] **Step 1: Write failing test** (`tests/unit/services/afs/brandProfileService.test.ts` — see Task α.3-T below)
- [ ] **Step 2: Run test → RED**
- [ ] **Step 3: Implement service**
- [ ] **Step 4: Run test → GREEN**
- [ ] **Step 5: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 6: Commit** — `feat(afs-plan4): brandProfileService CRUD`

### Task α.3-T — Test file

**File:** `tests/unit/services/afs/brandProfileService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getBrandProfile, upsertBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'test-company-uuid';

const DB_ROW = {
  id: 'brand-uuid',
  company_id: COMPANY_ID,
  logo_url: 'https://cdn.example.com/logo.png',
  primary_colour: '#1a3a5c',
  secondary_colour: '#c8a86b',
  font_family: 'professional',
  cover_style: 'classic',
  report_footer_text: 'Prepared by Test Firm',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('brandProfileService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('getBrandProfile', () => {
    it('returns null when no profile exists', async () => {
      mockSql.mockResolvedValueOnce([]);
      const result = await getBrandProfile(COMPANY_ID);
      expect(result).toBeNull();
    });

    it('returns mapped profile when row exists', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);
      const result = await getBrandProfile(COMPANY_ID);
      expect(result).not.toBeNull();
      expect(result!.companyId).toBe(COMPANY_ID);
      expect(result!.primaryColour).toBe('#1a3a5c');
      expect(result!.fontFamily).toBe('professional');
      expect(result!.coverStyle).toBe('classic');
    });
  });

  describe('upsertBrandProfile', () => {
    it('returns the upserted profile', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);
      const result = await upsertBrandProfile(COMPANY_ID, {
        logoUrl: 'https://cdn.example.com/logo.png',
        primaryColour: '#1a3a5c',
        secondaryColour: '#c8a86b',
        fontFamily: 'professional',
        coverStyle: 'classic',
        reportFooterText: 'Prepared by Test Firm',
      });
      expect(result.id).toBe('brand-uuid');
      expect(result.primaryColour).toBe('#1a3a5c');
    });

    it('throws on invalid primary hex colour', async () => {
      await expect(
        upsertBrandProfile(COMPANY_ID, {
          logoUrl: null,
          primaryColour: 'not-a-hex',
          secondaryColour: '#ffffff',
          fontFamily: 'modern',
          coverStyle: 'minimal',
          reportFooterText: null,
        })
      ).rejects.toThrow(/Invalid hex colour/);
    });

    it('throws on invalid secondary hex colour', async () => {
      await expect(
        upsertBrandProfile(COMPANY_ID, {
          logoUrl: null,
          primaryColour: '#ffffff',
          secondaryColour: '#GGGGGG',
          fontFamily: 'bold',
          coverStyle: 'bold',
          reportFooterText: null,
        })
      ).rejects.toThrow(/Invalid hex colour/);
    });
  });
});
```

---

## Task α.4 — imageLibraryService.ts

**File:** `src/modules/accounting/services/afs/imageLibraryService.ts`

**Depends on:** α.2 migration applied.

### Types

```typescript
export interface AfsUploadedImage {
  id: string;
  companyId: string;
  filename: string;
  url: string;
  tag: 'cover' | 'section_divider' | 'inline';
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  lowResWarning: boolean;
  uploadedAt: Date | string;
}

export interface CreateImageInput {
  filename: string;
  url: string;
  tag: 'cover' | 'section_divider' | 'inline';
  widthPx?: number;
  heightPx?: number;
  dpi?: number;
}
```

### Functions to implement

- `listImages(companyId: string, tag?: AfsUploadedImage['tag']): Promise<AfsUploadedImage[]>` — SELECT all for company, optionally filtered by tag. Order by `uploaded_at DESC`.
- `createImage(companyId: string, input: CreateImageInput): Promise<AfsUploadedImage>` — INSERT. Compute `low_res_warning = (dpi !== undefined && dpi < 150)`. Return created row.
- `deleteImage(companyId: string, imageId: string): Promise<void>` — DELETE WHERE id = $1 AND company_id = $2 (tenant-scoped). Throw `new Error('Image not found')` if 0 rows affected.

Rules: `sql` tagged template, `log` logger, snake_case → camelCase mapper, ≤ 300 lines.

- [ ] **Step 1: Implement service** (no dedicated test file specified — covered by API route integration)
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): imageLibraryService upload/list/delete`

---

# WAVE β — HTML renderer + WeasyPrint integration

Tasks β.1 and β.2 can run concurrently. Both must complete before Wave γ starts.

---

## Task β.1 — afsHtmlRendererService.ts

**File:** `src/modules/accounting/services/afs/afsHtmlRendererService.ts`

**Depends on:** Types from `afsTypes.ts` (Plan 1). Brand profile type from α.3.

### Purpose

Single source of truth for the AFS visual output. Renders an `AfsDocument` + its `AfsSection[]` + a `BrandProfile` into a complete HTML string. The same HTML is used for:
1. The in-app web preview (served directly)
2. WeasyPrint PDF input
3. Proof-copy watermarked variant

### CSS print rules to embed (hardcoded in the renderer)

```css
@page {
  size: A4 portrait;
  margin: 20mm 20mm 20mm 25mm;
  @bottom-right { content: counter(page); }
  @bottom-left  { content: string(company-name); }
}
@page:first { margin: 0; }   /* cover page — full bleed */
tr    { break-inside: avoid; }
thead { display: table-header-group; }
.note-heading { break-after: avoid; }
p     { widows: 2; orphans: 2; }
.section-start { break-before: right; }
@page landscape { size: A4 landscape; }
.wide-table { page: landscape; }
```

### Font pairs — embed via `@font-face` with base64 data URIs

For PDF rendering WeasyPrint fetches no external URLs — fonts MUST be inlined.

| `fontFamily` value | Heading font | Body font |
|--------------------|-------------|-----------|
| `professional`     | Playfair Display | Source Serif Pro |
| `modern`           | Inter | Inter |
| `executive`        | Cormorant Garamond | Lato |
| `bold`             | Montserrat | Open Sans |

Implementation pattern: maintain a `FONT_DATA` map keyed by `fontFamily`. Each entry holds base64-encoded WOFF2 strings. For the plan implementation, the service should accept an optional `fontsBase64Map` parameter (to allow injection in tests) — in production, fonts are loaded from `/public/fonts/` at startup and cached in module scope.

### Cover page templates — all 4 styles

The renderer must emit one of the following cover `<div>` structures based on `brandProfile.coverStyle`:

**classic** — full-bleed background photo, dark overlay, centred white text:
```html
<div class="cover-page cover-classic" style="background-image:url({{coverPhotoUrl}})">
  <div class="cover-overlay"></div>
  <div class="cover-logo"><img src="{{logoUrl}}" alt="Company logo"/></div>
  <h1 class="cover-title">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended {{periodEnd}}</p>
  <p class="cover-company">{{companyName}}</p>
  <p class="cover-reg">Registration No: {{registrationNumber}}</p>
</div>
```

**modern** — split layout: primary-colour panel left (40%), photo right (60%), title on semi-transparent strip:
```html
<div class="cover-page cover-modern">
  <div class="cover-panel" style="background:{{primaryColour}}">
    <div class="cover-logo"><img src="{{logoUrl}}" alt="Company logo"/></div>
    <h1 class="cover-title">Annual Financial Statements</h1>
    <p class="cover-period">For the year ended {{periodEnd}}</p>
    <p class="cover-company">{{companyName}}</p>
    <p class="cover-reg">Registration No: {{registrationNumber}}</p>
  </div>
  <div class="cover-photo" style="background-image:url({{coverPhotoUrl}})"></div>
</div>
```

**bold** — full primary-colour cover, geometric SVG pattern, no photo:
```html
<div class="cover-page cover-bold" style="background:{{primaryColour}}">
  <svg class="cover-geo" ...><!-- geometric pattern --></svg>
  <div class="cover-logo"><img src="{{logoUrl}}" alt="Company logo"/></div>
  <h1 class="cover-title" style="color:#ffffff">Annual Financial Statements</h1>
  <p class="cover-period" style="color:{{secondaryColour}}">For the year ended {{periodEnd}}</p>
  <p class="cover-company" style="color:#ffffff">{{companyName}}</p>
  <p class="cover-reg" style="color:#ffffff">Registration No: {{registrationNumber}}</p>
</div>
```

**minimal** — white cover, centred logo, thin rule, clean typography:
```html
<div class="cover-page cover-minimal">
  <div class="cover-logo"><img src="{{logoUrl}}" alt="Company logo"/></div>
  <hr class="cover-rule" style="border-color:{{primaryColour}}"/>
  <h1 class="cover-title" style="color:{{primaryColour}}">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended {{periodEnd}}</p>
  <p class="cover-company">{{companyName}}</p>
  <p class="cover-reg">Registration No: {{registrationNumber}}</p>
</div>
```

### Table design rules (apply to all rendered tables)

- Header row: `background: primaryColour; color: #ffffff; font-weight: bold;`
- Subtotal rows: class `row-subtotal` — light tint of primary colour, bold
- Total rows: class `row-total` — `background: primaryColour; color: #ffffff; font-weight: bold;`
- Alternating row shading: even rows `background: #f7f7f7`
- Numbers: right-aligned, `font-family: monospace`, negative numbers in brackets e.g. `(15 000)`
- Currency symbol once in column header (e.g. `R'000`), not per row
- No vertical borders — horizontal rules only

### Public API

```typescript
export interface RenderOptions {
  watermark?: 'DRAFT — NOT FOR DISTRIBUTION';
  fontsBase64Map?: Record<string, string>; // injected in tests
}

export interface AfsRenderContext {
  document: AfsDocument;
  sections: AfsSection[];
  brandProfile: BrandProfile;
  companyName: string;
  registrationNumber: string;
  coverPhotoUrl?: string;
}

export function renderAfsToHtml(
  context: AfsRenderContext,
  options?: RenderOptions
): string;
```

### Proof-copy watermark

When `options.watermark` is set, inject a fixed-position overlay across every page:
```html
<div class="watermark">DRAFT — NOT FOR DISTRIBUTION</div>
```
```css
.watermark {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-35deg);
  font-size: 48px;
  color: rgba(180, 0, 0, 0.18);
  white-space: nowrap;
  pointer-events: none;
  z-index: 9999;
}
```

### NoteContent section renderer

For each `AfsSection`, render its `content` JSONB (type `NoteContent` from Plan 1) into HTML:
- `paragraph` → `<p>`
- `heading` level 2 → `<h2 class="note-heading">`, level 3 → `<h3 class="note-heading">`
- `list` → `<ul><li>` per item
- `table` → `<table class="financial-table">` with `<thead>`, `<tbody>`, applying table design rules above

### File structure constraint

≤ 300 lines. Split into: `afsHtmlRendererService.ts` (orchestrator) + `afsHtmlCoverTemplates.ts` (cover HTML templates) + `afsHtmlTableRenderer.ts` (table renderer) if needed to stay under limit.

- [ ] **Step 1: Write failing tests** (Task β.1-T below)
- [ ] **Step 2: Run → RED**
- [ ] **Step 3: Implement renderer** (split files if > 300 lines each)
- [ ] **Step 4: Run → GREEN**
- [ ] **Step 5: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 6: Commit** — `feat(afs-plan4): afsHtmlRendererService with 4 cover styles`

### Task β.1-T — Test file

**File:** `tests/unit/services/afs/afsHtmlRendererService.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { renderAfsToHtml } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, AfsSection, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

const BRAND_PROFILE: BrandProfile = {
  id: 'bp-1',
  companyId: 'co-1',
  logoUrl: 'https://cdn.example.com/logo.png',
  primaryColour: '#1a3a5c',
  secondaryColour: '#c8a86b',
  fontFamily: 'professional',
  coverStyle: 'classic',
  reportFooterText: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DOCUMENT: AfsDocument = {
  id: 'doc-1',
  companyId: 'co-1',
  fiscalYear: 2025,
  documentType: 'afs',
  reportingFramework: 'ifrs_smes',
  status: 'draft',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as AfsDocument; // cast — remaining fields nullable

const SECTION_WITH_TABLE: AfsSection = {
  id: 'sec-1',
  documentId: 'doc-1',
  sectionType: 'note_trade_receivables',
  status: 'auto_generated',
  content: {
    title: 'Trade Receivables',
    blocks: [
      { type: 'heading', text: '10. Trade Receivables', level: 2 },
      { type: 'paragraph', text: 'Trade receivables are recognised at fair value.' },
      {
        type: 'table',
        headers: ["Description", "2025 R'000", "2024 R'000"],
        rows: [
          ['Trade debtors', '1 200', '980'],
          ['Less: allowance for impairment', '(50)', '(30)'],
          ['Net trade receivables', '1 150', '950'],
        ],
      },
    ],
  },
} as unknown as AfsSection;

const CTX: AfsRenderContext = {
  document: DOCUMENT,
  sections: [SECTION_WITH_TABLE],
  brandProfile: BRAND_PROFILE,
  companyName: 'Test Company (Pty) Ltd',
  registrationNumber: '2020/123456/07',
  coverPhotoUrl: 'https://cdn.example.com/cover.jpg',
};

describe('renderAfsToHtml', () => {
  it('returns a non-empty HTML string', () => {
    const html = renderAfsToHtml(CTX);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('includes company name in output', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('Test Company (Pty) Ltd');
  });

  it('includes classic cover elements', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('cover-classic');
    expect(html).toContain('cover-overlay');
  });

  it('renders modern cover when coverStyle is modern', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'modern' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-modern');
    expect(html).toContain('cover-panel');
  });

  it('renders bold cover when coverStyle is bold', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'bold' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-bold');
  });

  it('renders minimal cover when coverStyle is minimal', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'minimal' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-minimal');
    expect(html).toContain('cover-rule');
  });

  it('renders table with correct structure', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('financial-table');
    expect(html).toContain('Trade Receivables');
    expect(html).toContain('Trade debtors');
  });

  it('injects watermark when option is set', () => {
    const html = renderAfsToHtml(CTX, { watermark: 'DRAFT — NOT FOR DISTRIBUTION' });
    expect(html).toContain('DRAFT — NOT FOR DISTRIBUTION');
    expect(html).toContain('class="watermark"');
  });

  it('does not include watermark by default', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).not.toContain('class="watermark"');
  });

  it('embeds CSS print rules', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('widows: 2');
  });

  it('note headings use note-heading class', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('class="note-heading"');
    expect(html).toContain('10. Trade Receivables');
  });
});
```

---

## Task β.2 — weasyprintService.ts

**File:** `src/modules/accounting/services/afs/weasyprintService.ts`

**Depends on:** `WEASYPRINT_URL` env var configured.

### Purpose

Thin HTTP wrapper around the WeasyPrint Docker sidecar. Converts an HTML string to a PDF buffer.

### Implementation

```typescript
import { log } from '@/lib/logger';

export interface WeasyprintOptions {
  pdfVariant?: 'pdf/a-3u';
}

export async function htmlToPdf(
  html: string,
  options?: WeasyprintOptions
): Promise<Buffer> {
  const url = process.env.WEASYPRINT_URL;
  if (!url) throw new Error('WEASYPRINT_URL environment variable is not set');

  log.info('Calling WeasyPrint sidecar', { htmlLength: html.length }, 'weasyprintService');

  const response = await fetch(`${url}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, options }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error('WeasyPrint error', { status: response.status, body }, 'weasyprintService');
    throw new Error(`WeasyPrint error: ${response.status} ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  log.info('WeasyPrint PDF generated', { bytes: arrayBuffer.byteLength }, 'weasyprintService');
  return Buffer.from(arrayBuffer);
}
```

### Docker setup documentation (add as JSDoc at top of file)

```
WeasyPrint Docker sidecar setup on velo:
  docker run -d \
    --name weasyprint \
    --restart unless-stopped \
    -p 5001:5001 \
    ghcr.io/funkyfuture/weasyprint:latest

Set WEASYPRINT_URL=http://weasyprint:5001 in .env.local (dev)
and in the systemd service environment for production.

To verify: curl -X POST http://localhost:5001/pdf \
  -H 'Content-Type: application/json' \
  -d '{"html":"<h1>Test</h1>"}' --output test.pdf
```

- [ ] **Step 1: Implement service** (no unit test — WeasyPrint is an external process; covered by E2E)
- [ ] **Step 2: Add `WEASYPRINT_URL=` to `.env.local` example**
- [ ] **Step 3: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 4: Commit** — `feat(afs-plan4): weasyprintService HTTP wrapper`

---

# WAVE γ — Export orchestration

Tasks γ.1 (PDF), γ.2 (DOCX), and γ.3 (Caseware extension) can run concurrently. All depend on Wave β being complete.

---

## Task γ.1 — pdfExportService.ts + pre-export quality checks

**File:** `src/modules/accounting/services/afs/pdfExportService.ts`

**Depends on:** `afsHtmlRendererService`, `weasyprintService`, `brandProfileService`, `imageLibraryService`.

### Pre-export quality check types and function

Define inside `pdfExportService.ts`:

```typescript
export interface ExportCheck {
  label: string;
  passed: boolean;
  severity: 'blocker' | 'warning';
  detail?: string;
}

export async function runPreExportChecks(
  documentId: string,
  companyId: string
): Promise<ExportCheck[]>
```

**Blocker checks** (prevent export):
1. `'Balance sheet balances (Assets = Liabilities + Equity)'` — query `afs_sections` for the balance sheet section, verify `data_snapshot.totalAssets ≈ data_snapshot.totalLiabilities + data_snapshot.totalEquity` (tolerance: 0.01).
2. `'Closing cash equals bank balance'` — query `afs_sections` for cash flow section, compare `data_snapshot.closingCash` to `data_snapshot.bankBalance`.
3. `'All mandatory notes present'` — query `note_templates` for mandatory notes for the document's framework, verify each has a corresponding `afs_sections` row with status ≠ `'pending'`.

**Warning checks** (warn but allow export with confirmation):
4. `'Comparative figures present'` — check that all primary statement sections have prior-year columns in `data_snapshot`.
5. `'All notes reviewed'` — check all `afs_sections` have status `'reviewed'` or `'signed_off'`.
6. `'Images below 150 DPI'` — query `afs_uploaded_images` for `company_id` where `low_res_warning = TRUE`.
7. `"Director's Report approved"` — check the Director's Report section status is `'signed_off'`.

### Main export function

```typescript
export interface PdfExportOptions {
  watermark?: 'DRAFT — NOT FOR DISTRIBUTION';
  skipChecks?: boolean; // proof copies bypass blocker checks
}

export async function exportToPdf(
  documentId: string,
  companyId: string,
  options?: PdfExportOptions
): Promise<Buffer>
```

Orchestration:
1. Load `AfsDocument` from DB (must belong to `companyId` — tenant-scoped query).
2. Load all `AfsSection[]` for the document.
3. Load `BrandProfile` via `getBrandProfile(companyId)` — use sensible defaults if null.
4. Unless `options.skipChecks`, run `runPreExportChecks`. If any blocker `passed === false`, throw `new Error('Export blocked: ' + failedBlockers.map(c => c.label).join(', '))`.
5. Build `AfsRenderContext` (company name + registration number fetched from `companies` table).
6. Call `renderAfsToHtml(context, { watermark: options.watermark })`.
7. Call `htmlToPdf(html)` and return the Buffer.

All DB queries use `sql` tagged template, always include `company_id`. Log each step with `log.info`.

- [ ] **Step 1: Implement service** (≤ 300 lines; split pre-export checks into `afsPreExportChecks.ts` if needed)
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): pdfExportService + pre-export quality checks`

---

## Task γ.2 — docxExportService.ts

**File:** `src/modules/accounting/services/afs/docxExportService.ts`

**Depends on:** `bun add docx` installed, `afsTypes.ts`.

### Install dependency

```bash
bun add docx
```

### Key DOCX patterns

```typescript
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  WidthType,
} from 'docx';
import type { AfsDocument, AfsSection } from '@/modules/accounting/services/afs/afsTypes';
```

### Named paragraph styles to apply (no direct formatting)

Define in the `Document` styles array:
- `Heading1` — section title
- `Heading2` — note heading (maps to `heading` level 2 blocks)
- `Heading3` — sub-heading (maps to `heading` level 3 blocks)
- `BodyText` — body text (maps to `paragraph` blocks)
- `TableHeader` — table header cells
- `NoteNumber` — note number prefix

### Table quality rules for DOCX

- `keepRows: true` on all financial `Table` instances
- `tableHeader: true` on all `TableRow` header rows (repeat on continuation pages)
- Financial table columns in protected content controls (use `TableCell` with lock)
- No vertical borders on `TableCell` — set `border: { top/bottom only }`

### Public API

```typescript
export async function renderToDocx(
  document: AfsDocument,
  sections: AfsSection[],
  companyName: string
): Promise<Buffer>
```

Mirrors the PDF document structure:
1. Cover page paragraph
2. Table of contents placeholder paragraph (`"[Table of Contents — update fields in Word]"`)
3. Director's Report section
4. Each statement section
5. Notes 1–N

- [ ] **Step 1: `bun add docx`**
- [ ] **Step 2: Implement service** (≤ 300 lines; split `docxTableRenderer.ts` if needed)
- [ ] **Step 3: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 4: Commit** — `feat(afs-plan4): docxExportService DOCX generation`

---

## Task γ.3 — casewareExportExtService.ts

**File:** `src/modules/accounting/services/afs/casewareExportExtService.ts`

**Depends on:** Existing `casewareExportService.ts` (locate via Glob `**/casewareExport*`).

### Purpose

Extend the existing Caseware export with the full AFS package:
- Trial balance CSV (Caseware account code mapping)
- Journal entries file
- Fixed asset register
- AR/AP aging schedules
- Bank reconciliation summary
- **New:** AFS document metadata JSON (document status, sections, sign-off dates)
- Manifest file listing all included files
- XBRL/CIPC taxonomy pre-linked fields JSON

### Public API

```typescript
export interface CasewarePackage {
  files: Array<{ name: string; content: Buffer | string; mimeType: string }>;
  manifest: string; // CSV listing all files
}

export async function buildFullCasewarePackage(
  documentId: string,
  companyId: string
): Promise<CasewarePackage>
```

All files assembled in memory — no temp files on disk. Caller streams the result as a ZIP (use `jszip` if available, else a tar-like format). If `jszip` not installed, return individual files and document the zip step in the API route.

- [ ] **Step 1: Locate existing caseware service and import its functions**
- [ ] **Step 2: Implement extension service** (≤ 300 lines)
- [ ] **Step 3: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 4: Commit** — `feat(afs-plan4): casewareExportExtService full AFS package`

---

# WAVE δ — API routes

All five routes can be implemented concurrently. All depend on Wave γ being complete.

**Standard API handler pattern** (from `balance-sheet-export.ts`):
```typescript
export default withCompany(withErrorHandler(handler as any));
```

Import auth from `@/lib/auth`: `withCompany`, `CompanyApiRequest`.

---

## Task δ.1 — GET /api/accounting/afs/[documentId]/export

**File:** `pages/api/accounting/afs/[documentId]/export.ts`

**Query params:** `format=pdf|docx|caseware` (required)

```typescript
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const { documentId } = req.query as { documentId: string };
  const format = req.query.format as string;

  if (!['pdf', 'docx', 'caseware'].includes(format)) {
    return apiResponse.badRequest(res, 'format must be pdf, docx, or caseware');
  }

  try {
    if (format === 'pdf') {
      const buffer = await exportToPdf(documentId, companyId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="afs-${documentId}.pdf"`);
      return res.status(200).send(buffer);
    }

    if (format === 'docx') {
      // load document + sections, then renderToDocx
      const buffer = await /* orchestrate */ renderToDocx(...);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="afs-${documentId}.docx"`);
      return res.status(200).send(buffer);
    }

    if (format === 'caseware') {
      const pkg = await buildFullCasewarePackage(documentId, companyId);
      // Stream as JSON manifest + files (or ZIP if jszip available)
      return apiResponse.success(res, pkg.files.map(f => ({ name: f.name, size: (f.content as Buffer).length })));
    }
  } catch (err) {
    log.error('Export failed', { error: err, format, documentId }, 'afs-export-api');
    if (err instanceof Error && err.message.startsWith('Export blocked')) {
      return apiResponse.badRequest(res, err.message);
    }
    return apiResponse.internalError(res, err);
  }
}

export default withCompany(withErrorHandler(handler as any));
```

- [ ] **Step 1: Implement route**
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): export API route pdf|docx|caseware`

---

## Task δ.2 — GET/PUT /api/accounting/afs/brand-profile

**File:** `pages/api/accounting/afs/brand-profile.ts`

- `GET` — returns `getBrandProfile(companyId)` or `null` (200 in both cases)
- `PUT` — validates body, calls `upsertBrandProfile(companyId, body)`, returns 200

Validation on PUT: all fields present, `primaryColour`/`secondaryColour` match `/^#[0-9a-fA-F]{6}$/`, `fontFamily` in enum, `coverStyle` in enum.

```typescript
if (req.method === 'GET') {
  const profile = await getBrandProfile(companyId);
  return apiResponse.success(res, profile);
}

if (req.method === 'PUT') {
  const { primaryColour, secondaryColour, fontFamily, coverStyle, logoUrl, reportFooterText } = req.body;
  // validate ...
  const profile = await upsertBrandProfile(companyId, { primaryColour, secondaryColour, fontFamily, coverStyle, logoUrl: logoUrl ?? null, reportFooterText: reportFooterText ?? null });
  return apiResponse.success(res, profile);
}

return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
```

- [ ] **Step 1: Implement route**
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): brand-profile GET/PUT API route`

---

## Task δ.3 — GET/POST /api/accounting/afs/images

**File:** `pages/api/accounting/afs/images.ts`

- `GET` — optional `?tag=cover|section_divider|inline`. Returns `listImages(companyId, tag)`.
- `POST` — multipart upload. Parse file from `req` (use `formidable` or `multer` — check what is already installed in the project). Save to `/storage/afs-images/{companyId}/{uuid}-{filename}`. Determine DPI from image metadata (use `sharp` if available, else store `null`). Call `createImage(companyId, { filename, url, tag, widthPx, heightPx, dpi })`. Return created record.

DPI check: if `dpi !== null && dpi < 150`, the service sets `lowResWarning: true` automatically.

```typescript
if (req.method === 'GET') {
  const tag = req.query.tag as AfsUploadedImage['tag'] | undefined;
  const images = await listImages(companyId, tag);
  return apiResponse.success(res, images);
}

if (req.method === 'POST') {
  // parse multipart, save file, create DB record
  const image = await createImage(companyId, { ... });
  return apiResponse.created(res, image, 'Image uploaded');
}
```

**Note:** Disable Next.js body parser for this route:
```typescript
export const config = { api: { bodyParser: false } };
```

- [ ] **Step 1: Check which multipart/image library is already installed** (`bun pm ls`)
- [ ] **Step 2: Implement route** (install missing deps only if truly absent)
- [ ] **Step 3: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 4: Commit** — `feat(afs-plan4): images GET/POST upload API route`

---

## Task δ.4 — DELETE /api/accounting/afs/images/[imageId]

**File:** `pages/api/accounting/afs/images/[imageId].ts`

- `DELETE` — calls `deleteImage(companyId, imageId)`. Returns 204.
- Tenant-scoped: service already enforces `company_id` in DELETE.

```typescript
if (req.method === 'DELETE') {
  try {
    await deleteImage(companyId, imageId);
    return apiResponse.noContent(res);
  } catch (err) {
    if (err instanceof Error && err.message === 'Image not found') {
      return apiResponse.notFound(res, 'Image', imageId);
    }
    throw err;
  }
}
return apiResponse.methodNotAllowed(res, req.method!, ['DELETE']);
```

- [ ] **Step 1: Implement route**
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): images DELETE API route`

---

## Task δ.5 — GET /api/accounting/afs/[documentId]/proof-copy

**File:** `pages/api/accounting/afs/[documentId]/proof-copy.ts`

Returns a watermarked PDF for draft review. Calls `exportToPdf(documentId, companyId, { watermark: 'DRAFT — NOT FOR DISTRIBUTION', skipChecks: true })`.

```typescript
if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

const { companyId } = req as CompanyApiRequest;
const { documentId } = req.query as { documentId: string };

try {
  const buffer = await exportToPdf(documentId, companyId, {
    watermark: 'DRAFT — NOT FOR DISTRIBUTION',
    skipChecks: true,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="proof-${documentId}.pdf"`);
  return res.status(200).send(buffer);
} catch (err) {
  log.error('Proof copy failed', { error: err, documentId }, 'afs-proof-api');
  return apiResponse.internalError(res, err);
}
```

`inline` disposition (not `attachment`) opens in browser PDF viewer for review.

- [ ] **Step 1: Implement route**
- [ ] **Step 2: `bunx tsc --noEmit` → 0 errors**
- [ ] **Step 3: Commit** — `feat(afs-plan4): proof-copy watermarked PDF API route`

---

# Final checklist — before marking Plan 4 complete

- [ ] All 5 migration files applied in dev (`340`, `341`)
- [ ] `bun run test:unit` → all new tests green, no regressions
- [ ] `bunx tsc --noEmit` → 0 errors project-wide
- [ ] `WEASYPRINT_URL` documented in `.env.local.example`
- [ ] WeasyPrint Docker start command documented (in `weasyprintService.ts` JSDoc)
- [ ] `bun add docx` committed to `package.json` + `bun.lockb`
- [ ] All new services ≤ 300 lines each
- [ ] No `console.log` anywhere — only `log` from `@/lib/logger`
- [ ] No empty `catch` blocks
- [ ] No string concatenation in SQL — only `sql` tagged template
- [ ] Every DB query includes `company_id` (tenant isolation)
- [ ] All new API routes wrapped in `withCompany(withErrorHandler(handler as any))`
- [ ] Nav entries added if any new UI pages were added (none in this plan — export-only)

---

*Plan written: 2026-04-16 | Spec: Section 4, 4b, 4c of financial-reporting-afs-design.md | Migrations: 340–341 | Services: 7 new | API routes: 5 new | Tests: 2 new test files*
