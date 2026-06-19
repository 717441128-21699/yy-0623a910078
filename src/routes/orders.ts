import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { Order, OrderItem, Product, ParseResult, ParseResultItem, OrderWithItems } from '../types';

const router = Router();

function generateOrderNo(): string {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `DD${dateStr}${random}`;
}

function parseQuantityUnit(text: string): { quantity: number; unit: string; rest: string } {
  const patterns = [
    /(\d+)\s*(支|只|个|盒|包|袋|瓶|管|套|件|箱|卷|板|片)/g,
    /(两|二|三|四|五|六|七|八|九|十)\s*(支|只|个|盒|包|袋|瓶|管|套|件|箱|卷|板|片)/g,
    /(\d+)\s*/g,
  ];

  const cnNums: Record<string, number> = {
    '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  };

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const lastMatch = match[match.length - 1];
      const idx = text.lastIndexOf(lastMatch);
      const rest = text.substring(0, idx).trim();

      const numMatch = lastMatch.match(/(\d+|一|二|两|三|四|五|六|七|八|九|十)/);
      const unitMatch = lastMatch.match(/(支|只|个|盒|包|袋|瓶|管|套|件|箱|卷|板|片)/);

      let quantity = 1;
      let unit = '';

      if (numMatch) {
        const numStr = numMatch[1];
        quantity = cnNums[numStr] || parseInt(numStr) || 1;
      }
      if (unitMatch) {
        unit = unitMatch[1];
      }

      return { quantity, unit, rest };
    }
  }

  return { quantity: 1, unit: '', rest: text.trim() };
}

function parseOrderText(rawText: string): ParseResult {
  const items: ParseResultItem[] = [];
  const warnings: string[] = [];

  const separators = /[、，,；;。.\n\r]+/;
  const parts = rawText.split(separators).filter(s => s.trim().length > 0);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const { quantity, unit, rest } = parseQuantityUnit(trimmed);

    let productName = rest;
    let specification = '';

    const specMatch = rest.match(/([A-Za-z]\d+|[A-Za-z]+\s*\d+|\d+\s*[A-Za-z]+|大号|小号|中号|粗|细|长|短)/);
    if (specMatch) {
      specification = specMatch[0].trim();
      productName = rest.replace(specMatch[0], '').trim();
    }

    if (!productName && specification) {
      productName = specification;
      specification = '';
    }

    if (productName) {
      items.push({
        product_name: productName,
        specification: specification,
        quantity,
        raw_text: trimmed,
      });
    }
  }

  return { items, warnings };
}

function findSimilarProducts(productName: string, spec: string): Product[] {
  let sql = `
    SELECT id, brand, name, specification, unit, stock, price
    FROM products
    WHERE name LIKE ?
  `;
  const params: any[] = [`%${productName}%`];

  if (spec) {
    sql += ' AND specification LIKE ?';
    params.push(`%${spec}%`);
  }

  sql += ' ORDER BY name, brand, specification LIMIT 10';

  return query(sql, params) as Product[];
}

router.post('/parse', (req: Request, res: Response) => {
  const { text } = req.body;

  if (!text) {
    res.status(400).json({ error: '请提供原始订单文本' });
    return;
  }

  const result = parseOrderText(text);

  const itemsWithSimilar = result.items.map(item => {
    const similar = findSimilarProducts(item.product_name, item.specification);
    const hasMultipleSpecs = similar.length > 1;
    return {
      ...item,
      similarProducts: similar,
      hasMultipleSpecs,
      warning: hasMultipleSpecs
        ? `检测到 ${similar.length} 个同名不同规格的产品，请确认具体型号`
        : similar.length === 0
        ? '系统中未找到匹配产品，需手动确认'
        : null,
    };
  });

  const multipleSpecCount = itemsWithSimilar.filter(i => i.hasMultipleSpecs).length;
  const globalWarnings: string[] = [];
  if (multipleSpecCount > 0) {
    globalWarnings.push(`共 ${multipleSpecCount} 项存在同名不同规格情况，请注意核对规格，防止发错货`);
  }

  res.json({
    items: itemsWithSimilar,
    warnings: [...result.warnings, ...globalWarnings],
    totalItems: itemsWithSimilar.length,
  });
});

