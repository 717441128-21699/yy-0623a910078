import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { DeliveryHandover, Order, OrderItem } from '../types';

const router = Router();

router.get('/pending', (req: Request, res: Response) => {
  const { view = 'warehouse' } = req.query;

  let sql = `
    SELECT o.id as order_id, o.order_no, o.urgency, o.urgency_note, o.total_amount,
           c.name as clinic_name, c.address, c.contact_person, c.phone,
           dh.id as delivery_id, dh.pack_status, dh.delivery_status,
           dh.package_count, dh.warehouse_note, dh.driver_note,
           o.created_at
    FROM orders o
    LEFT JOIN clinics c ON o.clinic_id = c.id
    LEFT JOIN delivery_handover dh ON o.id = dh.order_id
    WHERE o.status IN ('ready_to_ship', 'shipped')
  `;

  if (view === 'warehouse') {
    sql += " AND (dh.pack_status != 'completed' OR dh.pack_status IS NULL)";
  } else if (view === 'driver') {
    sql += " AND dh.pack_status = 'completed' AND (dh.delivery_status != 'delivered' OR dh.delivery_status IS NULL)";
  }

  sql += ' ORDER BY ';
  sql += "CASE o.urgency WHEN 'emergency' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ";
  sql += 'o.created_at ASC';

  const deliveries = query(sql);

  const result = deliveries.map((d: any) => ({
    ...d,
    urgency_label: d.urgency === 'emergency' ? '紧急' : d.urgency === 'normal' ? '常规' : '可随下次配送',
    urgency_display: d.urgency === 'emergency'
      ? (d.urgency_note || '下午手术前必须到')
      : d.urgency === 'normal'
      ? '正常配送'
      : '可随下次常规配送',
  }));

  const emergencyCount = result.filter((d: any) => d.urgency === 'emergency').length;
  const normalCount = result.filter((d: any) => d.urgency === 'normal').length;
  const routineCount = result.filter((d: any) => d.urgency === 'routine').length;

  res.json({
    data: result,
    total: result.length,
    stats: {
      emergency: emergencyCount,
      normal: normalCount,
      routine: routineCount,
    },
    view: view as string,
  });
});

router.get('/order/:orderId', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  let delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;

  if (!delivery) {
    const result = run(
      `INSERT INTO delivery_handover (order_id, pack_status, delivery_status, package_count)
       VALUES (?, 'pending', 'pending', 0)`,
      [orderId]
    );
    delivery = queryOne('SELECT * FROM delivery_handover WHERE id = ?', [result.lastInsertRowid]) as DeliveryHandover;
  }

  const items = query('SELECT * FROM order_items WHERE order_id = ?', [orderId]) as OrderItem[];
  const clinic = queryOne('SELECT * FROM clinics WHERE id = ?', [order.clinic_id]) as any;

  const urgencyLabel = order.urgency === 'emergency' ? '紧急' : order.urgency === 'normal' ? '常规' : '可随下次配送';
  const urgencyDisplay = order.urgency === 'emergency'
    ? (order.urgency_note || '下午手术前必须到')
    : order.urgency === 'normal'
    ? '正常配送'
    : '可随下次常规配送';

  res.json({
    order: {
      id: order.id,
      order_no: order.order_no,
      source: order.source,
      status: order.status,
      urgency: order.urgency,
      urgency_label: urgencyLabel,
      urgency_display: urgencyDisplay,
      urgency_note: order.urgency_note,
      total_amount: order.total_amount,
      created_at: order.created_at,
    },
    clinic,
    items,
    delivery,
  });
});

router.put('/order/:orderId/urgency', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { urgency, urgency_note } = req.body;

  if (!urgency || !['emergency', 'normal', 'routine'].includes(urgency)) {
    res.status(400).json({ error: '请提供有效的紧急程度: emergency, normal, routine' });
    return;
  }

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  run(
    'UPDATE orders SET urgency = ?, urgency_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [urgency, urgency_note || null, orderId]
  );

  const updated = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;

  const urgencyLabel = updated.urgency === 'emergency' ? '紧急' : updated.urgency === 'normal' ? '常规' : '可随下次配送';
  const urgencyDisplay = updated.urgency === 'emergency'
    ? (updated.urgency_note || '下午手术前必须到')
    : updated.urgency === 'normal'
    ? '正常配送'
    : '可随下次常规配送';

  res.json({
    ...updated,
    urgency_label: urgencyLabel,
    urgency_display: urgencyDisplay,
  });
});

