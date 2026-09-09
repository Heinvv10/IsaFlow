import {expect,it} from 'vitest';
import {copySnapshotArtifacts} from '@/modules/accounting/services/controls/auditSnapshotPublicationMaterial';
it('never reads caller byteLength overrides when enforcing the actual artifact byte budget',()=>{
 const bytes=Buffer.from('abc');let reads=0;
 Object.defineProperty(bytes,'byteLength',{get(){reads++;return Number.NaN;}});
 const result=copySnapshotArtifacts([{id:'source',bytes}]);
 expect(reads).toBe(0);expect(Buffer.from(result[0]!.bytes)).toEqual(Buffer.from('abc'));
});
it('copies retained bytes before later source mutation',()=>{
 const bytes=Buffer.from('abc'),result=copySnapshotArtifacts([{id:'source',bytes}]);bytes[0]=0;
 expect(Buffer.from(result[0]!.bytes).toString()).toBe('abc');
});
