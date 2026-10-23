/**
 * What an uploaded capture document that is being read in the background looks like to its readers:
 * a read with no sign of life for 5 minutes is reported as interrupted (computed on read, no cron),
 * and a row with no read columns at all (an old row, a mocked lock) is a finished one.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveReadState, isBeingRead, readGateFor, STALE_AFTER_MINUTES, STALE_READ_ERROR, GENERIC_READ_ERROR, STILL_BEING_READ, NOT_READ,
} from '@/modules/accounting/services/capture/captureReadState';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000);
const row = (over: Record<string, unknown> = {}) => ({
  read_state: 'reading', read_error: null, read_heartbeat_at: null, created_at: ago(1), ...over,
});

describe('effectiveReadState', () => {
  it('reports a fresh read as reading with no error', () => {
    expect(effectiveReadState(row(), NOW)).toEqual({ readState: 'reading', readError: null });
  });

  it('reports a read silent for over 5 minutes as failed, with the upload-again message', () => {
    const s = effectiveReadState(row({ created_at: ago(30), read_heartbeat_at: ago(6) }), NOW);
    expect(s).toEqual({ readState: 'failed', readError: STALE_READ_ERROR });
    expect(STALE_READ_ERROR).toBe('The read was interrupted — upload the document again.');
  });

  it('is stale only after the limit has passed, not at it', () => {
    expect(STALE_AFTER_MINUTES).toBe(5);
    expect(effectiveReadState(row({ created_at: ago(5) }), NOW).readState).toBe('reading');
    expect(effectiveReadState(row({ created_at: new Date(NOW - 5 * 60_000 - 1) }), NOW).readState).toBe('failed');
  });

  it('measures from the last heartbeat, not from creation', () => {
    expect(effectiveReadState(row({ created_at: ago(30), read_heartbeat_at: ago(1) }), NOW).readState).toBe('reading');
  });

  it('measures from creation until the first heartbeat', () => {
    expect(effectiveReadState(row({ created_at: ago(6) }), NOW).readState).toBe('failed');
    expect(effectiveReadState(row({ created_at: ago(4) }), NOW).readState).toBe('reading');
  });

  it('reads timestamps given as strings', () => {
    expect(effectiveReadState(row({ created_at: ago(9).toISOString(), read_heartbeat_at: ago(8).toISOString() }), NOW).readState).toBe('failed');
    expect(effectiveReadState(row({ created_at: ago(9).toISOString(), read_heartbeat_at: ago(1).toISOString() }), NOW).readState).toBe('reading');
  });

  it('shows the recorded error of a failed row, or a generic one when it is empty', () => {
    expect(effectiveReadState(row({ read_state: 'failed', read_error: 'Boom.' }), NOW)).toEqual({ readState: 'failed', readError: 'Boom.' });
    expect(effectiveReadState(row({ read_state: 'failed', read_error: null }), NOW)).toEqual({ readState: 'failed', readError: GENERIC_READ_ERROR });
    expect(effectiveReadState(row({ read_state: 'failed', read_error: '' }), NOW).readError).toBe(GENERIC_READ_ERROR);
  });

  it('leaves a done row alone however old, and ignores a stale error on it', () => {
    expect(effectiveReadState(row({ read_state: 'done', created_at: ago(9000), read_error: 'old' }), NOW)).toEqual({ readState: 'done', readError: null });
  });

  it('treats a row with no read columns as done', () => {
    expect(effectiveReadState({}, NOW)).toEqual({ readState: 'done', readError: null });
    expect(effectiveReadState({ read_state: null }, NOW)).toEqual({ readState: 'done', readError: null });
  });
});

describe('isBeingRead', () => {
  it('is true for a reading row that is not stale', () => {
    expect(isBeingRead(row(), NOW)).toBe(true);
  });

  it('is false for a stale reading row, so the document can be acted on', () => {
    expect(isBeingRead(row({ created_at: ago(30) }), NOW)).toBe(false);
  });

  it('is false for done, failed and column-less rows', () => {
    expect(isBeingRead(row({ read_state: 'done' }), NOW)).toBe(false);
    expect(isBeingRead(row({ read_state: 'failed' }), NOW)).toBe(false);
    expect(isBeingRead({ status: 'pending' }, NOW)).toBe(false);
  });

  it('has the message the refusal sites answer', () => {
    expect(STILL_BEING_READ).toBe('This document is still being read.');
  });
});

describe('readGateFor: what a writer that needs the extraction may do', () => {
  it('lets a finished read, and a row with no read columns, through', () => {
    expect(readGateFor(row({ read_state: 'done' }), NOW)).toBeNull();
    expect(readGateFor({}, NOW)).toBeNull();
    expect(readGateFor({ status: 'pending' }, NOW)).toBeNull();
  });

  it("refuses a fresh read as 'being_read'", () => {
    expect(readGateFor(row(), NOW)).toBe('being_read');
  });

  it("refuses a failed read, and a read gone silent (shown as interrupted), as 'not_read'", () => {
    expect(readGateFor(row({ read_state: 'failed', read_error: 'x' }), NOW)).toBe('not_read');
    expect(readGateFor(row({ created_at: ago(30) }), NOW)).toBe('not_read');
  });

  it('has the upload-again wording', () => {
    expect(NOT_READ).toBe('This document could not be read — upload it again.');
  });
});
