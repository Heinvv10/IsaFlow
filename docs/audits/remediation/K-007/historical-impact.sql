-- Read-only, selected company only. No foreign PO/supplier names are exposed.
SELECT g.id,g.grn_number,g.purchase_order_id,
       (po.id IS NULL) AS unowned_purchase_order,
       count(gi.id) FILTER (WHERE pi.id IS NULL) AS mismatched_item_lines,
       count(gi.id) FILTER (WHERE gi.quantity_received<0 OR gi.quantity_rejected<0) AS negative_quantity_lines
FROM goods_received_notes g
LEFT JOIN purchase_orders po ON po.id=g.purchase_order_id AND po.company_id=$1::uuid
LEFT JOIN grn_items gi ON gi.grn_id=g.id
LEFT JOIN po_items pi ON pi.id=gi.po_item_id AND pi.purchase_order_id=po.id
WHERE g.company_id=$1::uuid
GROUP BY g.id,po.id
ORDER BY g.grn_number,g.id;
