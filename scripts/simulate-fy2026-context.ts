/**
 * simulate-fy2026-context.ts — the connection and the date helpers the
 * FY2026 simulation modules share.
 *
 * Split out of simulate-fy2026-workflows.ts so each simulation module stays
 * under the 300-line file cap.
 */

import { createSql } from './_pg';

const databaseUrl = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) { console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not set'); process.exit(1); }

export const DATABASE_URL: string = databaseUrl;

export const sql = createSql(DATABASE_URL);

export const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
export const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';

export interface Err { month: number; module: string; message: string; }

export const pad = (n: number) => String(n).padStart(2, '0');
export const yyyymm = (y: number, m: number) => `${y}${pad(m)}`;
export const firstDay = (y: number, m: number) => `${y}-${pad(m)}-01`;
export const lastDay  = (y: number, m: number) => new Date(y, m, 0).toISOString().slice(0, 10);
export const errText  = (e: unknown) => e instanceof Error ? e.message : String(e);
