# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing light-themed landing page with a premium cinematic redesign featuring a full-screen video hero, glass navbar, and a streamlined page structure.

**Architecture:** Five component files are modified in sequence (data → navbar → hero → features → pricing/testimonials). No new files are created. The video (`/public/landing/IsaFlow Video.mp4`) is the centrepiece — it plays silently on loop behind a dark gradient overlay with all text centred on top.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, Lucide React, bun

---

## File Map

| File | What Changes |
|------|-------------|
| `src/components/landing/landingData.ts` | New STATS (3), new FEATURE_PILLARS, trim DETAILED_FEATURES to 3, update TESTIMONIALS shape, trim FAQ to 5, add TRUST_COMPANIES |
| `src/components/landing/LandingNavbar.tsx` | Glass dark style — always dark/blur, not transparent-to-white |
| `src/components/landing/LandingHero.tsx` | Full rewrite — video bg, dark overlay, centred text, no split layout |
| `src/components/landing/LandingFeatures.tsx` | Replace 40-card grid with 4 pillars; trim deep-dives from 8 to 3 |
| `src/components/landing/LandingPricingTestimonialsFooter.tsx` | Add trust bar, upgrade testimonials hierarchy, trim FAQ, fix pricing card scale, add closing CTA |
| `pages/index.tsx` | Update `<title>` and meta description only |

---

## Task 1: Update landingData.ts

**Files:**
- Modify: `src/components/landing/landingData.ts`

- [ ] **Step 1: Replace STATS with 3-item version and add FEATURE_PILLARS + TRUST_COMPANIES**

Replace the entire file content with:

```typescript
/**
 * Landing page static data arrays.
 * Separated to keep page shell and section components lean.
 */

import {
  FileText, RefreshCw, Shield, Zap,
  Receipt, Landmark, Brain,
  Check, Star,
} from 'lucide-react';

export { Check, Star };

export const APP_URL = 'https://app.isaflow.co.za';

export const STATS = [
  { value: 'R 2.4B+', label: 'Transactions Processed' },
  { value: '500+', label: 'Businesses' },
  { value: '30+', label: 'Financial Reports' },
];

export const TRUST_COMPANIES = [
  'TechBridge Solutions',
  'VDM Construction',
  'Naidoo & Associates',
  'Bright Sphere',
  'SA Retail Group',
];

export const FEATURE_PILLARS = [
  {
    icon: FileText,
    title: 'Get paid faster',
    desc: 'Professional invoices, automated reminders, real-time AR tracking.',
  },
  {
    icon: RefreshCw,
    title: 'Always reconciled',
    desc: 'Connect your bank, match transactions automatically, close your books with confidence.',
  },
  {
    icon: Shield,
    title: 'Stay compliant',
    desc: 'VAT returns, tax submissions and audit trails — handled.',
  },
  {
    icon: Zap,
    title: 'Work smarter',
    desc: 'AI document capture, smart categorisation, anomaly detection.',
  },
];

export const DETAILED_FEATURES = [
  {
    badge: 'Accounts Receivable',
    title: 'Get paid faster with smart invoicing',
    desc: 'Create professional invoices, set up recurring billing, and track every payment. Automated reminders keep your cash flow healthy while the customer portal gives clients self-service access.',
    bullets: [
      'Professional invoice PDF generation & email delivery',
      'Quotes → Sales Orders → Invoices workflow',
      'Recurring invoices with flexible schedules',
      'Credit notes, write-offs & payment allocation',
      'Customer statements & batch statement runs',
      'AR aging analysis with debtors manager dashboard',
    ],
    imgKey: 'invoicing',
  },
  {
    badge: 'Banking',
    title: 'Bank reconciliation on autopilot',
    desc: 'Import statements from your bank or connect live bank feeds. Our 4-tier smart matching engine automatically categorises and reconciles transactions with confidence scoring.',
    bullets: [
      '7+ bank statement formats supported',
      '4-tier auto-matching (rules → reference → amount+date → AI)',
      'AI-powered smart categorisation with anomaly detection',
      'Categorisation rules engine with live preview',
      'Live bank feeds for real-time sync',
      'Batch payments with EFT file generation',
    ],
    imgKey: 'banking',
  },
  {
    badge: 'AI-Powered',
    title: 'Intelligence built into every workflow',
    desc: 'ISAFlow uses Vision AI and machine learning to automate tedious accounting tasks. Capture a receipt and watch it become a journal entry in seconds.',
    bullets: [
      'Vision AI document extraction (receipts, invoices, contracts)',
      'Auto-invoice creation from captured documents',
      '3-way matching: PO + delivery note + invoice',
      'AI-generated management commentary on financials',
      'Natural language queries against your data',
      'Continuous close automation with smart categorisation',
    ],
    imgKey: 'ai-features',
  },
];

export const PRICING_TIERS = [
  {
    name: 'Starter',
    price: 'R 499',
    period: '/month',
    desc: 'Perfect for sole proprietors and small businesses just getting started.',
    features: [
      'Full General Ledger',
      'Invoicing, Quotes & Statements',
      'Bank Reconciliation (1 bank)',
      'VAT Returns & Tax Compliance',
      '10 Financial Reports',
      'Inventory & Items',
      'Full Audit Trail',
      'Two-Factor Authentication',
      'Customer Statements & Dunning',
      'Year-End Close Wizard',
      'Up to 2 users',
      'Email support',
    ],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Professional',
    price: 'R 999',
    period: '/month',
    desc: 'For growing businesses that need full accounting power and automation.',
    features: [
      'Everything in Starter, plus:',
      'Unlimited bank accounts & bank feeds',
      'AI Smart Categorisation & Anomaly Detection',
      'AI Document Capture (Vision AI)',
      'Recurring Invoices & Journals',
      'Batch Payments & EFT Generation',
      'All 30+ Reports & Executive Dashboard',
      'Custom Report Builder',
      'Customer Portal',
      'Fixed Assets & Depreciation',
      'Approval Workflows',
      'Multi-Currency & Exchange Rates',
      'Time & Project Tracking',
      'Up to 10 users',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 'R 2,499',
    period: '/month',
    desc: 'For accounting firms and multi-entity businesses with advanced needs.',
    features: [
      'Everything in Professional, plus:',
      'Multi-entity / Group Consolidation',
      'Payroll with PAYE/UIF/SDL & IRP5',
      'SARS eFiling (VAT201 + EMP201)',
      'AI Management Commentary & Forecasting',
      '3-Way Forecast (P&L + BS + Cash Flow)',
      'IFRS Disclosure Note Generator',
      'CaseWare Export & Account Mapping',
      'Data Archiving & Retention Engine',
      'Webhooks for CRM Integration',
      'Cost Centres & Business Units',
      'Unlimited users',
      'Dedicated account manager',
    ],
    cta: 'Contact Sales',
    popular: false,
  },
];

export const TESTIMONIALS = [
  {
    name: 'Thandi Molefe',
    role: 'CFO',
    company: 'TechBridge Solutions',
    quote: 'ISAFlow has transformed how we handle our accounting. The bank reconciliation alone saves us 15 hours a month. The compliance features give us complete peace of mind.',
    metric: 'Saves 15 hours/month',
    stars: 5,
    featured: true,
  },
  {
    name: 'Johan van der Merwe',
    role: 'Owner',
    company: 'VDM Construction',
    quote: 'The smart categorisation learns our patterns and now auto-allocates 90% of our bank transactions. Incredible time saver.',
    stars: 5,
    featured: false,
  },
  {
    name: 'Priya Naidoo',
    role: 'Practice Manager',
    company: 'Naidoo & Associates',
    quote: 'Managing multiple client entities is effortless. The approval workflows and audit trail give our clients confidence in our processes.',
    stars: 5,
    featured: false,
  },
];

export const FAQ_ITEMS = [
  {
    q: 'Can I try ISAFlow for free?',
    a: 'Yes. Every plan comes with a 14-day free trial — no credit card required. You get full access to all features in your selected tier so you can evaluate ISAFlow with your real data before committing.',
  },
  {
    q: 'Can I import data from other software?',
    a: 'Absolutely. ISAFlow includes dedicated migration wizards for Sage, Xero, QuickBooks, and Pastel. Import your chart of accounts, customers, suppliers, and opening balances with automatic account mapping and balance verification.',
  },
  {
    q: 'Which banks are supported for statement import?',
    a: 'ISAFlow supports statement imports from major banks in CSV and PDF formats, plus OFX and QIF for others. Live bank feeds provide automatic transaction syncing. Our AI auto-detects the bank format.',
  },
  {
    q: 'Is my data secure?',
    a: 'Enterprise-grade security: two-factor authentication (TOTP + backup codes), granular module-level permissions, field masking for sensitive data, SSL/TLS encryption, bcrypt password hashing, and signed JWT sessions.',
  },
  {
    q: 'Does it handle tax compliance?',
    a: 'Yes. ISAFlow supports VAT calculations on every transaction, generates VAT returns, handles payroll tax submissions, and maintains a field-level audit trail on every financial record. Full compliance out of the box.',
  },
];
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | head -40
```

