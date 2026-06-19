import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { StockoutPlan, Product, OrderItem, Order, ReplyVersion } from '../types';

const router = Router();

function convertReplyVersion(row: any): ReplyVersion {
  const cv: any = {};
  for (const [key, value] of Object.entries(row)) {
    cv[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  cv.is_confirmed = !!cv.is_confirmed;
  return cv as ReplyVersion;
}

function findAlternatives(productName: string, excludeProductId?: number): Product[] {
  let sql = `
    SELECT p.id, p.brand, p.name, p.specification, p.unit, p.stock, p.price
    FROM products p
    WHERE p.name LIKE ? AND p.stock > 0
  `;
  const params: any[] = [`%${productName}%`];

  if (excludeProductId) {
    sql += ' AND p.id != ?';
    params.push(excludeProductId);
  }

  sql += ' ORDER BY p.stock DESC, p.price ASC LIMIT 10';

  return query(sql, params) as Product[];
}

router.get('/order-item/:itemId/alternatives', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);

  const item = queryOne('SELECT * FROM order_items WHERE id = ?', [itemId]) as OrderItem;
  if (!item) {
    res.status(404).json({ error: '订单项不存在' });
    return;
  }

  const alternatives = findAlternatives(item.product_name, item.product_id);

  const differentBrand = alternatives.filter(p => p.brand !== item.brand);
  const differentSpec = alternatives.filter(p => p.specification !== item.specification);

  res.json({
    originalItem: item,
    alternatives,
    brandAlternatives: differentBrand,
    specAlternatives: differentSpec,
    hasAlternatives: alternatives.length > 0,
  });
});

