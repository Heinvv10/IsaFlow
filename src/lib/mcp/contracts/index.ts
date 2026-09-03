/**
 * The shared MCP contracts. Every report and every mutating tool built for the
 * assurance programme imports from here, so that six workstreams cannot invent
 * six envelopes, six cursors and six opinions on what a total means.
 *
 * See docs/mcp/CONTRACTS.md for the convention these types encode.
 */
export * from './envelope';
export * from './cursor';
export * from './mutation';
export * from './actor';
export * from './externalRef';
