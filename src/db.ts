import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let db: Database | null = null;
const dbPath = path.join(__dirname, '..', 'dental_orders.db');

export async function initDatabase(): Promise<Database> {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      specification TEXT NOT NULL,
      unit TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS clinics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      clinic_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      raw_content TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      urgency TEXT NOT NULL DEFAULT 'normal',
      urgency_note TEXT,
      total_amount REAL DEFAULT 0,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_urgency ON orders(urgency)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_clinic ON orders(clinic_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      specification TEXT NOT NULL,
      brand TEXT,
      quantity INTEGER NOT NULL,
      unit_price REAL DEFAULT 0,
      subtotal REAL DEFAULT 0,
      stock_status TEXT NOT NULL DEFAULT 'available',
      note TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS stockout_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL,
      plan_type TEXT NOT NULL,
      alternative_brand TEXT,
      alternative_spec TEXT,
      alternative_product_id INTEGER,
      restock_date TEXT,
      split_shipment INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_handover (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      warehouse_note TEXT,
      driver_note TEXT,
      pack_status TEXT DEFAULT 'pending',
      delivery_status TEXT DEFAULT 'pending',
      package_count INTEGER DEFAULT 0,
      handed_by TEXT,
      handed_at DATETIME,
      received_by TEXT,
      received_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_handover_order ON delivery_handover(order_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      operator TEXT,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      file_size INTEGER,
      description TEXT,
      uploaded_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_order_images_order ON order_images(order_id)`);

  saveDatabase();
  return db;
}

export function saveDatabase(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function query(sql: string, params: any[] = []): any[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];

  while (stmt.step()) {
    const row = stmt.getAsObject();
    const converted: any = {};
    for (const [key, value] of Object.entries(row)) {
      converted[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    results.push(converted);
  }
  stmt.free();

  return results;
}

export function queryOne(sql: string, params: any[] = []): any | undefined {
  const results = query(sql, params);
  return results[0];
}

export function run(sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } {
  const database = getDb();

  try {
    const stmt = database.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.free();
  } catch (e) {
    console.error('SQL run error:', sql, e);
    saveDatabase();
    return { lastInsertRowid: 0, changes: 0 };
  }

  let lastId = 0;

  try {
    const ridStmt = database.prepare('SELECT last_insert_rowid() as rid');
    ridStmt.step();
    const ridRow = ridStmt.getAsObject();
    const rid = (ridRow as any).rid;
    lastId = typeof rid === 'bigint' ? Number(rid) : (Number(rid) || 0);
    ridStmt.free();
  } catch (e) {
    console.error('Failed to get lastInsertRowid:', e);
    lastId = 0;
  }

  saveDatabase();

  return {
    lastInsertRowid: lastId,
    changes: 1,
  };
}