router.post('/order-item/:itemId/plan', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);
  const { plan_type, alternative_product_id, alternative_brand, alternative_spec, restock_date, split_shipment } = req.body;

  const item = queryOne('SELECT * FROM order_items WHERE id = ?', [itemId]) as OrderItem;
  if (!item) {
    res.status(404).json({ error: '订单项不存在' });
    return;
  }

  if (!plan_type || !['alternative', 'restock', 'split'].includes(plan_type)) {
    res.status(400).json({ error: '请提供有效的缺货方案类型: alternative, restock, split' });
    return;
  }

  let finalAltBrand = alternative_brand || null;
  let finalAltSpec = alternative_spec || null;
  let finalAltProductId = alternative_product_id || null;

  if (plan_type === 'alternative') {
    if (!alternative_product_id && !alternative_brand) {
      res.status(400).json({ error: '替代方案需要提供替代产品ID或替代品牌' });
      return;
    }

    if (alternative_product_id) {
      const altProduct = queryOne('SELECT * FROM products WHERE id = ?', [alternative_product_id]) as Product;
      if (altProduct) {
        finalAltBrand = altProduct.brand;
        finalAltSpec = altProduct.specification;
        finalAltProductId = altProduct.id;
      }
    }
  }
  if (plan_type === 'restock' && !restock_date) {
    res.status(400).json({ error: '补货方案需要提供预计补货日期' });
    return;
  }
  if (plan_type === 'split' && !split_shipment) {
    res.status(400).json({ error: '拆单方案需要提供拆分数量' });
    return;
  }

  const existing = queryOne('SELECT id FROM stockout_plans WHERE order_item_id = ?', [itemId]);
  if (existing) {
    run('DELETE FROM stockout_plans WHERE order_item_id = ?', [itemId]);
  }

  const result = run(
    `INSERT INTO stockout_plans (order_item_id, plan_type, alternative_brand, alternative_spec, alternative_product_id, restock_date, split_shipment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      itemId,
      plan_type,
      finalAltBrand,
      finalAltSpec,
      finalAltProductId,
      restock_date || null,
      split_shipment || null,
    ]
  );

  const plan = queryOne('SELECT * FROM stockout_plans WHERE id = ?', [result.lastInsertRowid]) as StockoutPlan;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [item.order_id]) as Order;
  if (order && order.status === 'draft') {
    run("UPDATE orders SET status = 'stockout_handling', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [item.order_id]);
  }

  let alternativeProduct: Product | undefined;
  if (finalAltProductId) {
    alternativeProduct = queryOne('SELECT * FROM products WHERE id = ?', [finalAltProductId]) as Product;
  }

  res.status(201).json({
    plan,
    alternativeProduct,
    autoFilled: !!(alternative_product_id && !alternative_brand),
  });
});

router.get('/order-item/:itemId/plan', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);

  const plan = queryOne('SELECT * FROM stockout_plans WHERE order_item_id = ?', [itemId]) as StockoutPlan;

  if (!plan) {
    res.status(404).json({ error: '该订单项暂无缺货处理方案' });
    return;
  }

  let alternativeProduct: Product | undefined;
  if (plan.alternative_product_id) {
    alternativeProduct = queryOne('SELECT * FROM products WHERE id = ?', [plan.alternative_product_id]) as Product;
  }

  res.json({
    plan,
    alternativeProduct,
  });
});

router.delete('/order-item/:itemId/plan', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);

  const result = run('DELETE FROM stockout_plans WHERE order_item_id = ?', [itemId]);
  if (result.changes === 0) {
    res.status(404).json({ error: '该订单项暂无缺货处理方案' });
    return;
  }

  res.json({ message: '缺货方案已删除' });
});

function generateReplyContent(orderId: number): string {
  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  if (!order) return '';

  const items = query('SELECT * FROM order_items WHERE order_id = ?', [orderId]) as OrderItem[];

  const availableItems = items.filter(i => i.stock_status === 'available');
  const outOfStockItems = items.filter(i => i.stock_status === 'out_of_stock' || i.stock_status === 'low_stock');

  const plans = query(
    'SELECT sp.* FROM stockout_plans sp WHERE sp.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)',
    [orderId]
  ) as StockoutPlan[];

  const planMap = new Map<number, StockoutPlan>();
  plans.forEach(p => planMap.set(p.order_item_id, p));

  let reply = '尊敬的诊所客户，您好！\n\n';
  reply += '关于您的订货需求，以下是确认回复：\n\n';

  if (availableItems.length > 0) {
    reply += '【正常发货商品】\n';
    availableItems.forEach((item, idx) => {
      reply += `${idx + 1}. ${item.brand ? item.brand + ' ' : ''}${item.product_name} ${item.specification} × ${item.quantity}${item.note ? '（' + item.note + '）' : ''}\n`;
    });
    reply += '\n';
  }

  if (outOfStockItems.length > 0) {
    reply += '【缺货商品处理方案】\n';
    outOfStockItems.forEach((item, idx) => {
      const plan = planMap.get(item.id);
      reply += `${idx + 1}. ${item.brand ? item.brand + ' ' : ''}${item.product_name} ${item.specification} × ${item.quantity}\n`;

      if (plan) {
        switch (plan.plan_type) {
          case 'alternative': {
            let altBrand = plan.alternative_brand || '';
            let altSpec = plan.alternative_spec || '';
            let altName = '';

            if (plan.alternative_product_id) {
              const altProduct = queryOne('SELECT * FROM products WHERE id = ?', [plan.alternative_product_id]) as Product;
              if (altProduct) {
                altBrand = altProduct.brand;
                altName = altProduct.name;
                altSpec = altProduct.specification;
              }
            }

            reply += `   → 处理方案：更换替代品牌\n`;
            const altParts = [altBrand, altName, altSpec].filter(Boolean);
            if (altParts.length > 0) {
              reply += `     替代产品：${altParts.join(' ')}\n`;
            }
            break;
          }
          case 'restock':
            reply += `   → 处理方案：等待补货\n`;
            if (plan.restock_date) {
              reply += `     预计到货日期：${plan.restock_date}\n`;
            }
            break;
          case 'split':
            reply += `   → 处理方案：拆单发货\n`;
            if (plan.split_shipment) {
              reply += `     先发 ${plan.split_shipment} 个，剩余到货后补发\n`;
            }
            break;
        }
      } else {
        reply += `   → 处理方案：待确认\n`;
      }
      reply += '\n';
    });
  }

  reply += '\n【订单备注】\n';
  if (order.urgency === 'emergency') {
    reply += `紧急程度：紧急 - ${order.urgency_note || '请尽快安排发货'}\n`;
  } else if (order.urgency === 'normal') {
    reply += `紧急程度：常规\n`;
  } else {
    reply += `紧急程度：可随下次常规配送\n`;
  }

  reply += '\n如有任何疑问，请随时联系我们的客服。感谢您的信任与支持！\n\n';
  reply += '客服团队';

  return reply;
}

router.get('/order/:orderId/reply', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const replyText = generateReplyContent(orderId);

  const lastVersion = queryOne(
    'SELECT version_number FROM reply_versions WHERE order_id = ? ORDER BY version_number DESC LIMIT 1',
    [orderId]
  ) as { version_number: number } | undefined;

  const nextVersion = (lastVersion?.version_number || 0) + 1;

  const { created_by } = req.query;
  const result = run(
    `INSERT INTO reply_versions (order_id, version_number, reply_text, status, created_by)
     VALUES (?, ?, ?, 'pending', ?)`,
    [orderId, nextVersion, replyText, (created_by as string) || null]
  );

  const savedVersion = queryOne('SELECT * FROM reply_versions WHERE id = ?', [result.lastInsertRowid]);

  res.json({
    order_id: orderId,
    reply_text: replyText,
    version: savedVersion ? convertReplyVersion(savedVersion) : null,
    generated_at: new Date().toISOString(),
  });
});

router.post('/order/:orderId/reply/:versionId/submit', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const versionId = parseInt(req.params.versionId);
  const { submitted_by } = req.body;

  const version = queryOne(
    'SELECT * FROM reply_versions WHERE id = ? AND order_id = ?',
    [versionId, orderId]
  );
  if (!version) {
    res.status(404).json({ error: '回复版本不存在' });
    return;
  }

  const v = convertReplyVersion(version);
  if (v.status !== 'pending') {
    res.status(400).json({ error: `只有 pending 状态的版本才能提交待确认，当前状态: ${v.status}` });
    return;
  }

  run(
    `UPDATE reply_versions SET status = 'submitted', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [submitted_by || null, versionId]
  );

  const updated = queryOne('SELECT * FROM reply_versions WHERE id = ?', [versionId]);
  res.json({
    version: updated ? convertReplyVersion(updated) : null,
    message: '已提交待主管确认',
  });
});