router.get('/', (req: Request, res: Response) => {
  const { status, source, urgency, clinicId, page = '1', pageSize = '20' } = req.query;
  const pageNum = parseInt(page as string);
  const size = parseInt(pageSize as string);
  const offset = (pageNum - 1) * size;

  let sql = `
    SELECT o.*, c.name as clinic_name
    FROM orders o
    LEFT JOIN clinics c ON o.clinic_id = c.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }
  if (source) {
    sql += ' AND o.source = ?';
    params.push(source);
  }
  if (urgency) {
    sql += ' AND o.urgency = ?';
    params.push(urgency);
  }
  if (clinicId) {
    sql += ' AND o.clinic_id = ?';
    params.push(clinicId);
  }

  const totalStmt = sql.replace('SELECT o.*, c.name as clinic_name', 'SELECT COUNT(*) as count');
  const total = queryOne(totalStmt, params) as { count: number };

  sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(size, offset);

  const orders = query(sql, params) as any[];

  res.json({
    data: orders,
    total: total?.count || 0,
    page: pageNum,
    pageSize: size,
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [id]) as Order;
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const items = query('SELECT * FROM order_items WHERE order_id = ?', [id]) as OrderItem[];
  const clinic = queryOne('SELECT * FROM clinics WHERE id = ?', [order.clinic_id]) as any;

  const orderWithItems: OrderWithItems = {
    ...order,
    items,
    clinic,
  };

  res.json(orderWithItems);
});

router.post('/', (req: Request, res: Response) => {
  const { clinic_id, source, raw_content, items, urgency = 'normal', urgency_note, created_by } = req.body;

  if (!clinic_id || !source) {
    res.status(400).json({ error: '诊所ID和订单来源为必填项' });
    return;
  }

  const clinic = queryOne('SELECT * FROM clinics WHERE id = ?', [clinic_id]);
  if (!clinic) {
    res.status(400).json({ error: '诊所不存在' });
    return;
  }

  const orderNo = generateOrderNo();

  const result = run(
    `INSERT INTO orders (order_no, clinic_id, source, raw_content, status, urgency, urgency_note, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [orderNo, clinic_id, source, raw_content || null, urgency, urgency_note || null, created_by || null]
  );

  const orderId = result.lastInsertRowid;

  if (items && items.length > 0) {
    let totalAmount = 0;

    for (const item of items) {
      let productId = item.product_id;
      let unitPrice = item.unit_price || 0;
      let stockStatus = 'available';

      if (productId) {
        const product = queryOne('SELECT * FROM products WHERE id = ?', [productId]) as Product;
        if (product) {
          unitPrice = product.price;
          if (product.stock === 0) {
            stockStatus = 'out_of_stock';
          } else if (product.stock < item.quantity) {
            stockStatus = 'low_stock';
          }
        }
      }

      const subtotal = unitPrice * item.quantity;
      totalAmount += subtotal;

      run(
        `INSERT INTO order_items (order_id, product_id, product_name, specification, brand, quantity, unit_price, subtotal, stock_status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          productId || null,
          item.product_name,
          item.specification || '',
          item.brand || null,
          item.quantity,
          unitPrice,
          subtotal,
          stockStatus,
          item.note || null,
        ]
      );
    }

    run('UPDATE orders SET total_amount = ? WHERE id = ?', [totalAmount, orderId]);
  }

  const orderWithItems = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  const orderItems = query('SELECT * FROM order_items WHERE order_id = ?', [orderId]) as OrderItem[];

  res.status(201).json({
    ...orderWithItems,
    items: orderItems,
  });
});

router.put('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { raw_content, urgency, urgency_note, status } = req.body;

  const existing = queryOne('SELECT * FROM orders WHERE id = ?', [id]) as Order;
  if (!existing) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  run(
    `UPDATE orders SET raw_content = ?, urgency = ?, urgency_note = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      raw_content ?? existing.raw_content,
      urgency ?? existing.urgency,
      urgency_note ?? existing.urgency_note,
      status ?? existing.status,
      id,
    ]
  );

  const updated = queryOne('SELECT * FROM orders WHERE id = ?', [id]) as Order;
  res.json(updated);
});

router.post('/:id/items', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.id);
  const { product_id, product_name, specification, brand, quantity, note } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  if (!product_name || !quantity) {
    res.status(400).json({ error: '品名和数量为必填项' });
    return;
  }

  let unitPrice = 0;
  let stockStatus = 'available';
  let actualProductId = product_id || null;
  let actualBrand = brand || null;
  let actualSpec = specification || '';
  let actualName = product_name;

  if (product_id) {
    const product = queryOne('SELECT * FROM products WHERE id = ?', [product_id]) as Product;
    if (product) {
      unitPrice = product.price;
      actualBrand = product.brand;
      actualSpec = product.specification;
      actualName = product.name;
      if (product.stock === 0) {
        stockStatus = 'out_of_stock';
      } else if (product.stock < quantity) {
        stockStatus = 'low_stock';
      }
    }
  }

  const subtotal = unitPrice * quantity;

  const result = run(
    `INSERT INTO order_items (order_id, product_id, product_name, specification, brand, quantity, unit_price, subtotal, stock_status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, actualProductId, actualName, actualSpec, actualBrand, quantity, unitPrice, subtotal, stockStatus, note || null]
  );

  const newItem = queryOne('SELECT * FROM order_items WHERE id = ?', [result.lastInsertRowid]) as OrderItem;

  const totalResult = queryOne('SELECT COALESCE(SUM(subtotal), 0) as total FROM order_items WHERE order_id = ?', [orderId]) as { total: number };
  run('UPDATE orders SET total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [totalResult.total, orderId]);

  res.status(201).json(newItem);
});

router.put('/:id/items/:itemId', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);
  const { product_id, product_name, specification, brand, quantity, note } = req.body;

  const existing = queryOne('SELECT * FROM order_items WHERE id = ?', [itemId]) as OrderItem;
  if (!existing) {
    res.status(404).json({ error: '订单项不存在' });
    return;
  }

  let unitPrice = existing.unit_price;
  let stockStatus = existing.stock_status;
  let actualProductId = product_id ?? existing.product_id;
  let actualBrand = brand ?? existing.brand;
  let actualSpec = specification ?? existing.specification;
  let actualName = product_name ?? existing.product_name;
  const actualQuantity = quantity ?? existing.quantity;

  if (product_id && product_id !== existing.product_id) {
    const product = queryOne('SELECT * FROM products WHERE id = ?', [product_id]) as Product;
    if (product) {
      unitPrice = product.price;
      actualBrand = product.brand;
      actualSpec = product.specification;
      actualName = product.name;
      if (product.stock === 0) {
        stockStatus = 'out_of_stock';
      } else if (product.stock < actualQuantity) {
        stockStatus = 'low_stock';
      } else {
        stockStatus = 'available';
      }
    }
  } else if (quantity && quantity !== existing.quantity && existing.product_id) {
    const product = queryOne('SELECT * FROM products WHERE id = ?', [existing.product_id]) as Product;
    if (product) {
      if (product.stock === 0) {
        stockStatus = 'out_of_stock';
      } else if (product.stock < actualQuantity) {
        stockStatus = 'low_stock';
      } else {
        stockStatus = 'available';
      }
    }
  }

  const subtotal = unitPrice * actualQuantity;

  run(
    `UPDATE order_items SET product_id = ?, product_name = ?, specification = ?, brand = ?, quantity = ?, unit_price = ?, subtotal = ?, stock_status = ?, note = ?
     WHERE id = ?`,
    [actualProductId, actualName, actualSpec, actualBrand, actualQuantity, unitPrice, subtotal, stockStatus, note ?? existing.note, itemId]
  );

  const totalResult = queryOne('SELECT COALESCE(SUM(subtotal), 0) as total FROM order_items WHERE order_id = ?', [existing.order_id]) as { total: number };
  run('UPDATE orders SET total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [totalResult.total, existing.order_id]);

  const updated = queryOne('SELECT * FROM order_items WHERE id = ?', [itemId]) as OrderItem;
  res.json(updated);
});

router.delete('/:id/items/:itemId', (req: Request, res: Response) => {
  const itemId = parseInt(req.params.itemId);

  const existing = queryOne('SELECT * FROM order_items WHERE id = ?', [itemId]) as OrderItem;
  if (!existing) {
    res.status(404).json({ error: '订单项不存在' });
    return;
  }

  run('DELETE FROM order_items WHERE id = ?', [itemId]);

  const totalResult = queryOne('SELECT COALESCE(SUM(subtotal), 0) as total FROM order_items WHERE order_id = ?', [existing.order_id]) as { total: number };
  run('UPDATE orders SET total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [totalResult.total, existing.order_id]);

  res.json({ message: '删除成功' });
});

export default router;
