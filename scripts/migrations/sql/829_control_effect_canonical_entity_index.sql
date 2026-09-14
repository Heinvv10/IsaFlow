-- Receipt readers match one canonical spelling of entity_id, which neither existing
-- index on control_operation_effects can serve; this functional index does.
CREATE INDEX IF NOT EXISTS control_operation_effects_canonical_entity_idx
 ON control_operation_effects(company_id,operation,entity_type,lower(entity_id));
