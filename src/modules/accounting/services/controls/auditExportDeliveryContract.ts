import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
/** Root-owned durable export delivery contract; identifiers come from an issued worker lease. */
export const EXPORT_DELIVERY_LIMITS=Object.freeze({chunkBytes:262144,pageFiles:100,maxFiles:100006,bundleBytes:1073741824});
export interface ExportDeliveryIdentity {
 companyId:string;jobId:string;leaseId:string;generation:number;snapshotId:string;canonicalSnapshotHash:string;
}
export interface ExportDeliveryHeader extends ExportDeliveryIdentity {
 version:1;fileCount:number;totalBytes:number;permissions:string[];
}
export interface ExportDeliveryFile extends ExportDeliveryIdentity {
 ordinal:number;path:string;mediaType:string;byteLength:number;sha256:string;chunkCount:number;
}
export type ExportDeliveryEnvelope=SnapshotIndexEnvelope;
export type ExportDeliveryRow=
 |{kind:'header';header:ExportDeliveryHeader;envelope:ExportDeliveryEnvelope}
 |{kind:'file';file:ExportDeliveryFile;envelope:ExportDeliveryEnvelope}
 |{kind:'chunk';fileOrdinal:number;chunkOrdinal:number;envelope:ExportDeliveryEnvelope};
