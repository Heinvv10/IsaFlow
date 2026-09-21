-- READ ONLY. Bind $1 to an explicitly approved uuid[] of company IDs.
-- These are review candidates, NOT proof of unauthorized historical consent.
-- Current ownership/membership can differ from the state when the link was added.
SELECT bc.bureau_id, bc.company_id, bc.added_at, bc.added_by,
       b.owner_user_id AS current_bureau_owner,
       cu.role AS grantor_current_company_role,
       CASE WHEN bc.added_by IS NULL THEN 'missing_grantor'
            WHEN b.owner_user_id IS DISTINCT FROM bc.added_by THEN 'bureau_owner_changed_or_unproven'
            WHEN cu.role IS NULL THEN 'grantor_has_no_current_membership'
            WHEN cu.role NOT IN ('owner','admin') THEN 'grantor_lacks_current_management_role'
       END AS review_reason
FROM bureau_companies bc
JOIN bureaus b ON b.id = bc.bureau_id
LEFT JOIN company_users cu ON cu.company_id = bc.company_id AND cu.user_id = bc.added_by
WHERE bc.company_id = ANY($1::uuid[])
  AND (bc.added_by IS NULL OR b.owner_user_id IS DISTINCT FROM bc.added_by
       OR cu.role IS NULL OR cu.role NOT IN ('owner','admin'))
ORDER BY bc.company_id, bc.added_at;
