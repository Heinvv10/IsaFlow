# IsaFlow Landing Page Redesign
**Date:** 2026-04-12  
**Status:** Approved for implementation

---

## Overview

Redesign the IsaFlow landing page (`pages/index.tsx`) to feel premium, cinematic, and globally scalable. The core upgrade is a full-screen video hero background (city sunrise sequence) with a glass-nav layout, paired with a streamlined page structure that cuts noise and drives conversion.

---

## 1. Hero Section

### Layout
- **Type:** Glass Nav + Centred Text (Option C)
- **Background:** Looping MP4 video — `/public/landing/IsaFlow Video.mp4`
- **Overlay:** Dark gradient vignette — top and bottom edges darken to ensure readability; sides allow the city and data river to show through
  - `background: linear-gradient(to bottom, rgba(5,10,15,0.85) 0%, rgba(5,10,15,0.5) 50%, rgba(5,10,15,0.9) 100%)`

### Video Implementation
- `<video autoPlay muted loop playsInline>` — silent, loops forever, no controls
- Positioned `absolute inset-0 w-full h-full object-cover`
- Falls back to static image (`/public/landing/seq2-1-midnight.png`) if video fails to load
- Video does NOT play on mobile — replaced with the static midnight city image

### Navigation
- Fixed top navbar with `backdrop-filter: blur(12px)` + `background: rgba(5,10,15,0.6)`
- `border-bottom: 1px solid rgba(255,255,255,0.08)`
- Logo: white version of IsaFlow logo (SVG)
- Nav links: Features, Pricing, Testimonials — white at 65% opacity, hover 100%
- CTA button: "Start Free Trial" — white text, `border: 1px solid rgba(255,255,255,0.3)`, hover fills white with dark text
- On scroll: navbar darkens slightly (`rgba(5,10,15,0.85)`)

### Hero Content (centred)
```
[small label]   Accounting Software
[h1]            Your finances,
                finally clear.
[subheadline]   Invoicing, bank reconciliation, tax compliance and payroll —
                everything your business needs in one platform.
[CTAs]          [Start Free Trial →]   [Watch Demo]
[trust line]    ✓ 14-day free trial  ·  ✓ No credit card  ·  ✓ Full tax compliance
```

- `h1`: white, 72–96px, font-weight 900, tight line-height (1.05)
- Subheadline: white at 60% opacity, 18–20px
- Primary CTA: white background, dark text, bold — `bg-white text-slate-900`
- Secondary CTA: ghost button — `border border-white/30 text-white`
- Trust line: small, white at 45% opacity — no hard "South Africa" reference; "Full tax compliance" is universal

### Global-First Language
- No "Built for South Africa" badge in the hero
- SARS/VAT specifics live in the Features section only
- All hero copy is universally applicable
- SA compliance detail lives as a feature bullet, not a headline

---

## 2. Trust Bar (new section)

Immediately below the hero fold. Light background (`bg-white`).

```
Trusted by businesses across South Africa
[Logo] [Logo] [Logo] [Logo] [Logo]
```

- 4–5 customer/partner logos, monochrome, muted
- Single line of text above logos
- If real logos aren't available, use placeholder blocks — do not fake logos

---

## 3. Stats Bar

Dark background (`bg-gray-900`). 3 bold numbers (not 4).

| Stat | Value | Label |
|------|-------|-------|
| 1 | R 2.4B+ | Transactions Processed |
| 2 | 500+ | Businesses |
| 3 | 30+ | Financial Reports |

- Font: extrabold, 48px white
- Label: small, gray-400
- Remove current 4th stat or consolidate

---

## 4. Feature Pillars (replaces 40-card grid)

4 core capabilities. Clean 4-column grid on desktop, 2-column on tablet, 1 on mobile.

| Pillar | Icon | Headline | One-liner |
|--------|------|----------|-----------|
| Invoicing | FileText | Get paid faster | Professional invoices, automated reminders, real-time AR tracking |
| Reconciliation | RefreshCw | Always reconciled | Connect your bank, match transactions automatically, close your books with confidence |
| Tax & Compliance | Shield | Stay compliant | VAT returns, tax submissions and audit trails — handled |
| AI-Powered | Zap | Work smarter | AI document capture, smart categorisation, anomaly detection |

- Section heading: "Everything you need. Nothing you don't."
- Cards: minimal — icon, title, one sentence. No borders on hover effects, just subtle shadow.
- Background: white

---

## 5. Feature Deep-Dives (trimmed from 8 to 3)

Keep only the 3 most differentiated features. Alternating left/right layout.

1. **Invoicing & AR** — real product screenshot, bullets on payment tracking, reminders, client portal
2. **Bank Reconciliation** — real product screenshot, bullets on multi-bank, auto-match, rules engine
3. **AI Document Capture** — real product screenshot, bullets on receipt scanning, smart categorisation, time saved

Remove: General Ledger, Tax Compliance, Analytics, Security, Migration deep-dives from this page. Move them to a `/features` page (future work).

Section background: alternates `bg-white` / `bg-gray-50`

---

## 6. Testimonials (upgraded)

Replace 3 equal-weight quotes with a hierarchy:

**Featured testimonial** (full width, dark bg):
- Large quote, customer name, title, company
- Specific metric: *"Saved us 8 hours a month on reconciliation"*
- Customer photo (circular) + company logo

**Two supporting quotes** (2-column below):
- Smaller cards, white bg, teal left-border accent

---

## 7. Pricing

Keep existing 3-tier structure. Minor visual cleanup:
- Remove `scale-[1.02]` on popular plan — use ring highlight instead
- Soften box shadow
- No currency changes (R pricing stays — easy to localise later)

---

## 8. FAQ

Trim from 8 to 5 most universally relevant questions:
1. Is there a free trial?
2. Can I import data from other software?
3. Which banks are supported?
4. Is my data secure?
5. Does it handle tax compliance?

Remove questions that are too SA-specific for the hero (e.g. CaseWare integration) — move to a support page.

---

## 9. Final CTA Section (new — currently missing)

Dark background, centred, bold. Before the footer.

```
Ready to take control of your finances?
Start your free 14-day trial today. No credit card required.

[Start Free Trial →]   [Book a Demo]
```

- Background: `bg-gray-900` or subtle gradient matching the hero
- Headline: white, 48px bold
- Single CTA cluster

---

## 10. Component File Plan

All changes within existing component files — no new files unless a section grows beyond 300 lines:

| File | Changes |
|------|---------|
| `LandingHero.tsx` | Full rewrite — video bg, glass nav, centred text |
| `LandingNavbar.tsx` | Absorb into LandingHero (glass nav is part of hero) or keep separate with transparency prop |
| `LandingFeatures.tsx` | Replace grid with 4 pillars + trim to 3 deep-dives |
| `LandingPricingTestimonialsFooter.tsx` | Upgrade testimonials, trim FAQ, add final CTA section |
| `landingData.ts` | Update copy — remove SA-specific hero text, update stats, trim features/FAQ |

---

## 11. What We Are NOT Changing

- Pricing tiers and amounts (R499 / R999 / R2499)
- Overall routing and page structure (`pages/index.tsx`)
- Footer content
- Mobile hamburger nav behaviour
- Any app pages (accounting/*, admin/*)

---

## Out of Scope (future work)

- `/features` full feature listing page
- `/demo` video demo page  
- Mobile video optimisation (static image fallback is sufficient for now)
- Localisation / currency switching for global expansion
- Animation/scroll effects beyond basic fade-ins
