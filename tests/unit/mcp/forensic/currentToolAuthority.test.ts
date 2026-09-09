import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ context: vi.fn(), resolve: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/context', () => ({ requireControlTx: mock.context }));
vi.mock('@/lib/auth/effectivePermissions', () => ({ resolveEffectivePermissions: mock.resolve }));
import { assertCurrentToolAuthority } from '@/lib/mcp/currentToolAuthority';
const ctx = { userId:'person',companyId:'company',tokenJti:'grant',oauthAppId:null,scopes:['write:invoices','write:post'] };
const tool = { name:'post_invoice',scope:'write:invoices',write:true,requiresPost:true };
beforeEach(() => {
  vi.clearAllMocks();
  mock.context.mockReturnValue({ principal:{ personId:'person',companyId:'company',grantId:'grant',authMethod:'pat' } });
  mock.resolve.mockResolvedValue({ permissions:['write:invoices','write:post'] });
});
it('checks current permissions before authorizing an already granted posting scope', async () => {
  await expect(assertCurrentToolAuthority(tool,ctx)).resolves.toBeUndefined();
  mock.resolve.mockResolvedValue({ permissions:['write:invoices'] });
  await expect(assertCurrentToolAuthority(tool,ctx)).rejects.toThrow('Current permissions');
});
it.each(['userId','companyId','tokenJti'])('rejects a mismatched authenticated %s before permission queries', async key => {
  await expect(assertCurrentToolAuthority(tool,{...ctx,[key]:'different'})).rejects.toThrow();
  expect(mock.resolve).not.toHaveBeenCalled();
});
it('requires a live authenticated transaction even for scope-null tools', async () => {
  mock.context.mockImplementation(() => { throw new Error('missing transaction'); });
  await expect(assertCurrentToolAuthority({...tool,scope:null,requiresPost:false},ctx)).rejects.toThrow();
});
it('rechecks current principal standing for scope-null tools', async () => {
  mock.resolve.mockRejectedValue(new Error('revoked'));
  await expect(assertCurrentToolAuthority({...tool,scope:null,requiresPost:false},ctx)).rejects.toThrow('revoked');
});
it('does not accept a cookie principal as an MCP bearer connection', async () => {
  mock.context.mockReturnValue({ principal:{ personId:'person',companyId:'company',grantId:'grant',authMethod:'cookie' } });
  await expect(assertCurrentToolAuthority(tool,ctx)).rejects.toThrow();
});
