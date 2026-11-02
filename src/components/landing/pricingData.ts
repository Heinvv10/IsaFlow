/**
 * /pricing page data — Phase 6 commercial wedge.
 *
 * Scenario C ("Premium-locked"), selected by Hein 2026-07-06 via AskUserQuestion.
 * Canonical spec: docs/commercial/pricing-skus.md. The direct SMB tiers live in
 * landingData.ts (PRICING_TIERS) so the landing page and /pricing share one
 * source; the practice/bureau SKUs, the Close Agent add-on, the CPI price-lock
 * and the Sage anchor comparison are /pricing-specific and live here.
 *
 * NOTE (Hein sign-off): numbers are signed; the marketing PROSE (feature bullets,
 * headlines) is a draft for Hein's copy review before public launch.
 */

export interface BureauSku {
  name: string;
  price: string;
  period: string;
  desc: string;
  features: string[];
}

/** The firm cockpit is free — bureaus pay only per active client. */
export const BUREAU_FIRM_PORTAL_FREE = true;

/**
 * VAT display (Hein 2026-07-07, §9 item 7): all displayed prices are the all-in,
 * VAT-inclusive amount the customer pays (ex-VAT net = incl ÷ 1.15). Competitor
 * figures are compared on the same incl-VAT basis (Sage advertises incl-VAT).
 */
export const VAT_INCLUSIVE = true;
export const VAT_NOTE = 'All prices include 15% VAT.';

export interface PaygBundle {
  flows: number;
  price: string;
}

export interface PaygPlan {
  name: string;
  price: string;
  period: string;
  desc: string;
  eligibility: string;
  limits: string[];
  bundles: PaygBundle[];
  topupNote: string;
}

export const PAYG_PLAN: PaygPlan = {
  name: 'Pay-As-You-Go',
  price: 'R 0',
  period: '/month',
  desc: 'Prepaid Flows with no monthly fee for eligible low-volume businesses.',
  eligibility: 'Eligible if your company has under R1 million annual turnover, averages fewer than 200 posted journal entries per month, or is approved by our team. Start with the free trial, then ask us to switch an eligible company to Pay-As-You-Go.',
  limits: ['1 user', '1 company'],
  bundles: [
    { flows: 100, price: 'R 10' },
    { flows: 500, price: 'R 50' },
    { flows: 1_500, price: 'R 150' },
    { flows: 2_500, price: 'R 250' },
  ],
  topupNote: 'Top up by buying another bundle whenever you need more Flows.',
};

export const BUREAU_SKUS: BureauSku[] = [
  {
    name: 'Ledger',
    price: 'R 79',
    period: '/client/mo',
    desc: 'Write-up and compliance clients.',
    features: [
      'General ledger & trial balance',
      'VAT201 & tax compliance',
      'Annual Financial Statements export',
      'Compliance calendar in your cockpit',
    ],
  },
  {
    name: 'Active',
    price: 'R 249',
    period: '/client/mo',
    desc: 'Full-service clients you run end to end.',
    features: [
      'Everything in Ledger, plus:',
      'Full books — invoicing, AR & AP',
      'Bank reconciliation & statement import (CSV, OFX, QFX, QIF, MT940, PDF)',
      'Payslip-ready payroll data',
      'One flat rate per client — full books included',
    ],
  },
];

export interface AddOn {
  name: string;
  price: string;
  unit: string;
  desc: string;
  bullets: string[];
}

export const CLOSE_AGENT_ADDON: AddOn = {
  name: 'Close Agent',
  price: 'R 299',
  unit: 'per entity / month',
  desc: 'Month-end AI that prepares entries for you to approve.',
  bullets: [
    'Reviews the period and proposes each posting',
    'Close Agent prepares entries for you to approve; AI connections only post if you give them posting permission.',
    'Every suggestion shows its evidence, expandable',
    'Full audit trail: reasoning stored on every journal',
    'Add to any direct plan or bureau client',
  ],
};

/** Payroll add-on (Hein 2026-07-07, §9 item 1): per active employee / month. */
export const PAYROLL_ADDON: AddOn = {
  name: 'Payroll',
  price: 'R 20',
  unit: 'per employee / month',
  desc: 'Full VIP-parity payroll — PAYE, UIF, SDL, payslips and IRP5s.',
  bullets: [
    'PAYE / UIF / SDL calculated and posted',
    'Payslips + IRP5 / EMP201-ready data',
    'Only pay for active employees each month',
  ],
};

/** Annual billing (Hein 2026-07-07, §9 item 2): pay for 10 months, get 12. */
export interface AnnualBilling {
  monthsFree: number;
  label: string;
}

export const ANNUAL_BILLING: AnnualBilling = {
  monthsFree: 2,
  label: 'Pay annually and get 2 months free',
};

export interface PriceLock {
  headline: string;
  body: string;
  points: string[];
}

/** The signature promise — CPI-capped increases, forever (Hein's choice). */
export const PRICE_LOCK: PriceLock = {
  headline: "Your price won't jump. Ever.",
  body: 'While you stay on your plan, we will never raise your monthly price by more than South African headline CPI (inflation). No surprise double-digit hikes.',
  points: [
    'QuickBooks raised its US plan prices by up to 24% in August 2026. Xero raised its South African prices in November 2026.',
    'IsaFlow is capped at inflation — a promise, not a launch discount.',
    'Move from Sage, Xero or QuickBooks and keep your rate.',
  ],
};

export interface PriceSource {
  claim: string;
  url: string;
}

/** Where each competitor statement in PRICE_LOCK.points comes from (checked 2026-11-02). */
export const PRICE_LOCK_SOURCES: PriceSource[] = [
  { claim: 'QuickBooks US increase, 1 Aug 2026 (Essentials 13%, Plus 22%, Advanced 24%)', url: 'https://www.certumsolutions.com/library/quickbooks-price-increase-august-2026' },
  { claim: 'Xero South Africa: Starter R450 → R485 incl. VAT from Nov 2026', url: 'https://www.xero.com/za/pricing-plans/' },
];

export interface SageComparisonRow {
  label: string;
  sage: string;
  isaflow: string;
}

/**
 * The Sage anchor: Sage Accounting Standard plus the add-ons that match
 * IsaFlow Business, at Sage's published monthly incl-VAT prices.
 */
export const SAGE_COMPARISON = {
  note: 'Sage Accounting Standard (R490) plus Debtors Manager (R325), Advanced Inventory (R465) and multi-currency payments (R185) comes to R1,465 a month. IsaFlow Business includes all of it at R549.',
  source: 'https://www.sage.com/en-za/sage-business-cloud/accounting/pricing/',
  checkedOn: '2026-11-02',
  rows: [
    { label: 'Core accounting (Standard)', sage: 'R490 / mo', isaflow: 'Included' },
    { label: 'Debtors / AR management', sage: '+R325 / mo', isaflow: 'Included' },
    { label: 'Advanced inventory', sage: '+R465 / mo', isaflow: 'Included' },
    { label: 'Multi-currency', sage: '+R185 / mo', isaflow: 'Included' },
    { label: 'Monthly total', sage: 'R1,465 / mo', isaflow: 'R549 / mo' },
  ] as SageComparisonRow[],
};