router.post('/order/:orderId/reply/:versionId/confirm', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const versionId = parseInt(req.params.versionId);
  const { confirmed_by } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const version = queryOne(
    'SELECT * FROM reply_versions WHERE id = ? AND order_id = ?',
    [versionId, orderId]
  );
  if (!version) {
    res.status(404).json({ error: '回复版本不存在，确认失败，已确认的版本不受影响' });
    return;
  }

  const v = convertReplyVersion(version);
  if (v.status !== 'submitted') {
    res.status(400).json({ error: `只有 submitted 状态的版本才能确认，当前状态: ${v.status}，已确认的版本不受影响` });
    return;
  }

  const existingConfirmed = queryOne(
    'SELECT * FROM reply_versions WHERE order_id = ? AND status = ?',
    [orderId, 'confirmed']
  );
  const existingSent = queryOne(
    'SELECT * FROM reply_versions WHERE order_id = ? AND status = ?',
    [orderId, 'sent']
  );

  if (existingConfirmed) {
    run(
      `UPDATE reply_versions SET status = 'replaced' WHERE id = ?`,
      [existingConfirmed.id]
    );
  }
  if (existingSent) {
    run(
      `UPDATE reply_versions SET status = 'replaced' WHERE id = ?`,
      [existingSent.id]
    );
  }

  run(
    `UPDATE reply_versions SET status = 'confirmed', is_confirmed = 1, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [confirmed_by || null, versionId]
  );

  run(
    `UPDATE orders SET status = 'ready_to_ship', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [orderId]
  );

  run(
    `INSERT INTO order_logs (order_id, action, operator, detail)
     VALUES (?, 'stockout_confirmed', ?, ?)`,
    [orderId, confirmed_by || null, v.reply_text || null]
  );

  const updated = queryOne('SELECT * FROM reply_versions WHERE id = ?', [versionId]);
  const updatedOrder = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);

  const updatedPreviousConfirmed = existingConfirmed
    ? queryOne('SELECT * FROM reply_versions WHERE id = ?', [existingConfirmed.id])
    : null;

  res.json({
    order: updatedOrder,
    confirmed_version: updated ? convertReplyVersion(updated) : null,
    previous_confirmed_version: updatedPreviousConfirmed ? convertReplyVersion(updatedPreviousConfirmed) : null,
    previous_sent_version: existingSent ? convertReplyVersion(existingSent) : null,
    message: '主管确认成功，此版本当前有效',
  });
});

