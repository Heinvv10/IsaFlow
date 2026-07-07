import { describe, expect, it } from 'vitest';
import { PRICING_TIERS, BRAND, FAQ_ITEMS } from '@/components/landing/landingData';
import {
  BUREAU_SKUS,
  BUREAU_FIRM_PORTAL_FREE,
  CLOSE_AGENT_ADDON,
  PRICE_LOCK,
  SAGE_COMPARISON,
  PAYROLL_ADDON,
  ANNUAL_BILLING,
  VAT_INCLUSIVE,
  VAT_NOTE,
} from '@/components/landing/pricingData';

/**
 * Phase 6 commercial wedge — Scenario C pricing (selected by Hein 2026-07-06 via
 * AskUserQuestion). These invariants lock the public /pricing page + landing page
 * to the signed numbers in docs/commercial/pricing-skus.md. If a number changes,
 * it changes here first (and Hein has re-signed).
 */
describe('Phase 6 pricing data — Scenario C (Hein-signed 2026-07-06)', () => {
  describe('direct SMB tiers (landingData.PRICING_TIERS)', () => {
    it('has exactly three tiers named Starter, Business, Premium', () => {
      expect(PRICING_TIERS.map((t) => t.name)).toEqual(['Starter', 'Business', 'Premium']);
    });

    it('prices the tiers at R299 / R549 / R899', () => {
      const byName = Object.fromEntries(PRICING_TIERS.map((t) => [t.name, t.price]));
      expect(byName.Starter).toContain('299');
      expect(byName.Business).toContain('549');
      expect(byName.Premium).toContain('899');
    });

    it('marks Business (and only Business) as the popular hero tier', () => {
      expect(PRICING_TIERS.filter((t) => t.popular).map((t) => t.name)).toEqual(['Business']);
    });
  });

  describe('free trial', () => {
    it('offers a 30-day free trial', () => {
      expect(BRAND.freeTrialDays).toBe(30);
    });

    it('reflects 30 days in the FAQ, with no stale 14-day copy', () => {
      const trialFaq = FAQ_ITEMS.find((f) => /trial/i.test(f.a));
      expect(trialFaq?.a).toMatch(/30-day/);
      expect(FAQ_ITEMS.some((f) => /14-day/.test(f.a))).toBe(false);
    });
  });

  describe('bureau / practice per-client SKUs (pricingData)', () => {
    it('has Ledger at R79 and Active at R249', () => {
      const byName = Object.fromEntries(BUREAU_SKUS.map((s) => [s.name, s.price]));
      expect(byName.Ledger).toContain('79');
      expect(byName.Active).toContain('249');
    });

    it('keeps the firm cockpit free (you pay per active client)', () => {
      expect(BUREAU_FIRM_PORTAL_FREE).toBe(true);
    });
  });

  describe('Close Agent add-on (pricingData)', () => {
    it('prices the Close Agent as a R299 per-entity add-on', () => {
      expect(CLOSE_AGENT_ADDON.price).toContain('299');
      expect(CLOSE_AGENT_ADDON.unit).toMatch(/entity/i);
    });
  });

  describe('CPI price-lock guarantee (pricingData)', () => {
    it('anchors the guarantee on CPI / inflation', () => {
      expect(`${PRICE_LOCK.headline} ${PRICE_LOCK.body}`).toMatch(/CPI|inflation/i);
    });
  });

  describe('Sage anchor comparison (pricingData)', () => {
    it('shows the fully-added-up Sage stack (R1,140) against Business (R549)', () => {
      const blob = JSON.stringify(SAGE_COMPARISON);
      expect(blob).toMatch(/1[ ,]?140/);
      expect(blob).toMatch(/549/);
    });
  });

  // ── §9 commercial decisions signed by Hein 2026-07-07 ──────────────────────
  describe('VAT-inclusive display (§9 item 7)', () => {
    it('flags prices as VAT-inclusive', () => {
      expect(VAT_INCLUSIVE).toBe(true);
    });

    it('states the all-in / includes-15%-VAT note', () => {
      expect(VAT_NOTE).toMatch(/includ.*15%\s*VAT/i);
    });
  });

  describe('Payroll add-on (§9 item 1)', () => {
    it('prices payroll as a ~R20 per-employee add-on', () => {
      expect(PAYROLL_ADDON.price).toContain('20');
      expect(PAYROLL_ADDON.unit).toMatch(/employee/i);
    });
  });

  describe('Annual billing (§9 item 2)', () => {
    it('gives 2 months free on annual', () => {
      expect(ANNUAL_BILLING.monthsFree).toBe(2);
      expect(ANNUAL_BILLING.label).toMatch(/2 months free/i);
    });
  });
});
