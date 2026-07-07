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
      'Bank reconciliation & live feeds',
      'Payslip-ready payroll data',
      'Undercuts Xero Cashbook (R259) — with far more included',
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
  desc: 'Month-end AI that proposes — you approve. Nothing posts without you.',
  bullets: [
    'Reviews the period and proposes each posting',
    'You approve every entry — no autonomous posting',
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
    'QuickBooks raised prices 15–25% in 2026. Xero raises most years.',
    'IsaFlow is capped at inflation — a promise, not a launch discount.',
    'Move from Sage, Xero or QuickBooks and keep your rate.',
  ],
};

export interface SageComparisonRow {
  label: string;
  sage: string;
  isaflow: string;
}

/**
 * The Sage anchor: a real books setup on Sage stacks add-ons to ~R1,140/mo;
 * IsaFlow Business delivers the same scope at R549.
 */
export const SAGE_COMPARISON = {
  note: 'A Sage customer who wants proper books pays Accounting R435 + Debtors R290 + Inventory R415 = R1,140/mo. IsaFlow Business includes all of it at R549.',
  rows: [
    { label: 'Core accounting', sage: 'R435 / mo', isaflow: 'Included' },
    { label: 'Debtors / AR management', sage: '+R290 / mo', isaflow: 'Included' },
    { label: 'Inventory', sage: '+R415 / mo', isaflow: 'Included' },
    { label: 'Multi-currency', sage: '+R165 / mo', isaflow: 'Included' },
    { label: 'Monthly total', sage: 'R1,140 / mo', isaflow: 'R549 / mo' },
  ] as SageComparisonRow[],
};