router.post('/order/:orderId/reply/:versionId/reject', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const versionId = parseInt(req.params.versionId);
  const { rejected_by, rejection_note } = req.body;

  const version = queryOne(
    'SELECT * FROM reply_versions WHERE id = ? AND order_id = ?',
    [versionId, orderId]
  );
  if (!version) {
    res.status(404).json({ error: '回复版本不存在' });
    return;
  }

  const v = convertReplyVersion(version);
  if (v.status !== 'submitted') {
    res.status(400).json({ error: `只有 submitted 状态的版本才能拒绝，当前状态: ${v.status}` });
    return;
  }

  run(
    `UPDATE reply_versions SET status = 'rejected', rejected_by = ?, rejected_at = CURRENT_TIMESTAMP, rejection_note = ? WHERE id = ?`,
    [rejected_by || null, rejection_note || null, versionId]
  );

  const updated = queryOne('SELECT * FROM reply_versions WHERE id = ?', [versionId]);
  res.json({
    version: updated ? convertReplyVersion(updated) : null,
    message: '已拒绝该回复版本',
  });
});

router.post('/order/:orderId/reply/:versionId/send', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const versionId = parseInt(req.params.versionId);
  const { sent_by } = req.body;

  const version = queryOne(
    'SELECT * FROM reply_versions WHERE id = ? AND order_id = ?',
    [versionId, orderId]
  );
  if (!version) {
    res.status(404).json({ error: '回复版本不存在' });
    return;
  }

  const v = convertReplyVersion(version);
  if (v.status !== 'confirmed') {
    res.status(400).json({ error: `只有 confirmed 状态的版本才能标记已发送，当前状态: ${v.status}` });
    return;
  }

  run(
    `UPDATE reply_versions SET status = 'sent', sent_by = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [sent_by || null, versionId]
  );

  const updated = queryOne('SELECT * FROM reply_versions WHERE id = ?', [versionId]);
  res.json({
    version: updated ? convertReplyVersion(updated) : null,
    message: '已标记为已发送给诊所',
  });
});

router.post('/order/:orderId/confirm', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);
  const { reply_text, confirmed_by, version_id } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  run(
    'UPDATE reply_versions SET status = ? WHERE order_id = ? AND status = ?',
    ['replaced', orderId, 'confirmed']
  );
  run(
    'UPDATE reply_versions SET is_confirmed = 0 WHERE order_id = ? AND status = ?',
    [orderId, 'replaced']
  );

  if (version_id) {
    const version = queryOne('SELECT * FROM reply_versions WHERE id = ? AND order_id = ?', [version_id, orderId]) as any;
    if (!version) {
      res.status(404).json({ error: '回复版本不存在，确认失败，之前已确认的版本不受影响' });
      return;
    }
    run(
      'UPDATE reply_versions SET status = ?, is_confirmed = 1, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['confirmed', confirmed_by || null, version_id]
    );
  }

  run(
    `UPDATE orders SET status = 'ready_to_ship', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [orderId]
  );

  const finalReplyText = version_id
    ? (queryOne('SELECT reply_text FROM reply_versions WHERE id = ?', [version_id]) as any)?.reply_text
    : (reply_text || generateReplyContent(orderId));

  if (!version_id) {
    const lastVersion = queryOne(
      'SELECT version_number FROM reply_versions WHERE order_id = ? ORDER BY version_number DESC LIMIT 1',
      [orderId]
    ) as { version_number: number } | undefined;

    const nextVersion = (lastVersion?.version_number || 0) + 1;
    run(
      `INSERT INTO reply_versions (order_id, version_number, reply_text, status, is_confirmed, confirmed_by, confirmed_at, created_by)
       VALUES (?, ?, ?, 'confirmed', 1, ?, CURRENT_TIMESTAMP, ?)`,
      [orderId, nextVersion, finalReplyText, confirmed_by || null, confirmed_by || null]
    );
  }

  run(
    `INSERT INTO order_logs (order_id, action, operator, detail)
     VALUES (?, 'stockout_confirmed', ?, ?)`,
    [orderId, confirmed_by || null, finalReplyText || null]
  );

  const confirmedVersions = query(
    'SELECT * FROM reply_versions WHERE order_id = ? AND status = ? ORDER BY version_number DESC LIMIT 1',
    [orderId, 'confirmed']
  );

  const confirmedVersion = confirmedVersions[0];

  const updated = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  res.json({
    order: updated,
    reply_text: finalReplyText,
    confirmed_version: confirmedVersion ? convertReplyVersion(confirmedVersion) : null,
  });
});

