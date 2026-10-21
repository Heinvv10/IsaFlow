/**
 * Route plumbing for "Import from Sage" (sageConnectRequest): the login is
 * validated and turned into a client without being kept anywhere else; Sage
 * errors become plain 400s; the review carries names and amounts but no
 * contact details, and the P&L note (M3) says where this year's income and
 * expenses to date land.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { SageApiError } from '@/modules/accounting/services/sage/sageApiClient';
import {
  answerSageError, clientFromLogin, pullPayload, sageConnectAvailable, startedPayload, statusPayload, todayInSouthAfrica, toCompanyOptions, toReview,
} from '@/modules/accounting/services/sage/sageConnectRequest';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { emptyCompany, sageFixture } from './sageFixture';

const saved = process.env.SAGE_API_KEY;
afterEach(() => { process.env.SAGE_API_KEY = saved; });

function res() {
  const state: { status?: number; body?: unknown } = {};
  const r = { status(c: number) { state.status = c; return r; }, json(b: unknown) { state.body = b; return r; }, setHeader() { return r; } };
  return { r: r as unknown as NextApiResponse, state };
}

describe('clientFromLogin', () => {
  it('names the missing field', () => {
    process.env.SAGE_API_KEY = 'k';
    expect(clientFromLogin({ password: 'x' })).toMatchObject({ ok: false, field: 'email' });
    expect(clientFromLogin({ email: ' a@b.c ' })).toMatchObject({ ok: false, field: 'password' });
    expect(clientFromLogin(null)).toMatchObject({ ok: false, field: 'email' });
  });

  it('builds a client, and the result carries no copy of the password', () => {
    process.env.SAGE_API_KEY = 'k';
    const out = clientFromLogin({ email: 'a@b.c', password: 's3cret!' });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain('s3cret!');
  });

  it('the connection is off without a key', () => {
    process.env.SAGE_API_KEY = '  ';
    expect(sageConnectAvailable()).toBe(false);
    expect(statusPayload(null, null)).toEqual({ available: false, open: null, priorTakeOn: null });
  });
});

describe('answerSageError', () => {
  it('answers a Sage error as a 400 with its kind, and leaves anything else to the caller', () => {
    const a = res();
    expect(answerSageError(a.r, new SageApiError('rate_limited', 429))).toBe(true);
    expect(a.state.status).toBe(400);
    expect(JSON.stringify(a.state.body)).toContain('rate_limited');
    const b = res();
    expect(answerSageError(b.r, new Error('boom'))).toBe(false);
    expect(b.state.status).toBeUndefined();
  });
});

describe('the review', () => {
  const review = toReview(buildSageTakeOn(sageFixture(), emptyCompany));

  it('names contacts and documents but carries no email, phone or tax number', () => {
    expect(review.customers).toContain('Bright Billboards');
    const wire = JSON.stringify(review);
    for (const detail of ['ap@bright.test', '011 000 0001', '4000000001']) expect(wire).not.toContain(detail);
    expect(review.arInvoices[0]).toEqual({ contact: 'Bright Billboards', number: 'INV0001', date: '2026-08-01', outstanding: 7000 });
  });

  it('says this year\'s P&L to date lands in the cut-over month', () => {
    expect(review.financialYearStart).toBe('2026-03-01');
    expect(review.profitAndLossNote).toMatch(/2026-03-01.*2026-10-21/);
    expect(review.profitAndLossNote).toMatch(/October 2026/);
  });

  it('with the years apart, the note says this year\'s profit to date goes into equity', () => {
    const folded = toReview(buildSageTakeOn(sageFixture(), { ...emptyCompany, fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' } }));
    expect(folded.profitAndLossNote).toMatch(/profit to date of R38\D000\D00 .*Retained Earnings/);
    expect(folded.profitAndLossNote).toMatch(/will not show this year's income and expenses before 2026-10-21/);
  });

  it('the poll and start answers carry the row state', () => {
    expect(startedPayload('p')).toEqual({ pullId: 'p', status: 'pulling' });
    expect(pullPayload({ id: 'p', status: 'ready', progress: null, error: null, pull: null }, review)).toMatchObject({ pullId: 'p', status: 'ready', review });
  });
});

describe('small helpers', () => {
  it('lists active companies by name', () => {
    expect(toCompanyOptions([{ ID: 2, Name: 'b' }, { ID: 1, Name: 'a' }, { ID: 3, Name: 'c', Active: false }]))
      .toEqual({ companies: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
  });

  it('the cut-over date is today in South Africa, not UTC', () => {
    expect(todayInSouthAfrica(new Date('2026-10-20T22:30:00Z'))).toBe('2026-10-21');
  });
});
