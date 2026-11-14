import { describe, expect, it } from 'vitest';
import { webhookUrlRefusal } from '@/modules/admin/services/webhookUrlPolicy';

const REFUSED = [
  'https://localhost/x', 'https://localhost./x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x',
  'https://172.16.0.1/x', 'https://192.168.1.10/x', 'https://169.254.169.254/x', 'https://0.0.0.0/x', 'https://2130706433/x',
  'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:127.0.0.1]/x',
  'https://[::127.0.0.1]/x', 'https://[::7f00:1]/x', 'https://[64:ff9b::7f00:1]/x', 'https://[::ffff:0:7f00:1]/x',
  'https://100.64.0.1/x', 'https://192.0.0.1/x', 'https://198.18.0.1/x', 'https://[fec0::1]/x',
  'https://224.0.0.1/x', 'https://255.255.255.255/x', 'https://[ff02::1]/x',
];
const ALLOWED = ['https://hooks.example.com/x', 'https://8.8.8.8/x', 'https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://[2606:4700::1111]/x'];

describe('webhookUrlRefusal', () => {
  it.each(REFUSED)('refuses %s', (url) => { expect(webhookUrlRefusal(url)).toMatch(/public host|https/); });
  it.each(ALLOWED)('allows %s', (url) => { expect(webhookUrlRefusal(url)).toBeNull(); });
  it.each(['http://hooks.example.com/x', 'ftp://h.example.com/x', 'javascript:alert(1)', 'not a url'])('refuses scheme/format %s', (url) => {
    expect(webhookUrlRefusal(url)).toMatch(/https/);
  });
});
