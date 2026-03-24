/**
 * Utility: merge Tailwind class names safely.
 * Uses clsx for conditional class logic + tailwind-merge for deduplication.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// 🟢 WORKING: Standard cn() helper used across all components
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
