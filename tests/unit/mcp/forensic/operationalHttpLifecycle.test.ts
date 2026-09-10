import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),close:vi.fn(),invocations:vi.fn(),auth:vi.fn(),neon:vi.fn()}));
vi.mock('../../../integration/controls/bankTransferControlFixture',()=>({transferControlFixture:async()=>({pool:{query:m.query},close:m.close})}));
vi.mock('../../../../scripts/forensic/fixture-bootstrap',()=>({fixtureConfigFromEnv:()=>({})}));
vi.mock('../../../integration/forensic-fixture',()=>({validateFixtureTarget:()=>({connectionString:'postgresql://127.0.0.1:33149/synthetic'})}));
vi.mock('@/lib/mcp/invocationStore',()=>({closeInvocationPool:m.invocations}));
vi.mock('@/lib/auth/authPool',()=>({getAuthPool:()=>({end:m.auth})}));
vi.mock('@/lib/neon',()=>({getPoolForTests:()=>({end:m.neon})}));
import {operationalCheckHttpFixture} from '../../../integration/controls/operationalCheckHttpFixture';
beforeEach(()=>{vi.clearAllMocks();for(const fn of [m.close,m.invocations,m.auth,m.neon])fn.mockResolvedValue(undefined);m.query.mockRejectedValue(new Error('Synthetic setup failure'));});
it('closes all opened resources when setup fails before returning a fixture',async()=>{
 await expect(operationalCheckHttpFixture()).rejects.toThrow('Synthetic setup failure');
 for(const fn of [m.close,m.invocations,m.auth,m.neon])expect(fn).toHaveBeenCalledOnce();
});
it('still closes other pools when one cleanup fails',async()=>{
 m.close.mockRejectedValueOnce(new Error('Synthetic pool close failure'));
 await expect(operationalCheckHttpFixture()).rejects.toThrow();
 for(const fn of [m.close,m.invocations,m.auth,m.neon])expect(fn).toHaveBeenCalledOnce();
});
