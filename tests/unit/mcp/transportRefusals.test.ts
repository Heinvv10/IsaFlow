import { describe, expect, it } from 'vitest';
import { refusalId, connectorNotEnabled, ipThrottled } from '@/lib/mcp/transportRefusals';

describe('refusalId', () => {
  it('echoes a single request string or number id', () => {
    expect(refusalId({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' })).toBe('abc');
    expect(refusalId({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).toBe(0);
  });

  it('answers null for a batch, a notification, a non-scalar id or a non-object body', () => {
    expect(refusalId([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).toBeNull();
    expect(refusalId({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(refusalId({ jsonrpc: '2.0', id: { x: 1 }, method: 'tools/list' })).toBeNull();
    expect(refusalId({ jsonrpc: '2.0', id: null, method: 'tools/list' })).toBeNull();
    expect(refusalId(null)).toBeNull();
    expect(refusalId('{"id":1}')).toBeNull();
  });

  it('does not echo an oversized string id', () => {
    expect(refusalId({ jsonrpc: '2.0', id: 'x'.repeat(200), method: 'tools/list' })).toBe('x'.repeat(200));
    expect(refusalId({ jsonrpc: '2.0', id: 'x'.repeat(201), method: 'tools/list' })).toBeNull();
  });

  it('a batch refusal keeps a null id', () => {
    expect(connectorNotEnabled([{ jsonrpc: '2.0', id: 7, method: 'tools/list' }]).id).toBeNull();
    expect(ipThrottled([{ jsonrpc: '2.0', id: 7, method: 'tools/list' }]).id).toBeNull();
  });
});
