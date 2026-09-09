import type {ProtectedChange} from './changeProtection';
export const SNAPSHOT_INDEX_SECTIONS=['records','checks','findings','evidence','gaps'] as const;
export type SnapshotIndexSection=typeof SNAPSHOT_INDEX_SECTIONS[number];
export const SNAPSHOT_INDEX_LIMITS=Object.freeze({chunkBytes:262144,pageItems:100,maxItems:800006});
export interface SnapshotIndexIdentity {companyId:string;snapshotId:string;canonicalHash:string}
export interface SnapshotIndexHeader extends SnapshotIndexIdentity {
 version:1;permissions:string[];counts:Record<SnapshotIndexSection,number>;
}
export interface SnapshotIndexItem extends SnapshotIndexIdentity {
 section:SnapshotIndexSection;ordinal:number;byteLength:number;sha256:string;chunkCount:number;
}
/** Ciphertext is not read authority. Readers recheck current permissions using the authenticated header. */
export interface SnapshotIndexEnvelope extends ProtectedChange {authentication:string}
export interface SnapshotIndexStoredItem {
 section:SnapshotIndexSection;ordinal:number;protectedItem:SnapshotIndexEnvelope;chunks:SnapshotIndexEnvelope[];
}
export interface SnapshotIndexMaterial {header:SnapshotIndexHeader;protectedHeader:SnapshotIndexEnvelope;items:SnapshotIndexStoredItem[]}
