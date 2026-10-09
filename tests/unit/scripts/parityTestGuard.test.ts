import { describe, it, expect } from 'vitest';
import { assertParityTestUrl, assertOnlyThrowawayDatabases } from '../../helpers/parityTestGuard';

const OK = 'postgres://127.0.0.1:34263/postgres?sslmode=disable';
const ENV = { PARITY_TEST_PG_DISPOSABLE: '1', DATABASE_URL: 'postgres://100.96.203.105:7772/isaflow_dev?sslmode=disable' };

describe('assertParityTestUrl (the integration suite DROPs databases, so it must refuse anything real)', () => {
  it('accepts a loopback throwaway server when explicitly marked disposable', () => {
    expect(() => assertParityTestUrl(OK, ENV)).not.toThrow();
  });

  it('refuses without PARITY_TEST_PG_DISPOSABLE=1', () => {
    expect(() => assertParityTestUrl(OK, { ...ENV, PARITY_TEST_PG_DISPOSABLE: undefined })).toThrow(/PARITY_TEST_PG_DISPOSABLE/);
    expect(() => assertParityTestUrl(OK, { ...ENV, PARITY_TEST_PG_DISPOSABLE: '0' })).toThrow(/PARITY_TEST_PG_DISPOSABLE/);
  });

  it.each(['7770', '7771', '7772', '7773', '7774', '7775', '7776'])('refuses the IsaFlow stack port %s', (port) => {
    expect(() => assertParityTestUrl(`postgres://127.0.0.1:${port}/postgres`, ENV)).toThrow(/7770-7776/);
  });

  it('refuses the same host:port as DATABASE_URL, however the URL string differs', () => {
    const env = { ...ENV, DATABASE_URL: 'postgres://127.0.0.1:34263/other?sslmode=require' };
    expect(() => assertParityTestUrl(OK, env)).toThrow(/DATABASE_URL/);
  });

  it('refuses a non-loopback host', () => {
    expect(() => assertParityTestUrl('postgres://100.96.203.105:34263/postgres', ENV)).toThrow(/loopback/);
  });

  it('refuses a URL whose database is isaflow or isaflow_dev', () => {
    for (const db of ['isaflow', 'isaflow_dev']) {
      expect(() => assertParityTestUrl(`postgres://127.0.0.1:34263/${db}`, ENV)).toThrow(/isaflow/);
    }
  });

  it('refuses an unset or unparsable URL', () => {
    expect(() => assertParityTestUrl(undefined, ENV)).toThrow();
    expect(() => assertParityTestUrl('not a url', ENV)).toThrow();
  });
});

describe('URL parameter and encoding bypasses (pg-connection-string honours these, WHATWG URL does not)', () => {
  it.each([
    'postgres://127.0.0.1:34263/postgres?host=100.96.203.105&port=7772',
    'postgres://127.0.0.1:34263/postgres?host=10.9.9.9',
    'postgres://127.0.0.1:34263/postgres?hostaddr=100.96.203.105&port=7773',
    'postgres://127.0.0.1:34263/postgres?sslmode=disable&host=127.0.0.1&port=56150',
    'postgres://127.0.0.1:34263/postgres?port=7772',
    'postgres://127.0.0.1:34263/postgres?dbname=isaflow',
    'postgres://127.0.0.1:34263/postgres?sslmode=disable&application_name=x',
  ])('refuses %s', (url) => {
    expect(() => assertParityTestUrl(url, ENV)).toThrow(/query parameter/);
  });

  it('accepts sslmode as the only query parameter', () => {
    expect(() => assertParityTestUrl('postgres://127.0.0.1:34263/postgres?sslmode=disable', ENV)).not.toThrow();
  });

  it.each(['%69saflow', '%69saflow_dev', 'isaflow%5Fdev', '%2569saflow'])('decodes the database path before the name check: %s', (db) => {
    expect(() => assertParityTestUrl(`postgres://127.0.0.1:34263/${db}`, ENV)).toThrow(/isaflow|encoded/);
  });
});

describe('assertOnlyThrowawayDatabases (server-side check before any CREATE/DROP)', () => {
  it('accepts a server holding only postgres, template0, template1 and parity_*', () => {
    expect(() => assertOnlyThrowawayDatabases(['postgres', 'template0', 'template1', 'parity_prod_t', 'parity_dev_t'])).not.toThrow();
  });

  it.each([['isaflow'], ['isaflow_dev'], ['app'], ['Parity_prod_t'], ['xparity_prod_t']])('refuses a server that also holds %s', (extra) => {
    expect(() => assertOnlyThrowawayDatabases(['postgres', 'template1', extra!])).toThrow(/not a throwaway|refusing/);
  });
});
