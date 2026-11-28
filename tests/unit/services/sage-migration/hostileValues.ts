/**
 * Thrown values whose reading throws (round 36): what a driver, a pool or a wrapper could reject with. Each factory makes a fresh one.
 */
export const hostileValues: Array<[string, () => unknown]> = [
  ['a toString that throws', () => ({ toString: () => { throw new Error('injected: hostile toString'); } })],
  ['a null-prototype object', () => Object.create(null) as unknown],
  ['a Symbol.toPrimitive that throws', () => ({ [Symbol.toPrimitive]: () => { throw new Error('injected: toPrimitive'); } })],
  ['a Proxy whose get throws', () => new Proxy({}, { get: () => { throw new Error('injected: proxy get'); } })],
  ['a revoked Proxy', () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; }],
  ['an Error whose message getter throws', () => { const e = new Error('x'); Object.defineProperty(e, 'message', { get: () => { throw new Error('injected: message getter'); } }); return e; }],
  ['an Error whose message is a hostile object', () => { const e = new Error('x'); Object.defineProperty(e, 'message', { value: { toString: () => { throw new Error('injected'); } } }); return e; }],
];
