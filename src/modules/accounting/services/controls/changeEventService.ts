import { createHash, randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { isRealCalendarDate, UUID_RE } from '@/lib/validation';
import { assertControlTx } from './context';
import { protectChangeValues } from './changeProtection';
import type { ChangeEventInput, ControlTx } from './contracts';

/** Mandatory event and exact restricted evidence share the caller's transaction. */
export async function recordCommittedChange(ctx: ControlTx, input: ChangeEventInput): Promise<{ eventId: string; newVersion: number }> {
  try {
    assertControlTx(ctx);
    if (!input.entityType || !input.entityId || !input.action || input.action.length > 100
      || !Number.isSafeInteger(input.newVersion) || input.newVersion < 1
      || (input.previousVersion === null ? input.newVersion !== 1
        : !Number.isSafeInteger(input.previousVersion) || input.previousVersion < 1 || input.newVersion !== input.previousVersion + 1)
      || (input.accountingDate !== null && !isRealCalendarDate(input.accountingDate))) {
      throw new Error('Invalid committed change version or accounting date');
    }
    if (input.operationId !== undefined && !UUID_RE.test(input.operationId)) throw new Error('Invalid control operation ID');
    if (input.protectedEvidenceRef !== null) throw new Error('Exact change evidence must be created with its event');
    const protectedValues = protectChangeValues(input.entityType, input.before, input.after);
    // This digest protects retained ciphertext; it is not a public bank-data hash.
    const materialHash = createHash('sha256').update(protectedValues.protectedPayload.ciphertext).digest('hex');
    const p = ctx.principal;
    // A lineage retained under another spelling of the same id is extended in place, never forked beside,
    // and its event and evidence rows join that same lineage rather than the caller's spelling.
    const [retained] = await ctx.sql`SELECT entity_id FROM control_entity_versions WHERE company_id=${p.companyId}::uuid
      AND entity_type=${input.entityType} AND lower(entity_id)=lower(${input.entityId})
      ORDER BY (entity_id=${input.entityId}) DESC,entity_id LIMIT 1` as { entity_id: string }[];
    const entityId = retained ? retained.entity_id : input.entityId;
    const versions = input.previousVersion === null
      ? await ctx.sql`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
          SELECT ${p.companyId}::uuid,${input.entityType},${entityId},${input.newVersion},${materialHash}
          WHERE NOT EXISTS(SELECT 1 FROM control_entity_versions WHERE company_id=${p.companyId}::uuid
            AND entity_type=${input.entityType} AND lower(entity_id)=lower(${entityId}))
          ON CONFLICT(company_id,entity_type,entity_id) DO NOTHING RETURNING version`
      : await ctx.sql`UPDATE control_entity_versions SET version=${input.newVersion},material_hash=${materialHash},updated_at=clock_timestamp()
          WHERE company_id=${p.companyId}::uuid AND entity_type=${input.entityType} AND entity_id=${entityId}
            AND version=${input.previousVersion} RETURNING version`;
    if (versions.length !== 1) throw new Error('Control entity version is stale');
    const evidenceId = randomUUID(), eventId = randomUUID();
    const envelope = protectedValues.protectedPayload;
    const evidenceRows = await ctx.sql`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext)
      VALUES(${p.companyId}::uuid,${evidenceId}::uuid,${input.entityType},${entityId},${envelope.keyId},${envelope.version},${envelope.ciphertext}) RETURNING id` as { id: string }[];
    if (evidenceRows.length !== 1 || evidenceRows[0]?.id !== evidenceId) throw new Error('Mandatory protected evidence INSERT was not retained');
    const eventRows = await ctx.sql`INSERT INTO control_change_events(company_id,id,person_id,connection_id,grant_id,acting_firm_id,
      request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,accounting_date,
      before_values,after_values,binding_hash,protected_evidence_id)
      VALUES(${p.companyId}::uuid,${eventId}::uuid,${p.personId},${p.connectionId},${p.grantId},${p.actingFirmId},
        ${p.requestId}::uuid,${input.operationId ?? p.operationId}::uuid,${p.provenance},${input.entityType},${entityId},
        ${input.previousVersion},${input.newVersion},${input.action},${input.accountingDate}::date,
        ${JSON.stringify(protectedValues.before)}::jsonb,${JSON.stringify(protectedValues.after)}::jsonb,
        ${input.bindingHash},${evidenceId}::uuid) RETURNING id` as { id: string }[];
    if (eventRows.length !== 1 || eventRows[0]?.id !== eventId) throw new Error('Mandatory change event INSERT was not retained');
    return { eventId, newVersion: input.newVersion };
  } catch (error) {
    // A route catching a refusal must not commit a mutation without its evidence.
    const store = als.getStore();
    if (store) store.controlWriteFailed = true;
    throw error;
  }
}