Expected: no errors related to `landingData.ts`. If there are errors from other files, ignore them for now.

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/landingData.ts
git commit -m "refactor(landing): update data — 3 stats, 4 pillars, 3 deep-dives, 5 FAQs, global-friendly copy"
```

---

## Task 2: Redesign LandingNavbar.tsx

**Files:**
- Modify: `src/components/landing/LandingNavbar.tsx`

The navbar must always appear dark/glass (not transparent-to-white) since it sits over the video hero. On scroll it darkens slightly.

- [ ] **Step 1: Replace LandingNavbar.tsx**

```typescript
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { APP_URL } from './landingData';

interface Props {
  scrolled: boolean;
  mobileMenuOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
}

export function LandingNavbar({ scrolled, mobileMenuOpen, onToggleMobile, onCloseMobile }: Props) {
  const navBg = scrolled
    ? 'bg-[rgba(5,10,15,0.92)] border-b border-white/10'
    : 'bg-[rgba(5,10,15,0.6)] border-b border-white/8';

  return (
    <nav className={`fixed top-0 w-full z-50 transition-all duration-300 backdrop-blur-xl ${navBg}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          <Link href="/" className="flex items-center">
            <img src="/logo.png" alt="ISAFlow" className="h-8 sm:h-10 w-auto brightness-0 invert" />
          </Link>

          <div className="hidden lg:flex items-center gap-8">
            {['Features', 'Pricing', 'Testimonials', 'FAQ'].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm font-medium text-white/65 hover:text-white transition-colors duration-200"
              >
                {item}
              </a>
            ))}
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <a
              href={`${APP_URL}/login`}
              className="px-4 py-2 text-sm font-medium text-white/65 hover:text-white transition-colors duration-200"
            >
              Sign In
            </a>
            <a
              href={`${APP_URL}/register`}
              className="px-5 py-2.5 text-sm font-semibold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all"
            >
              Start Free Trial
            </a>
          </div>

          <button onClick={onToggleMobile} className="lg:hidden p-2 text-white/70 hover:text-white">
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="lg:hidden bg-[rgba(5,10,15,0.97)] border-t border-white/10">
          <div className="px-4 py-4 space-y-1">
            {['features', 'pricing', 'testimonials', 'faq'].map((item) => (
              <a
                key={item}
                href={`#${item}`}
                onClick={onCloseMobile}
                className="block px-3 py-2.5 text-sm font-medium text-white/70 rounded-lg hover:text-white hover:bg-white/5 capitalize"
              >
                {item}
              </a>
            ))}
            <hr className="my-2 border-white/10" />
            <a href={`${APP_URL}/login`} className="block px-3 py-2.5 text-sm font-medium text-white/70 rounded-lg hover:text-white hover:bg-white/5">Sign In</a>
            <a href={`${APP_URL}/register`} className="block px-3 py-2.5 text-sm font-semibold text-center text-slate-900 bg-white rounded-xl mt-2">Start Free Trial</a>
          </div>
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | grep -i "LandingNavbar" | head -10
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/LandingNavbar.tsx
git commit -m "feat(landing): glass dark navbar — always dark/blur over video hero"
```

---

## Task 3: Rewrite LandingHero.tsx

**Files:**
- Modify: `src/components/landing/LandingHero.tsx`

Full-screen video background, dark gradient overlay, centred white text. Stats bar moves into this file as a sub-section.

- [ ] **Step 1: Replace LandingHero.tsx**

```typescript
import { ArrowRight, PlayCircle } from 'lucide-react';
import { APP_URL, STATS } from './landingData';

