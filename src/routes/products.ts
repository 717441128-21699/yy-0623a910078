import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { Product } from '../types';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { keyword, category, brand, page = '1', pageSize = '20' } = req.query;
  const pageNum = parseInt(page as string);
  const size = parseInt(pageSize as string);
  const offset = (pageNum - 1) * size;

  let sql = 'SELECT * FROM products WHERE 1=1';
  const params: any[] = [];

  if (keyword) {
    sql += ' AND (name LIKE ? OR brand LIKE ? OR specification LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (brand) {
    sql += ' AND brand = ?';
    params.push(brand);
  }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
  const totalResult = queryOne(countSql, params) as { count: number };

  sql += ' ORDER BY name, brand, specification LIMIT ? OFFSET ?';
  params.push(size, offset);

  const products = query(sql, params) as Product[];

  res.json({
    data: products,
    total: totalResult?.count || 0,
    page: pageNum,
    pageSize: size,
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const product = queryOne('SELECT * FROM products WHERE id = ?', [req.params.id]) as Product;
  if (!product) {
    res.status(404).json({ error: '产品不存在' });
    return;
  }
  res.json(product);
});

router.post('/', (req: Request, res: Response) => {
  const { brand, name, specification, unit, stock = 0, price = 0, category } = req.body;

  if (!brand || !name || !specification || !unit) {
    res.status(400).json({ error: '品牌、品名、规格、单位为必填项' });
    return;
  }

  const existing = queryOne(
    'SELECT id FROM products WHERE brand = ? AND name = ? AND specification = ?',
    [brand, name, specification]
  ) as Product;

  if (existing) {
    res.status(409).json({ error: '该品牌同款同规格产品已存在', productId: existing.id });
    return;
  }

  const result = run(
    `INSERT INTO products (brand, name, specification, unit, stock, price, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [brand, name, specification, unit, stock, price, category || null]
  );

  const product = queryOne('SELECT * FROM products WHERE id = ?', [result.lastInsertRowid]) as Product;
  res.status(201).json(product);
});

router.put('/:id', (req: Request, res: Response) => {
  const { brand, name, specification, unit, stock, price, category } = req.body;
  const id = parseInt(req.params.id);

  const existing = queryOne('SELECT * FROM products WHERE id = ?', [id]) as Product;
  if (!existing) {
    res.status(404).json({ error: '产品不存在' });
    return;
  }

  run(
    `UPDATE products SET brand = ?, name = ?, specification = ?, unit = ?, stock = ?, price = ?, category = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      brand ?? existing.brand,
      name ?? existing.name,
      specification ?? existing.specification,
      unit ?? existing.unit,
      stock ?? existing.stock,
      price ?? existing.price,
      category ?? existing.category,
      id,
    ]
  );

  const updated = queryOne('SELECT * FROM products WHERE id = ?', [id]) as Product;
  res.json(updated);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = run('DELETE FROM products WHERE id = ?', [req.params.id]);
  if (result.changes === 0) {
    res.status(404).json({ error: '产品不存在' });
    return;
  }
  res.json({ message: '删除成功' });
});

router.post('/check-duplicates', (req: Request, res: Response) => {
  const { name, excludeId } = req.body;

  if (!name) {
    res.status(400).json({ error: '请提供品名' });
    return;
  }

  let sql = `
    SELECT id, brand, name, specification, unit, stock, price
    FROM products
    WHERE name LIKE ?
  `;
  const params: any[] = [`%${name}%`];

  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }

  sql += ' ORDER BY name, brand, specification';

  const products = query(sql, params) as Product[];

  const nameGroups: Record<string, Product[]> = {};
  products.forEach(p => {
    if (!nameGroups[p.name]) {
      nameGroups[p.name] = [];
    }
    nameGroups[p.name].push(p);
  });

  const hasMultipleSpecs: { name: string; products: Product[] }[] = [];
  for (const [n, prods] of Object.entries(nameGroups)) {
    const specs = new Set(prods.map(p => p.specification));
    if (specs.size > 1) {
      hasMultipleSpecs.push({ name: n, products: prods });
    }
  }

  res.json({
    total: products.length,
    products,
    hasMultipleSpecs,
    warning: hasMultipleSpecs.length > 0
      ? `检测到 ${hasMultipleSpecs.length} 个品名存在多种规格，请确认具体型号，防止发错货`
      : null,
  });
});

router.get('/search/similar', (req: Request, res: Response) => {
  const { name } = req.query;
  if (!name) {
    res.status(400).json({ error: '请提供品名关键词' });
    return;
  }

  const products = query(
    `SELECT id, brand, name, specification, unit, stock, price, category
     FROM products
     WHERE name LIKE ?
     ORDER BY name, brand, specification
     LIMIT 20`,
    [`%${name}%`]
  ) as Product[];

  const grouped: Record<string, Product[]> = {};
  products.forEach(p => {
    if (!grouped[p.name]) {
      grouped[p.name] = [];
    }
    grouped[p.name].push(p);
  });

  res.json({
    products,
    groupedByName: grouped,
    specCount: Object.keys(grouped).reduce((acc, key) => {
      acc[key] = grouped[key].length;
      return acc;
    }, {} as Record<string, number>),
  });
});

export default router;
