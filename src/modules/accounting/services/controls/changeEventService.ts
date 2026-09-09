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
    const versions = input.previousVersion === null
      ? await ctx.sql`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
          VALUES(${p.companyId}::uuid,${input.entityType},${input.entityId},${input.newVersion},${materialHash})
          ON CONFLICT(company_id,entity_type,entity_id) DO NOTHING RETURNING version`
      : await ctx.sql`UPDATE control_entity_versions SET version=${input.newVersion},material_hash=${materialHash},updated_at=clock_timestamp()
          WHERE company_id=${p.companyId}::uuid AND entity_type=${input.entityType} AND entity_id=${input.entityId}
            AND version=${input.previousVersion} RETURNING version`;
    if (versions.length !== 1) throw new Error('Control entity version is stale');
    const evidenceId = randomUUID(), eventId = randomUUID();
    const envelope = protectedValues.protectedPayload;
    await ctx.sql`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext)
      VALUES(${p.companyId}::uuid,${evidenceId}::uuid,${input.entityType},${input.entityId},${envelope.keyId},${envelope.version},${envelope.ciphertext})`;
    await ctx.sql`INSERT INTO control_change_events(company_id,id,person_id,connection_id,grant_id,acting_firm_id,
      request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,accounting_date,
      before_values,after_values,binding_hash,protected_evidence_id)
      VALUES(${p.companyId}::uuid,${eventId}::uuid,${p.personId},${p.connectionId},${p.grantId},${p.actingFirmId},
        ${p.requestId}::uuid,${input.operationId ?? p.operationId}::uuid,${p.provenance},${input.entityType},${input.entityId},
        ${input.previousVersion},${input.newVersion},${input.action},${input.accountingDate}::date,
        ${JSON.stringify(protectedValues.before)}::jsonb,${JSON.stringify(protectedValues.after)}::jsonb,
        ${input.bindingHash},${evidenceId}::uuid)`;
    return { eventId, newVersion: input.newVersion };
  } catch (error) {
    // A route catching a refusal must not commit a mutation without its evidence.
    const store = als.getStore();
    if (store) store.controlWriteFailed = true;
    throw error;
  }
}
