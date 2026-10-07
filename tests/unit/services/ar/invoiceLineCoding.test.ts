/**
 * The caller-supplied ids on a customer invoice line — revenue account,
 * project, cost centre — are read through ONE parser before anything else
 * touches them. Body-coercion lesson: `String(['<uuid>'])` is a valid uuid
 * string, so a value is accepted only when it is ALREADY a string; an array,
 * number or object is refused, never coerced.
 */
import { describe, it, expect } from 'vitest';
import {
  HTTP_CODING_KEYS,
  MCP_CODING_KEYS,
  isCoded,
  parseLineCoding,
  readCodingId,
} from '@/modules/accounting/services/ar/invoiceLineCoding';

const ACCOUNT = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const CENTRE = 'cccccccc-0000-4000-8000-cccccccccccc';

describe('readCodingId', () => {
  it.each([undefined, null, ''])('reads %p as uncoded', (v) => {
    expect(readCodingId(v)).toBeNull();
  });

  it('accepts a uuid string and lower-cases it', () => {
    expect(readCodingId(ACCOUNT.toUpperCase())).toBe(ACCOUNT);
  });

  it.each([
    ['an array holding a uuid', [ACCOUNT]],
    ['a number', 42],
    ['an object', { id: ACCOUNT }],
    ['a boolean', true],
    ['a non-uuid string', 'revenue'],
    ['a uuid with whitespace', ` ${ACCOUNT}`],
  ])('refuses %s', (_label, v) => {
    expect(readCodingId(v)).toBeUndefined();
  });
});

describe('parseLineCoding', () => {
  it('reads the HTTP (camelCase) keys', () => {
    expect(parseLineCoding({ glAccountId: ACCOUNT, projectId: PROJECT, costCenterId: CENTRE }, HTTP_CODING_KEYS, 'items[0]'))
      .toEqual({ glAccountId: ACCOUNT, projectId: PROJECT, costCenterId: CENTRE });
  });

  it('reads the MCP (snake_case) keys', () => {
    expect(parseLineCoding({ gl_account_id: ACCOUNT, project_id: null }, MCP_CODING_KEYS, 'items[0]'))
      .toEqual({ glAccountId: ACCOUNT, projectId: null, costCenterId: null });
  });

  it('a line naming nothing is uncoded', () => {
    const coding = parseLineCoding({ description: 'x' }, HTTP_CODING_KEYS, 'items[0]');
    expect(coding).toEqual({ glAccountId: null, projectId: null, costCenterId: null });
    expect(isCoded(coding as never)).toBe(false);
  });

  it.each([
    ['glAccountId', { glAccountId: [ACCOUNT] }],
    ['projectId', { projectId: 7 }],
    ['costCenterId', { costCenterId: { id: CENTRE } }],
  ])('names the field and the line when %s is not a uuid string', (field, line) => {
    expect(parseLineCoding(line, HTTP_CODING_KEYS, 'items[3]')).toBe(`items[3].${field} must be a UUID`);
  });

  it.each([
    [{ glAccountId: ACCOUNT, projectId: null, costCenterId: null }],
    [{ glAccountId: null, projectId: PROJECT, costCenterId: null }],
    [{ glAccountId: null, projectId: null, costCenterId: CENTRE }],
  ])('any one dimension makes the line coded', (coding) => {
    expect(isCoded(coding)).toBe(true);
  });
});
