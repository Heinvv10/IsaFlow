-- READ ONLY. Bind $1 to the reviewed uuid[] company scope.
-- Reports weak legacy addresses and collisions; does not establish past misdelivery.
SELECT ci.id, ci.company_id, ci.address, ci.is_active, ci.created_at,
       (length(split_part(split_part(ci.address, '@', 1), 'cap-', 2)) = 6) AS legacy_short_address,
       EXISTS (
         SELECT 1 FROM capture_inboxes other
         WHERE other.channel = 'email' AND lower(other.address) = lower(ci.address)
           AND other.id <> ci.id
       ) AS normalized_address_collision
FROM capture_inboxes ci
WHERE ci.channel = 'email' AND ci.company_id = ANY($1::uuid[])
ORDER BY ci.company_id, ci.created_at;
