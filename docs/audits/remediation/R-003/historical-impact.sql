-- Read-only, one explicitly chosen company ($1). Never infer ownership from a saved number.
SELECT i.company_id, i.id AS inbox_id, i.address, i.is_active,
       i.provider_verified_at, i.created_at,
       count(e.id) AS capture_event_count,
       min(e.received_at) AS earliest_event_at,
       max(e.received_at) AS latest_event_at
FROM capture_inboxes i
LEFT JOIN capture_events e ON e.company_id = i.company_id AND e.inbox_id = i.id
WHERE i.company_id = $1::uuid AND i.channel = 'whatsapp'
  AND i.provider_verified_at IS NULL
GROUP BY i.company_id, i.id, i.address, i.is_active, i.provider_verified_at, i.created_at
ORDER BY i.created_at, i.id;