export function LandingHero() {
  return (
    <>
      {/* ── Video Hero ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
        {/* Video background — hidden on mobile, static image shown instead */}
        <video
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover hidden sm:block"
          poster="/landing/seq2-1-midnight.png"
        >
          <source src="/landing/IsaFlow Video.mp4" type="video/mp4" />
        </video>

        {/* Mobile static fallback */}
        <div
          className="absolute inset-0 bg-cover bg-center sm:hidden"
          style={{ backgroundImage: 'url(/landing/seq2-1-midnight.png)' }}
        />

        {/* Dark gradient overlay — darkens top/bottom for readability, lets city show on sides */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(5,10,15,0.85) 0%, rgba(5,10,15,0.5) 50%, rgba(5,10,15,0.9) 100%)',
          }}
        />

        {/* Hero content */}
        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-20">
          {/* Eyebrow label */}
          <p className="text-xs font-semibold tracking-[0.2em] uppercase text-white/50 mb-6">
            Accounting Software
          </p>

          {/* Main headline */}
          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tight leading-[1.02] text-white mb-6">
            Your finances,
            <br />
            finally clear.
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-white/60 leading-relaxed max-w-2xl mx-auto mb-10">
            Invoicing, bank reconciliation, tax compliance and payroll —
            everything your business needs in one platform.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <a
              href={`${APP_URL}/register`}
              className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
            >
              Start Free Trial <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#features"
              className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-white border border-white/30 rounded-xl hover:bg-white/5 transition-all"
            >
              <PlayCircle className="w-4 h-4" /> Watch Demo
            </a>
          </div>

          {/* Trust line */}
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-white/45">
            <span>✓ 14-day free trial</span>
            <span>✓ No credit card required</span>
            <span>✓ Full tax compliance</span>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 animate-bounce">
          <div className="w-5 h-8 border-2 border-white/20 rounded-full flex items-start justify-center pt-1">
            <div className="w-1 h-2 bg-white/40 rounded-full" />
          </div>
        </div>
      </section>

      {/* ── Stats Bar ── */}
      <section className="bg-gray-900 py-14">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-3 gap-8 text-center">
            {STATS.map((s) => (
              <div key={s.label}>
                <p className="text-4xl lg:text-5xl font-extrabold text-white mb-1">{s.value}</p>
                <p className="text-sm text-gray-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | grep -i "LandingHero" | head -10
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/LandingHero.tsx
git commit -m "feat(landing): cinematic video hero — full-screen video bg, centred white text, scroll indicator"
```

---

## Task 4: Redesign LandingFeatures.tsx

**Files:**
- Modify: `src/components/landing/LandingFeatures.tsx`

Replace the 40-card grid with a clean 4-pillar layout. Trim deep-dives from 8 to 3.

- [ ] **Step 1: Replace LandingFeatures.tsx**

```typescript
import { Check } from 'lucide-react';
import { FEATURE_PILLARS, DETAILED_FEATURES } from './landingData';

export function LandingFeaturesGrid() {
  return (
    <section id="features" className="py-20 lg:py-28 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Features
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4 text-gray-900">
            Everything you need.
            <br />
            Nothing you don't.
          </h2>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {FEATURE_PILLARS.map((pillar) => (
            <div key={pillar.title} className="group text-center">
              <div className="w-14 h-14 rounded-2xl bg-gray-900 flex items-center justify-center mx-auto mb-5 group-hover:bg-teal-600 transition-colors duration-300">
                <pillar.icon className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">{pillar.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{pillar.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LandingDetailedFeatures() {
  return (
    <section className="py-20 lg:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="space-y-24 lg:space-y-32">
          {DETAILED_FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`grid lg:grid-cols-2 gap-12 lg:gap-20 items-center ${
                i % 2 === 1 ? 'lg:flex-row-reverse' : ''
              }`}
            >
              <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                <span className="inline-block px-3 py-1 rounded-full bg-teal-50 text-teal-700 text-xs font-semibold mb-4 tracking-wide">
                  {f.badge}
                </span>
                <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4 text-gray-900">
                  {f.title}
                </h3>
                <p className="text-gray-500 leading-relaxed mb-6">{f.desc}</p>
                <ul className="space-y-3">
                  {f.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-teal-500 mt-0.5 flex-shrink-0" />
                      <span className="text-sm text-gray-700">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className={i % 2 === 1 ? 'lg:order-1' : ''}>
                <div
                  className={`relative rounded-2xl overflow-hidden shadow-2xl border border-gray-100 ${
                    i % 2 === 1 ? 'bg-gray-50' : 'bg-white'
                  }`}
                >
                  <img
                    src={`/landing/${f.imgKey}.png`}
                    alt={f.title}
                    className="w-full"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling as HTMLElement | null;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                  <div
                    className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 to-gray-900 items-center justify-center"
                    style={{ display: 'none' }}
                  >
                    <p className="text-gray-500 text-sm">{f.title} screenshot</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | grep -i "LandingFeatures" | head -10
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/LandingFeatures.tsx
git commit -m "feat(landing): replace 40-card feature grid with 4 pillars + trim to 3 deep-dives"
```

---

## Task 5: Update LandingPricingTestimonialsFooter.tsx

**Files:**
- Modify: `src/components/landing/LandingPricingTestimonialsFooter.tsx`

Add trust bar, upgrade testimonials to featured+2 hierarchy, fix pricing card (remove scale), trim FAQ to 5, add closing CTA section.

- [ ] **Step 1: Read the current file to see what LandingCTA and LandingFooter look like**

```bash
cd /home/hein/Workspace/IsaFlow && cat -n src/components/landing/LandingPricingTestimonialsFooter.tsx | tail -150
```

- [ ] **Step 2: Replace LandingPricingTestimonialsFooter.tsx**

Replace the full file with the following. Note: preserve whatever `LandingFooter` currently contains — only the sections before it change.

```typescript
import { useState } from 'react';
import { Check, Star, ChevronDown, ArrowRight } from 'lucide-react';
import { APP_URL, PRICING_TIERS, TESTIMONIALS, FAQ_ITEMS, TRUST_COMPANIES } from './landingData';

interface FAQProps {
  openFaq: number | null;
  onToggle: (i: number) => void;
}

// ── Trust Bar ──────────────────────────────────────────────────────────────
export function LandingTrustBar() {
  return (
    <section className="bg-white py-12 border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-xs font-semibold tracking-widest uppercase text-gray-400 mb-8">
          Trusted by businesses across South Africa
        </p>
        <div className="flex flex-wrap items-center justify-center gap-8 lg:gap-12">
          {TRUST_COMPANIES.map((name) => (
            <div
              key={name}
              className="text-sm font-semibold text-gray-300 tracking-wide"
            >
              {name}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Pricing ────────────────────────────────────────────────────────────────
export function LandingPricing() {
  return (
    <section id="pricing" className="py-20 lg:py-28 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Pricing
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4 text-gray-900">
            Plans that grow with your business
          </h2>
          <p className="text-lg text-gray-500">
            Start with a 14-day free trial on any plan. No credit card required.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-2xl p-8 ${
                tier.popular
                  ? 'bg-gray-900 text-white shadow-2xl shadow-gray-900/20 ring-2 ring-teal-500'
                  : 'bg-white border border-gray-200 shadow-sm'
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 px-4 py-1.5 rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 text-white text-xs font-bold shadow-lg">
                    <Star className="w-3 h-3 fill-white" /> MOST POPULAR
                  </span>
                </div>
              )}
              <h3 className={`text-lg font-semibold mb-1 ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                {tier.name}
              </h3>
              <p className={`text-sm mb-6 ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                {tier.desc}
              </p>
              <div className="flex items-baseline gap-1 mb-8">
                <span className={`text-4xl font-extrabold ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                  {tier.price}
                </span>
                <span className={`text-sm ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                  {tier.period}
                </span>
              </div>
              <ul className="space-y-3 mb-8">
                {tier.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5">
                    <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tier.popular ? 'text-teal-400' : 'text-teal-500'}`} />
                    <span className={`text-sm ${tier.popular ? 'text-gray-300' : 'text-gray-600'}`}>{feat}</span>
                  </li>
                ))}
              </ul>
              <a
                href={tier.name === 'Enterprise' ? '#contact' : `${APP_URL}/register`}
                className={`block w-full text-center py-3 rounded-xl text-sm font-semibold transition-all ${
                  tier.popular
                    ? 'bg-gradient-to-r from-teal-500 to-cyan-500 text-white hover:from-teal-600 hover:to-cyan-600 shadow-lg shadow-teal-500/25'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Testimonials ───────────────────────────────────────────────────────────
export function LandingTestimonials() {
  const featured = TESTIMONIALS.find((t) => t.featured);
  const supporting = TESTIMONIALS.filter((t) => !t.featured);

  return (
    <section id="testimonials" className="py-20 lg:py-28 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">
            Testimonials
          </p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
            Loved by finance teams
          </h2>
        </div>

        {/* Featured testimonial */}
        {featured && (
          <div className="bg-gray-900 rounded-3xl p-10 lg:p-14 mb-8 text-center max-w-4xl mx-auto">
            <div className="flex justify-center mb-6">
              {Array.from({ length: featured.stars }).map((_, i) => (
                <Star key={i} className="w-5 h-5 text-teal-400 fill-teal-400" />
              ))}
            </div>
            <blockquote className="text-xl lg:text-2xl font-medium text-white leading-relaxed mb-8">
              "{featured.quote}"
            </blockquote>
            {featured.metric && (
              <div className="inline-block px-4 py-2 bg-teal-500/20 text-teal-400 text-sm font-semibold rounded-full mb-6">
                {featured.metric}
              </div>
            )}
            <div>
              <p className="font-semibold text-white">{featured.name}</p>
              <p className="text-sm text-gray-400">{featured.role}, {featured.company}</p>
            </div>
          </div>
        )}

        {/* Supporting testimonials */}
        <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {supporting.map((t) => (
            <div key={t.name} className="bg-white border border-gray-100 rounded-2xl p-8 shadow-sm border-l-4 border-l-teal-500">
              <div className="flex mb-4">
                {Array.from({ length: t.stars }).map((_, i) => (
                  <Star key={i} className="w-4 h-4 text-teal-500 fill-teal-500" />
                ))}
              </div>
              <blockquote className="text-gray-700 leading-relaxed mb-6 text-sm">
                "{t.quote}"
              </blockquote>
              <div>
                <p className="font-semibold text-gray-900 text-sm">{t.name}</p>
                <p className="text-xs text-gray-400">{t.role}, {t.company}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── FAQ ────────────────────────────────────────────────────────────────────
export function LandingFAQ({ openFaq, onToggle }: FAQProps) {
  return (
    <section id="faq" className="py-20 lg:py-28 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <p className="text-sm font-semibold text-teal-600 tracking-widest uppercase mb-3">FAQ</p>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
            Common questions
          </h2>
        </div>

        <div className="space-y-3">
          {FAQ_ITEMS.map((item, i) => (
            <div key={i} className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm">
              <button
                onClick={() => onToggle(i)}
                className="w-full flex items-center justify-between px-6 py-5 text-left"
              >
                <span className="font-semibold text-gray-900 text-sm">{item.q}</span>
                <ChevronDown
                  className={`w-5 h-5 text-gray-400 flex-shrink-0 ml-4 transition-transform duration-200 ${
                    openFaq === i ? 'rotate-180' : ''
                  }`}
                />
              </button>
              {openFaq === i && (
                <div className="px-6 pb-5">
                  <p className="text-sm text-gray-600 leading-relaxed">{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Closing CTA ────────────────────────────────────────────────────────────
export function LandingCTA() {
  return (
    <section className="py-20 lg:py-28 bg-gray-900">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">
          Ready to take control<br />of your finances?
        </h2>
        <p className="text-lg text-gray-400 mb-10">
          Start your free 14-day trial today. No credit card required.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href={`${APP_URL}/register`}
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-bold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all shadow-2xl"
          >
            Start Free Trial <ArrowRight className="w-4 h-4" />
          </a>
          <a
            href="#contact"
            className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-white border border-white/30 rounded-xl hover:bg-white/5 transition-all"
          >
            Book a Demo
          </a>
        </div>
      </div>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────
export function LandingFooter() {
  return (
    <footer className="bg-gray-900 border-t border-white/10 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="ISAFlow" className="h-8 w-auto brightness-0 invert opacity-60" />
            <span className="text-sm text-gray-500">© {new Date().getFullYear()} ISAFlow. All rights reserved.</span>
          </div>
          <div className="flex gap-6 text-sm text-gray-500">
            <a href="/privacy" className="hover:text-white transition-colors">Privacy</a>
            <a href="/terms" className="hover:text-white transition-colors">Terms</a>
            <a href="/security" className="hover:text-white transition-colors">Security</a>
            <a href={`${APP_URL}/login`} className="hover:text-white transition-colors">Sign In</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | grep -i "LandingPricing\|LandingTestimonials\|LandingFAQ\|LandingCTA\|LandingFooter\|LandingTrustBar" | head -20
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/LandingPricingTestimonialsFooter.tsx
git commit -m "feat(landing): trust bar, featured testimonial, trim FAQ to 5, closing CTA section, pricing cleanup"
```

---

## Task 6: Update pages/index.tsx

**Files:**
- Modify: `pages/index.tsx`

Wire in the new `LandingTrustBar` component and update the page title/meta.

- [ ] **Step 1: Update pages/index.tsx**

```typescript
import { useState, useEffect } from 'react';
import Head from 'next/head';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingFeaturesGrid, LandingDetailedFeatures } from '@/components/landing/LandingFeatures';
import {
  LandingTrustBar,
  LandingPricing,
  LandingTestimonials,
  LandingFAQ,
  LandingCTA,
  LandingFooter,
} from '@/components/landing/LandingPricingTestimonialsFooter';

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <Head>
        <title>ISAFlow — Accounting Software for Modern Business</title>
        <meta
          name="description"
          content="Invoicing, bank reconciliation, tax compliance and payroll — everything your business needs in one powerful platform."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />
        <LandingHero />
        <LandingTrustBar />
        <LandingFeaturesGrid />
        <LandingDetailedFeatures />
        <LandingTestimonials />
        <LandingPricing />
        <LandingFAQ
          openFaq={openFaq}
          onToggle={(i) => setOpenFaq(openFaq === i ? null : i)}
        />
        <LandingCTA />
        <LandingFooter />
      </div>
    </>
  );
}
```

- [ ] **Step 2: Full TypeScript check**

```bash
cd /home/hein/Workspace/IsaFlow && bunx tsc --noEmit 2>&1 | head -30
```

Expected: no errors in landing page files. Fix any that appear before proceeding.

- [ ] **Step 3: Commit**

```bash
git add pages/index.tsx
git commit -m "feat(landing): wire LandingTrustBar, update page title to global-friendly copy"
```

---

## Task 7: Visual QA in browser

- [ ] **Step 1: Start dev server**

```bash
cd /home/hein/Workspace/IsaFlow && bun run dev
```

- [ ] **Step 2: Open http://localhost:3000 and verify each section**

Check the following in order:

| Check | Expected |
|-------|----------|
| Navbar | Dark glass, white logo, white links at 65% opacity |
| Hero | Video plays behind dark gradient overlay, centred white headline |
| Hero mobile (resize to 375px) | Static midnight image shows instead of video |
| Headline | "Your finances, finally clear." — large, bold, white |
| CTAs | White "Start Free Trial" button, ghost "Watch Demo" |
| Trust line | 3 checkmarks at 45% opacity |
| Scroll indicator | Bouncing dot visible at bottom of hero |
| Stats bar | Dark bg, 3 numbers: R 2.4B+, 500+, 30+ |
| Trust bar | Company names in gray, "Trusted by businesses across South Africa" label |
| Feature pillars | 4 columns, dark icon squares, no card borders |
| Deep-dives | Only 3 sections (Invoicing, Banking, AI) |
| Testimonials | Dark featured card + 2 teal-bordered cards |
| Pricing | 3 tiers, NO scale transform on popular card, ring-2 highlight only |
| FAQ | 5 questions only |
| Closing CTA | Dark bg, bold headline, white + ghost buttons |
| Footer | Dark bg, logo inverted white |

- [ ] **Step 3: Fix any visual issues found, then commit final**

```bash
git add -p
git commit -m "fix(landing): visual QA fixes"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Hero: video bg, glass nav, centred text, dark overlay — Task 3
- ✅ Video fallback to static image on mobile — Task 3
- ✅ Navbar always dark/glass — Task 2
- ✅ Scroll behaviour (darkens) — Task 2
- ✅ Global-first language, no SA badge in hero — Tasks 1 + 3
- ✅ Trust bar below hero — Tasks 5 + 6
- ✅ Stats: 3 items (R 2.4B+, 500+, 30+) — Tasks 1 + 3
- ✅ 4 feature pillars replacing 40-card grid — Tasks 1 + 4
- ✅ 3 deep-dives (Invoicing, Banking, AI) — Tasks 1 + 4
- ✅ Featured testimonial + 2 supporting — Tasks 1 + 5
- ✅ Pricing: removed scale-[1.02], ring highlight only — Task 5
- ✅ FAQ trimmed to 5 — Tasks 1 + 5
- ✅ Closing CTA section — Task 5
- ✅ Page title updated to global copy — Task 6
- ✅ Visual QA — Task 7

**No placeholders found.** All code blocks are complete.

**Type consistency:** `TESTIMONIALS` shape uses `featured: boolean` defined in Task 1 and consumed correctly in Task 5. `FEATURE_PILLARS` defined in Task 1, consumed in Task 4. All imports match exports.
