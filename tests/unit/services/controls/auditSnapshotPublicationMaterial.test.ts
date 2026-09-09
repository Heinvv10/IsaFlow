import type {AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {expect,it} from 'vitest';
import {assertSnapshotRequest,copySnapshotArtifacts} from '@/modules/accounting/services/controls/auditSnapshotPublicationMaterial';
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

it('requires the standalone Sage population for newly captured AP assurance',()=>{
 const sources=['supplier_invoice','supplier_invoice_line','supplier_payment','supplier_payment_allocation','sage_supplier_invoice'];
 const snapshot:AuditSnapshotData={version:1,companyId:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',capturedAt:'2026-09-09T00:00:00.000Z',records:[],evidence:[],coverage:[],missingSources:[],cutoff:'2026-09-09',populations:sources.map(source=>({source,count:0,excludedCount:0,exclusions:[]})),checks:[]};
 const request={cutoff:'2026-09-09',sources:['ap'] as const,checks:[],idempotencyKey:'synthetic'};
 expect(()=>assertSnapshotRequest(snapshot,{...request,sources:[...request.sources]})).not.toThrow();
 expect(()=>assertSnapshotRequest({...snapshot,populations:snapshot.populations.slice(0,4)},
  {...request,sources:[...request.sources]})).toThrow(/population/);
});

it('preserves exact historical AP source families for authenticated retained reads only',()=>{
 const snapshot:AuditSnapshotData={version:1,companyId:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',capturedAt:'2026-09-09T00:00:00.000Z',records:[],evidence:[],coverage:[],missingSources:[],cutoff:'2026-09-09',checks:[],
  populations:['supplier_invoice','supplier_invoice_line','supplier_payment','supplier_payment_allocation'].map(source=>({source,count:0,excludedCount:0,exclusions:[]}))};
 const request={cutoff:'2026-09-09',sources:['ap'] as ('ap')[],checks:[],idempotencyKey:'synthetic'};
 expect(()=>assertSnapshotRequest(snapshot,request,'retained')).not.toThrow();
 expect(()=>assertSnapshotRequest(snapshot,request)).toThrow(/population/);
 expect(()=>assertSnapshotRequest({...snapshot,populations:snapshot.populations.slice(1)},request,'retained')).toThrow(/population/);
});
