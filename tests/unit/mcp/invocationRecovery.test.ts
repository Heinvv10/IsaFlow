import {expect,it} from 'vitest';
import {classifyInvocationProof} from '@/lib/mcp/invocationProof';
const completion={status:'ok' as const,reportedWrite:true,durationMs:1};
it('does not certify a committed tool without a surviving receipt',()=>{expect(classifyInvocationProof('committed',null)).toEqual({outcome:'unknown',completion:null});});
it('certifies committed receipt and proven abort independently',()=>{expect(classifyInvocationProof('committed',completion)).toEqual({outcome:'committed',completion});expect(classifyInvocationProof('aborted',null)).toEqual({outcome:'rolled_back',completion:null});});
it('does not infer rollback from absent receipts or unavailable transaction status',()=>{for(const status of ['in progress',null])expect(classifyInvocationProof(status,null).outcome).toBe('unknown');});