router.put('/order/:orderId/warehouse-note', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { warehouse_note, package_count } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  let delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;

  if (!delivery) {
    run(
      `INSERT INTO delivery_handover (order_id, warehouse_note, package_count, pack_status, delivery_status)
       VALUES (?, ?, ?, 'pending', 'pending')`,
      [orderId, warehouse_note || null, package_count || 0]
    );
  } else {
    run(
      'UPDATE delivery_handover SET warehouse_note = ?, package_count = ? WHERE order_id = ?',
      [warehouse_note ?? delivery.warehouse_note, package_count ?? delivery.package_count, orderId]
    );
  }

  delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;
  res.json(delivery);
});

router.put('/order/:orderId/pack-status', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { pack_status, handed_by } = req.body;

  if (!pack_status || !['pending', 'packing', 'completed'].includes(pack_status)) {
    res.status(400).json({ error: '请提供有效的打包状态: pending, packing, completed' });
    return;
  }

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  let delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;

  if (!delivery) {
    run(
      `INSERT INTO delivery_handover (order_id, pack_status, delivery_status, package_count, handed_by, handed_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
      [orderId, pack_status, handed_by || null, pack_status === 'completed' ? new Date().toISOString() : null]
    );
  } else {
    const handedAt = pack_status === 'completed' && delivery.pack_status !== 'completed'
      ? new Date().toISOString()
      : delivery.handed_at;

    run(
      'UPDATE delivery_handover SET pack_status = ?, handed_by = ?, handed_at = ? WHERE order_id = ?',
      [pack_status, handed_by ?? delivery.handed_by, handedAt, orderId]
    );
  }

  if (pack_status === 'completed') {
    run("UPDATE orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
  }

  delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;
  res.json(delivery);
});

router.put('/order/:orderId/driver-note', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { driver_note } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  let delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;

  if (!delivery) {
    run(
      `INSERT INTO delivery_handover (order_id, driver_note, pack_status, delivery_status, package_count)
       VALUES (?, ?, 'pending', 'pending', 0)`,
      [orderId, driver_note || null]
    );
  } else {
    run(
      'UPDATE delivery_handover SET driver_note = ? WHERE order_id = ?',
      [driver_note || null, orderId]
    );
  }

  delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;
  res.json(delivery);
});

router.put('/order/:orderId/delivery-status', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { delivery_status, received_by } = req.body;

  if (!delivery_status || !['pending', 'in_transit', 'delivered', 'failed'].includes(delivery_status)) {
    res.status(400).json({ error: '请提供有效的配送状态: pending, in_transit, delivered, failed' });
    return;
  }

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  let delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;

  if (!delivery) {
    run(
      `INSERT INTO delivery_handover (order_id, delivery_status, pack_status, package_count, received_by, received_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
      [orderId, delivery_status, received_by || null, delivery_status === 'delivered' ? new Date().toISOString() : null]
    );
  } else {
    const receivedAt = delivery_status === 'delivered' && delivery.delivery_status !== 'delivered'
      ? new Date().toISOString()
      : delivery.received_at;

    run(
      'UPDATE delivery_handover SET delivery_status = ?, received_by = ?, received_at = ? WHERE order_id = ?',
      [delivery_status, received_by ?? delivery.received_by, receivedAt, orderId]
    );
  }

  if (delivery_status === 'delivered') {
    run("UPDATE orders SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
  }

  delivery = queryOne('SELECT * FROM delivery_handover WHERE order_id = ?', [orderId]) as DeliveryHandover;
  res.json(delivery);
});

router.get('/stats/daily', (req: Request, res: Response) => {
  const today = new Date().toISOString().split('T')[0];

  const totalReady = queryOne(
    "SELECT COUNT(*) as count FROM orders WHERE status = 'ready_to_ship'"
  ) as { count: number };

  const totalShipped = queryOne(
    "SELECT COUNT(*) as count FROM orders WHERE status = 'shipped'"
  ) as { count: number };

  const totalCompleted = queryOne(
    `SELECT COUNT(*) as count FROM orders WHERE status = 'completed' AND DATE(created_at) = ?`,
    [today]
  ) as { count: number };

  const emergencyCount = queryOne(
    `SELECT COUNT(*) as count FROM orders WHERE urgency = 'emergency' AND status IN ('ready_to_ship', 'shipped')`
  ) as { count: number };

  const stats = {
    ready_to_ship: totalReady?.count || 0,
    shipped: totalShipped?.count || 0,
    completed_today: totalCompleted?.count || 0,
    emergency_pending: emergencyCount?.count || 0,
  };

  res.json(stats);
});

export default router;
