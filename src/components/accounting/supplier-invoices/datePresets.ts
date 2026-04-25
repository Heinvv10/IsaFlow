/**
 * SA fiscal-year date helpers for the supplier invoice filter presets.
 * FY runs 1 March → 28/29 February (leap years included).
 */

import type { DatePreset } from './listTypes';

function pad(n: number): string { return String(n).padStart(2, '0'); }

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fyStart(forDate: Date): Date {
  const y = forDate.getMonth() < 2 ? forDate.getFullYear() - 1 : forDate.getFullYear();
  return new Date(y, 2, 1);
}

// Day 0 of March rolls back to the last day of February — Feb 29 in leap years,
// Feb 28 otherwise. Hardcoding `(year, 1, 28)` silently drops Feb 29 data.
export function fyEnd(forDate: Date): Date {
  const start = fyStart(forDate);
  return new Date(start.getFullYear() + 1, 2, 0);
}

export function presetToRange(preset: DatePreset, today: Date = new Date()): { from?: string; to?: string } {
  switch (preset) {
    case 'this_month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: isoDate(from), to: isoDate(to) };
    }
    case 'last_month': {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: isoDate(from), to: isoDate(to) };
    }
    case 'last_30_days': {
      const from = new Date(today);
      from.setDate(from.getDate() - 30);
      return { from: isoDate(from), to: isoDate(today) };
    }
    case 'this_fy':
      return { from: isoDate(fyStart(today)), to: isoDate(fyEnd(today)) };
    case 'last_fy': {
      const start = fyStart(today);
      start.setFullYear(start.getFullYear() - 1);
      const end = new Date(start.getFullYear() + 1, 2, 0);
      return { from: isoDate(start), to: isoDate(end) };
    }
    default:
      return {};
  }
}
