import {parseHistoricalImportArtifact} from './historicalImportExactPlan';
import {extractHistoricalCsvGroups,type HistoricalCsvExtraction} from './historicalImportCsvAdapter';
import {canonicalJson} from './canonical';
export interface HistoricalCsvArtifact {
 artifactVersion:2;extractor:{id:'gl_csv';version:1};evidenceKind:'original_upload';extraction:{options:HistoricalCsvExtraction;groupKey:string};
}
/** Extractor identity is versioned and immutable. Unknown versions never fall back to another parser. */
export function extractHistoricalArtifactGroup(bytes:Buffer,mimeType:string,artifact?:unknown){
 if(artifact===undefined)return parseHistoricalImportArtifact(bytes,mimeType);
 canonicalJson(artifact);
 if(!artifact||typeof artifact!=='object'||Array.isArray(artifact))throw new Error('Invalid historical extractor contract');
 const value=artifact as HistoricalCsvArtifact;
 if(Object.keys(value).some(key=>!['artifactVersion','extractor','evidenceKind','extraction'].includes(key))
  ||value.artifactVersion!==2||value.extractor?.id!=='gl_csv'||value.extractor.version!==1||value.evidenceKind!=='original_upload'
  ||Object.keys(value.extractor).some(key=>!['id','version'].includes(key))||mimeType!=='text/csv'
  ||!value.extraction||typeof value.extraction.groupKey!=='string'||Object.keys(value.extraction).some(key=>!['options','groupKey'].includes(key)))throw new Error('Unsupported historical extractor contract');
 const groups=extractHistoricalCsvGroups(bytes,value.extraction.options),group=groups.groups.find(group=>group.groupKey===value.extraction.groupKey);
 if(!group?.normalized)throw new Error('Historical selected source group is missing or invalid');
 return group.normalized;
}
