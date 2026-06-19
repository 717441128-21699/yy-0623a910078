import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db';
import { Clinic } from '../types';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { keyword, page = '1', pageSize = '20' } = req.query;
  const pageNum = parseInt(page as string);
  const size = parseInt(pageSize as string);
  const offset = (pageNum - 1) * size;

  let sql = 'SELECT * FROM clinics WHERE 1=1';
  const params: any[] = [];

  if (keyword) {
    sql += ' AND (name LIKE ? OR contact_person LIKE ? OR phone LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }

  const total = queryOne(sql.replace('SELECT *', 'SELECT COUNT(*) as count'), params) as { count: number };

  sql += ' ORDER BY name LIMIT ? OFFSET ?';
  params.push(size, offset);

  const clinics = query(sql, params) as Clinic[];

  res.json({
    data: clinics,
    total: total?.count || 0,
    page: pageNum,
    pageSize: size,
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const clinic = queryOne('SELECT * FROM clinics WHERE id = ?', [req.params.id]) as Clinic;
  if (!clinic) {
    res.status(404).json({ error: '诊所不存在' });
    return;
  }
  res.json(clinic);
});

router.post('/', (req: Request, res: Response) => {
  const { name, contact_person, phone, address } = req.body;

  if (!name) {
    res.status(400).json({ error: '诊所名称为必填项' });
    return;
  }

  const result = run(
    `INSERT INTO clinics (name, contact_person, phone, address)
     VALUES (?, ?, ?, ?)`,
    [name, contact_person || null, phone || null, address || null]
  );

  const clinic = queryOne('SELECT * FROM clinics WHERE id = ?', [result.lastInsertRowid]) as Clinic;
  res.status(201).json(clinic);
});

router.put('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { name, contact_person, phone, address } = req.body;

  const existing = queryOne('SELECT * FROM clinics WHERE id = ?', [id]) as Clinic;
  if (!existing) {
    res.status(404).json({ error: '诊所不存在' });
    return;
  }

  run(
    'UPDATE clinics SET name = ?, contact_person = ?, phone = ?, address = ? WHERE id = ?',
    [
      name ?? existing.name,
      contact_person ?? existing.contact_person,
      phone ?? existing.phone,
      address ?? existing.address,
      id,
    ]
  );

  const updated = queryOne('SELECT * FROM clinics WHERE id = ?', [id]) as Clinic;
  res.json(updated);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = run('DELETE FROM clinics WHERE id = ?', [req.params.id]);
  if (result.changes === 0) {
    res.status(404).json({ error: '诊所不存在' });
    return;
  }
  res.json({ message: '删除成功' });
});

export default router;
