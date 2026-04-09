/** Tour step definitions and tooltip positioning for AccountingTour. */

export interface TourStep {
  target: string;
  title: string;
  content: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

export interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TooltipPos {
  top: number;
  left: number;
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="dashboard"]',
    title: 'Dashboard',
    content: 'Your financial overview at a glance — KPIs, cash position, and recent activity.',
    position: 'bottom',
  },
  {
    target: '[data-tour="nav-customers"]',
    title: 'Customers',
    content: 'Manage customers, create invoices, track payments, and send statements.',
    position: 'bottom',
  },
  {
    target: '[data-tour="nav-suppliers"]',
    title: 'Suppliers',
    content: 'Handle supplier invoices, purchase orders, and payments.',
    position: 'bottom',
  },
  {
    target: '[data-tour="nav-banking"]',
    title: 'Banking',
    content: 'Import bank statements, reconcile transactions, and set up auto-categorization rules.',
    position: 'bottom',
  },
  {
    target: '[data-tour="nav-reports"]',
    title: 'Reports',
    content: 'Financial statements, aging reports, VAT returns, and management reports.',
    position: 'bottom',
  },
  {
    target: '[data-tour="company-switcher"]',
    title: 'Company Switcher',
    content: 'Switch between companies if you manage multiple entities.',
    position: 'bottom',
  },
  {
    target: '[data-tour="command-palette"]',
    title: 'Quick Search',
    content: 'Press Ctrl+K to instantly search across all your data — accounts, customers, invoices, and more.',
    position: 'bottom',
  },
];

const TOOLTIP_W = 320;
const TOOLTIP_H = 160;
const GAP = 12;

export function getTooltipPosition(rect: TargetRect, position: TourStep['position']): TooltipPos {
  const clampX = (x: number) => Math.max(8, Math.min(x, window.innerWidth - TOOLTIP_W - 8));
  const clampY = (y: number) => Math.max(8, Math.min(y, window.innerHeight - TOOLTIP_H - 8));

  switch (position) {
    case 'bottom': {
      const idealTop = rect.top + rect.height + GAP;
      // If tooltip would go off-screen below, try placing it inside the target near the top
      const top = idealTop + TOOLTIP_H > window.innerHeight
        ? Math.min(rect.top + GAP + 60, window.innerHeight - TOOLTIP_H - 8)
        : idealTop;
      return { top: clampY(top), left: clampX(rect.left + rect.width / 2 - TOOLTIP_W / 2) };
    }
    case 'top': {
      const idealTop = rect.top - TOOLTIP_H - GAP;
      return { top: clampY(idealTop), left: clampX(rect.left + rect.width / 2 - TOOLTIP_W / 2) };
    }
    case 'right':
      return { top: clampY(rect.top + rect.height / 2 - TOOLTIP_H / 2), left: rect.left + rect.width + GAP };
    case 'left':
      return { top: clampY(rect.top + rect.height / 2 - TOOLTIP_H / 2), left: rect.left - TOOLTIP_W - GAP };
  }
}
