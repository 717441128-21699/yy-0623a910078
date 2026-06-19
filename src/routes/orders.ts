import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { Order, OrderItem, Product, ParseResult, ParseResultItem, OrderWithItems } from '../types';

const router = Router();

const CN_NUMS: Record<string, number> = {
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

const UNIT_SET = new Set(['支', '只', '个', '盒', '包', '袋', '瓶', '管', '套', '件', '箱', '卷', '板', '片']);

const KNOWN_BRANDS = [
  '3M', '登士柏', '义获嘉', '日本马尼', 'BD', 'EMS', '赛特力', '啄木鸟',
  '奥美科', '日本森田', '豪孚迪', '固美', '可乐丽', 'GC', 'DMG', 'IVOCLAR',
  'VIVADENT', 'KERR', 'DENTSPLY', 'HERAEUS', 'BEGO', 'WH',
];

function generateOrderNo(): string {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `DD${dateStr}${random}`;
}

function extractQuantityAndUnit(text: string): { quantity: number; unit: string; textBeforeQty: string } {
  const numUnitRe = /(\d+)\s*(支|只|个|盒|包|袋|瓶|管|套|件|箱|卷|板|片)/;
  const cnNumUnitRe = /(一|二|两|三|四|五|六|七|八|九|十)\s*(支|只|个|盒|包|袋|瓶|管|套|件|箱|卷|板|片)/;

  let m = text.match(numUnitRe);
  if (m && m.index !== undefined) {
    return {
      quantity: parseInt(m[1]) || 1,
      unit: m[2],
      textBeforeQty: text.substring(0, m.index).trim(),
    };
  }

  m = text.match(cnNumUnitRe);
  if (m && m.index !== undefined) {
    return {
      quantity: CN_NUMS[m[1]] || 1,
      unit: m[2],
      textBeforeQty: text.substring(0, m.index).trim(),
    };
  }

  const bareNumRe = /(\d+)$/;
  m = text.match(bareNumRe);
  if (m && m.index !== undefined) {
    return {
      quantity: parseInt(m[1]) || 1,
      unit: '',
      textBeforeQty: text.substring(0, m.index).trim(),
    };
  }

  return { quantity: 1, unit: '', textBeforeQty: text.trim() };
}

function extractBrand(text: string): { brand: string; rest: string } {
  for (const brand of KNOWN_BRANDS) {
    if (text.startsWith(brand)) {
      return { brand, rest: text.substring(brand.length).trim() };
    }
    const withSpace = brand + ' ';
    if (text.startsWith(withSpace)) {
      return { brand, rest: text.substring(withSpace.length).trim() };
    }
  }
  return { brand: '', rest: text };
}

function extractSpec(text: string): { spec: string; rest: string } {
  const specPatterns = [
    /([A-Z]\d+)/,
    /(\d+G)/,
    /(\d+#[^\s]*)/,
    /(06锥度\s*\d+#)/,
    /(大号|小号|中号|粗|细|长|短|通用型|牙周型)/,
  ];

  for (const pat of specPatterns) {
    const m = text.match(pat);
    if (m && m.index !== undefined) {
      const before = text.substring(0, m.index).trim();
      const after = text.substring(m.index + m[0].length).trim();
      const rest = (before + ' ' + after).trim();
      return { spec: m[1].trim(), rest };
    }
  }

  return { spec: '', rest: text };
}

function parseOrderText(rawText: string): ParseResult {
  const items: ParseResultItem[] = [];
  const warnings: string[] = [];

  const separators = /[、，,；;。.\n\r]+/;
  const parts = rawText.split(separators).filter(s => s.trim().length > 0);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const { quantity, unit, textBeforeQty } = extractQuantityAndUnit(trimmed);

    const { brand, rest: afterBrand } = extractBrand(textBeforeQty);

    const { spec, rest: productName } = extractSpec(afterBrand);

    const cleanName = productName.replace(/\s+/g, ' ').trim();

    if (cleanName || brand || spec) {
      items.push({
        brand,
        product_name: cleanName,
        specification: spec,
        quantity,
        unit,
        raw_text: trimmed,
      });
    }
  }

  return { items, warnings };
}

function findSimilarProducts(productName: string, spec: string, brand?: string): Product[] {
  let sql = `
    SELECT id, brand, name, specification, unit, stock, price
    FROM products
    WHERE 1=1
  `;
  const params: any[] = [];

  if (productName) {
    sql += ' AND name LIKE ?';
    params.push(`%${productName}%`);
  }
  if (spec) {
    sql += ' AND specification LIKE ?';
    params.push(`%${spec}%`);
  }
  if (brand) {
    sql += ' AND brand LIKE ?';
    params.push(`%${brand}%`);
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
    const similar = findSimilarProducts(item.product_name, item.specification, item.brand);

    const allByName = findSimilarProducts(item.product_name, '', '');

    const exactMatches = similar.filter(p =>
      p.name === item.product_name &&
      (!item.specification || p.specification === item.specification) &&
      (!item.brand || p.brand === item.brand)
    );

    const sameNameDiffSpec = allByName.filter(p =>
      p.name === item.product_name && p.specification !== (item.specification || '')
    );

    const hasMultipleSpecs = sameNameDiffSpec.length > 0;
    const hasExactMatch = exactMatches.length > 0;

    let specWarning: string | null = null;
    if (hasExactMatch && hasMultipleSpecs) {
      specWarning = `已匹配${item.brand ? ' ' + item.brand : ''} ${item.product_name} ${item.specification}，但同名还有其他规格：${sameNameDiffSpec.map(p => p.brand + ' ' + p.specification).join('、')}，请确认是否正确`;
    } else if (hasMultipleSpecs) {
      specWarning = `品名"${item.product_name}"存在多种规格（${sameNameDiffSpec.map(p => p.brand + ' ' + p.specification).join('、')}），请确认具体型号，防止发错货`;
    } else if (!hasExactMatch && similar.length > 0) {
      specWarning = `未找到完全匹配的产品，但有 ${similar.length} 个近似产品，需手动确认`;
    } else if (!hasExactMatch && similar.length === 0) {
      specWarning = '系统中未找到匹配产品，需手动录入';
    }

    return {
      ...item,
      similarProducts: similar,
      exactMatches,
      hasMultipleSpecs,
      hasExactMatch,
      specWarning,
    };
  });

  const multipleSpecCount = itemsWithSimilar.filter(i => i.hasMultipleSpecs).length;
  const noMatchCount = itemsWithSimilar.filter(i => !i.hasExactMatch).length;
  const globalWarnings: string[] = [];
  if (multipleSpecCount > 0) {
    globalWarnings.push(`共 ${multipleSpecCount} 项存在同名不同规格情况，请注意核对规格，防止发错货`);
  }
  if (noMatchCount > 0) {
    globalWarnings.push(`共 ${noMatchCount} 项未找到精确匹配，需要客服手动确认`);
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
  const images = query('SELECT * FROM order_images WHERE order_id = ?', [id]);

  const itemsWithSpecCheck = items.map(item => {
    let specWarning: string | null = null;
    let otherSpecs: Product[] = [];

    if (item.product_id && item.product_name) {
      otherSpecs = query(
        'SELECT id, brand, name, specification, unit, stock, price FROM products WHERE name = ? AND id != ?',
        [item.product_name, item.product_id]
      ) as Product[];
    } else if (item.product_name) {
      otherSpecs = query(
        'SELECT id, brand, name, specification, unit, stock, price FROM products WHERE name = ?',
        [item.product_name]
      ) as Product[];
    }

    if (item.product_id && otherSpecs.length > 0) {
      specWarning = `品名"${item.product_name}"还有其他规格：${otherSpecs.map(p => p.brand + ' ' + p.specification).join('、')}`;
    } else if (!item.product_id && otherSpecs.length > 1) {
      specWarning = `品名"${item.product_name}"存在多种规格：${otherSpecs.map(p => p.brand + ' ' + p.specification).join('、')}，请确认具体型号`;
    }

    return {
      ...item,
      specWarning,
      otherSpecs: otherSpecs.length > 0 ? otherSpecs : undefined,
    };
  });

  const orderWithItems: OrderWithItems = {
    ...order,
    items,
    clinic,
  };

  res.json({
    ...orderWithItems,
    images,
    organized: {
      raw_content: order.raw_content || null,
      image_count: images.length,
      item_count: items.length,
      items: itemsWithSpecCheck,
    },
  });
});

router.post('/', (req: Request, res: Response) => {
  const { clinic_id, source, raw_content, items, images, urgency = 'normal', urgency_note, created_by } = req.body;

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

  if (images && images.length > 0) {
    for (const img of images) {
      run(
        `INSERT INTO order_images (order_id, image_url, original_name, mime_type, file_size, description, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          img.image_url,
          img.original_name || null,
          img.mime_type || null,
          img.file_size || null,
          img.description || null,
          img.uploaded_by || created_by || null,
        ]
      );
    }
  }

  const orderWithItems = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]) as Order;
  const orderItems = query('SELECT * FROM order_items WHERE order_id = ?', [orderId]) as OrderItem[];
  const orderImages = query('SELECT * FROM order_images WHERE order_id = ?', [orderId]);

  res.status(201).json({
    ...orderWithItems,
    items: orderItems,
    images: orderImages,
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

  let specWarning: string | null = null;
  let otherSpecs: Product[] = [];
  if (actualProductId) {
    otherSpecs = query(
      'SELECT id, brand, name, specification, unit, stock, price FROM products WHERE name = ? AND id != ?',
      [actualName, actualProductId]
    ) as Product[];
    if (otherSpecs.length > 0) {
      specWarning = `品名"${actualName}"存在多种规格（${otherSpecs.map(p => p.brand + ' ' + p.specification).join('、')}），请确认是否为${actualBrand} ${actualSpec}`;
    }
  } else if (actualName) {
    otherSpecs = query(
      'SELECT id, brand, name, specification, unit, stock, price FROM products WHERE name = ?',
      [actualName]
    ) as Product[];
    if (otherSpecs.length > 1) {
      specWarning = `品名"${actualName}"存在多种规格（${otherSpecs.map(p => p.brand + ' ' + p.specification).join('、')}），请确认具体型号`;
    }
  }

  res.status(201).json({
    item: newItem,
    specWarning,
    otherSpecs: otherSpecs.length > 0 ? otherSpecs : undefined,
  });
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

router.get('/:id/images', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.id);

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  const images = query('SELECT * FROM order_images WHERE order_id = ?', [orderId]);
  res.json({ data: images, total: images.length });
});

router.post('/:id/images', (req: Request, res: Response) => {
  const orderId = parseInt(req.params.id);
  const { image_url, original_name, mime_type, file_size, description, uploaded_by } = req.body;

  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  if (!image_url) {
    res.status(400).json({ error: '图片地址(image_url)为必填项' });
    return;
  }

  const result = run(
    `INSERT INTO order_images (order_id, image_url, original_name, mime_type, file_size, description, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orderId, image_url, original_name || null, mime_type || null, file_size || null, description || null, uploaded_by || null]
  );

  const image = queryOne('SELECT * FROM order_images WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json(image);
});

router.delete('/:id/images/:imageId', (req: Request, res: Response) => {
  const imageId = parseInt(req.params.imageId);

  const existing = queryOne('SELECT * FROM order_images WHERE id = ?', [imageId]);
  if (!existing) {
    res.status(404).json({ error: '图片不存在' });
    return;
  }

  run('DELETE FROM order_images WHERE id = ?', [imageId]);
  res.json({ message: '图片已删除' });
});

export default router;