router.get('/order/:orderId/reply-history', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const versions = query(
    'SELECT * FROM reply_versions WHERE order_id = ? ORDER BY version_number ASC',
    [orderId]
  );

  const convertedVersions = versions.map((v: any) => convertReplyVersion(v));

  const confirmedVersion = convertedVersions.find((v: any) => v.status === 'confirmed');
  const sentVersion = convertedVersions.find((v: any) => v.status === 'sent');
  const submittedVersion = convertedVersions.find((v: any) => v.status === 'submitted');

  const activeVersion = sentVersion || confirmedVersion || null;

  res.json({
    order_id: orderId,
    versions: convertedVersions,
    total_versions: convertedVersions.length,
    current_active_version_id: activeVersion?.id || null,
    current_active_version_number: activeVersion?.version_number || null,
    current_status: activeVersion?.status || null,
    confirmed_version_id: confirmedVersion?.id || null,
    confirmed_version_number: confirmedVersion?.version_number || null,
    sent_version_id: sentVersion?.id || null,
    sent_version_number: sentVersion?.version_number || null,
    submitted_version_id: submittedVersion?.id || null,
    submitted_version_number: submittedVersion?.version_number || null,
  });
});

router.get('/order/:orderId/summary', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.orderId);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const items = query('SELECT * FROM order_items WHERE order_id = ?', [orderId]) as OrderItem[];
  const plans = query(
    'SELECT sp.* FROM stockout_plans sp WHERE sp.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)',
    [orderId]
  ) as StockoutPlan[];

  const availableCount = items.filter(i => i.stock_status === 'available').length;
  const outOfStockCount = items.filter(i => i.stock_status === 'out_of_stock').length;
  const lowStockCount = items.filter(i => i.stock_status === 'low_stock').length;
  const plannedCount = plans.length;

  res.json({
    order_id: orderId,
    order_no: order.order_no,
    total_items: items.length,
    available_count: availableCount,
    out_of_stock_count: outOfStockCount,
    low_stock_count: lowStockCount,
    planned_count: plannedCount,
    all_planned: (outOfStockCount + lowStockCount) === plannedCount,
    items_with_plans: items.map(item => ({
      ...item,
      plan: plans.find(p => p.order_item_id === item.id) || null,
    })),
  });
});

export default router;
