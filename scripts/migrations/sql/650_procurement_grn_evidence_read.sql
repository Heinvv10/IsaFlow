-- Migration497 omitted the actual tenant-owned goods_received_notes parent.
-- Read access only: adding evidence retention does not authorize a new write path.
DROP POLICY IF EXISTS tenant_read_grn_evidence ON public.procurement_documents;
CREATE POLICY tenant_read_grn_evidence ON public.procurement_documents
 FOR SELECT TO app_user
 USING (
  entity_type IN ('grn','goods_received_note','goods_receipt_note')
  AND EXISTS (
   SELECT 1 FROM public.goods_received_notes p
   WHERE p.id=procurement_documents.entity_id
    AND p.company_id=app.current_company_id()
    AND p.company_id IN (SELECT auth.user_companies())
  )
 );
