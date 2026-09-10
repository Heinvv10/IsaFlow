import {sql} from '@/lib/neon';
import type {AccessReviewInput} from './accessControlReviewInput';
/** Fixed metadata projection. Do not add token material or caller SQL fragments. */
export function accessReviewQuery(company:string,input:AccessReviewInput){
 return sql`WITH population AS MATERIALIZED (
  SELECT cu.user_id::text AS id,cu.user_id,'membership'::text AS kind,NULL::text[] AS scopes,
   cu.created_at,NULL::timestamptz AS last_used_at,NULL::timestamptz AS revoked_at,
   NULL::timestamptz AS access_expires_at,NULL::timestamptz AS refresh_expires_at,false AS scopes_oversized
   FROM company_users cu WHERE cu.company_id=${company}::uuid AND ${input.kind}='membership'
  UNION ALL
  SELECT p.id::text,p.user_id,'pat',CASE WHEN pg_column_size(p.scopes)<=8192 THEN p.scopes ELSE NULL END,
   p.created_at,p.last_used_at,p.revoked_at,p.expires_at,NULL::timestamptz,pg_column_size(p.scopes)>8192
   FROM personal_access_tokens p WHERE p.company_id=${company}::uuid AND ${input.kind}='pat'
  UNION ALL
  SELECT a.id::text,a.user_id,'oauth',CASE WHEN pg_column_size(a.scopes)<=8192 THEN a.scopes ELSE NULL END,
   a.created_at,a.last_used_at,a.revoked_at,a.access_token_expires_at,a.refresh_token_expires_at,pg_column_size(a.scopes)>8192
   FROM oauth_authorisations a WHERE a.company_id=${company}::uuid AND ${input.kind}='oauth'
 ), page AS (
  SELECT * FROM population WHERE (${input.after}::text IS NULL OR id COLLATE "C">${input.after}::text COLLATE "C")
  ORDER BY id COLLATE "C" LIMIT ${input.limit+1}
 ), census AS (SELECT count(*)::text AS total FROM population)
 SELECT census.total,clock_timestamp() AS evaluated_at,
  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
   'id',p.id,'personId',p.user_id,'kind',p.kind,'role',cu.role,
   'profile',CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('is_active',u.is_active,'status',u.status,'suspended_at',u.suspended_at) END,
   'scopes',p.scopes,'createdAt',p.created_at,'lastUsedAt',p.last_used_at,'revokedAt',p.revoked_at,
   'accessExpiresAt',p.access_expires_at,'refreshExpiresAt',p.refresh_expires_at,'overrides',COALESCE(o.items,'[]'::jsonb)) END AS subject,
  COALESCE(p.scopes_oversized,false) OR COALESCE(o.oversized,false) AS oversized
 FROM census LEFT JOIN page p ON true
 LEFT JOIN company_users cu ON cu.company_id=${company}::uuid AND cu.user_id=p.user_id
 LEFT JOIN users u ON u.id=p.user_id
 LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('moduleKey',r.module_key,'moduleName',r.module_key,
   'canRead',r.can_read,'canWrite',r.can_write,'canDelete',r.can_delete,'canExport',r.can_export,'canApprove',r.can_approve,
   'accountRangeFrom',r.account_range_from,'accountRangeTo',r.account_range_to,
   'restrictions',CASE WHEN pg_column_size(r.restrictions)<=1024 THEN r.restrictions ELSE NULL END) ORDER BY r.module_key) AS items,
   count(*)>128 OR COALESCE(bool_or(pg_column_size(r.restrictions)>1024),false) AS oversized
  FROM (SELECT module_key,can_read,can_write,can_delete,can_export,can_approve,account_range_from,account_range_to,restrictions
   FROM company_user_permissions WHERE company_id=${company}::uuid AND user_id=p.user_id ORDER BY module_key LIMIT 129) r
 ) o ON p.id IS NOT NULL ORDER BY p.id COLLATE "C"`;
}
