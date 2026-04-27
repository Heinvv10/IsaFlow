// Re-export the canonical TaggedSql from _pg so seed modules don't redeclare it.
export type { TaggedSql } from '../_pg';

export type Customer = { id: string; name: string; code: string };
export type Supplier = { id: string; name: string; code: string };
export type WorkItem = { catId: string; itemId: string; catName: string; itemName: string };
export type PracticeClient = { id: string; name: string; linkedCustomerId: string | null };

export const QA_RECORD_PREFIX = 'QA-';
