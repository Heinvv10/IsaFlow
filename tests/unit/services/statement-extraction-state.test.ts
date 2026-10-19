/**
 * What a statement row in 'extracting' or 'failed' looks like to its readers: an extraction that
 * has not heartbeat for 5 minutes is reported as interrupted (computed on read, no cron), and
 * only a too-many-pages failure cannot be retried.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { StatementReadError } from '@/modules/accounting/services/bank/vlmStatementPages';
import {
  describeExtractionFailure, effectiveExtractionState, STALE_AFTER_MINUTES,
} from '@/modules/accounting/services/bank/statementExtractionState';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000);

const row = (over: Record<string, unknown> = {}) => ({
  status: 'extracting', created_at: ago(1), extraction_heartbeat_at: null, extraction_error: null,
  extraction_error_code: null, extraction_pages_done: null, extraction_pages_total: null, ...over,
});

describe('effectiveExtractionState', () => {
  it('leaves a finished row alone', () => {
    expect(effectiveExtractionState(row({ status: 'extracted', created_at: ago(900) }), NOW)).toEqual({
      status: 'extracted', extractionError: null, retryable: false, pagesDone: null, pagesTotal: null,
    });
  });

  it('keeps a fresh extraction as extracting, with its page progress', () => {
    const s = effectiveExtractionState(row({ extraction_heartbeat_at: ago(1), extraction_pages_done: 3, extraction_pages_total: 12 }), NOW);
    expect(s).toEqual({ status: 'extracting', extractionError: null, retryable: false, pagesDone: 3, pagesTotal: 12 });
  });

  it('reports an extraction with no heartbeat for over 5 minutes as failed and retryable', () => {
    const s = effectiveExtractionState(row({ extraction_heartbeat_at: ago(6), created_at: ago(30) }), NOW);
    expect(s.status).toBe('failed');
    expect(s.extractionError).toBe('Extraction was interrupted — retry it.');
    expect(s.retryable).toBe(true);
  });

  it('measures from the last heartbeat, not from creation', () => {
    expect(effectiveExtractionState(row({ extraction_heartbeat_at: ago(1), created_at: ago(30) }), NOW).status).toBe('extracting');
  });

  it('measures from creation until the first heartbeat', () => {
    expect(effectiveExtractionState(row({ created_at: ago(6) }), NOW).status).toBe('failed');
    expect(effectiveExtractionState(row({ created_at: ago(4) }), NOW).status).toBe('extracting');
  });

  it('is stale only after the limit has passed, not at it', () => {
    expect(STALE_AFTER_MINUTES).toBe(5);
    expect(effectiveExtractionState(row({ created_at: ago(5) }), NOW).status).toBe('extracting');
    expect(effectiveExtractionState(row({ created_at: new Date(NOW - 5 * 60_000 - 1) }), NOW).status).toBe('failed');
  });

  it('reads timestamps given as strings', () => {
    const stale = effectiveExtractionState(row({ created_at: ago(9).toISOString(), extraction_heartbeat_at: ago(8).toISOString() }), NOW);
    expect(stale.status).toBe('failed');
    const fresh = effectiveExtractionState(row({ created_at: ago(9).toISOString(), extraction_heartbeat_at: ago(1).toISOString() }), NOW);
    expect(fresh.status).toBe('extracting');
  });

  it('passes a failed row\'s message through and lets it be retried', () => {
    const s = effectiveExtractionState(row({ status: 'failed', extraction_error: 'Page 2 of 3 could not be read. Retry the import.', extraction_error_code: 'page_failed' }), NOW);
    expect(s).toMatchObject({ status: 'failed', extractionError: 'Page 2 of 3 could not be read. Retry the import.', retryable: true });
  });

  it('does not let a too-many-pages failure be retried', () => {
    const s = effectiveExtractionState(row({ status: 'failed', extraction_error: 'This statement has 31 pages', extraction_error_code: 'too_many_pages' }), NOW);
    expect(s.retryable).toBe(false);
  });

  it('gives a failed row with no recorded message a generic one', () => {
    const s = effectiveExtractionState(row({ status: 'failed' }), NOW);
    expect(s.extractionError).toBe('The statement could not be read. Retry the import.');
  });
});

describe('describeExtractionFailure', () => {
  it('keeps the code and the user-safe message of a read error', () => {
    const err = new StatementReadError('too_many_pages', 'This statement has 31 pages; the most IsaFlow reads is 20.');
    expect(describeExtractionFailure(err, 'bank')).toEqual({ message: err.message, code: 'too_many_pages' });
    expect(describeExtractionFailure(new StatementReadError('page_failed', 'Page 1 of 2 could not be read.'), 'bank'))
      .toEqual({ message: 'Page 1 of 2 could not be read.', code: 'page_failed' });
  });

  it('hides any other error behind a generic message', () => {
    const out = describeExtractionFailure(new Error('connect ECONNREFUSED 10.0.0.9:5432'), 'supplier');
    expect(out.message).toBe('The statement could not be read. Retry the import.');
    expect(out.message).not.toContain('ECONNREFUSED');
    expect(out.code).toBe('unexpected');
  });
});
