import { initDatabase, run, query } from './db';

const seedProducts = [
  { brand: '3M', name: '树脂', specification: 'A2', unit: '支', stock: 50, price: 120.0, category: '修复材料' },
  { brand: '3M', name: '树脂', specification: 'A3', unit: '支', stock: 30, price: 120.0, category: '修复材料' },
  { brand: '3M', name: '树脂', specification: 'B1', unit: '支', stock: 15, price: 125.0, category: '修复材料' },
  { brand: '登士柏', name: '树脂', specification: 'A2', unit: '支', stock: 25, price: 95.0, category: '修复材料' },
  { brand: '登士柏', name: '树脂', specification: 'A3', unit: '支', stock: 0, price: 95.0, category: '修复材料' },
  { brand: '义获嘉', name: '树脂', specification: 'A2', unit: '支', stock: 40, price: 150.0, category: '修复材料' },

  { brand: '日本马尼', name: '麻醉针', specification: '30G', unit: '盒', stock: 100, price: 85.0, category: '麻醉耗材' },
  { brand: '日本马尼', name: '麻醉针', specification: '27G', unit: '盒', stock: 80, price: 80.0, category: '麻醉耗材' },
  { brand: '日本马尼', name: '麻醉针', specification: '25G', unit: '盒', stock: 0, price: 75.0, category: '麻醉耗材' },
  { brand: 'BD', name: '麻醉针', specification: '30G', unit: '盒', stock: 60, price: 90.0, category: '麻醉耗材' },

  { brand: 'EMS', name: '洁牙头', specification: '通用型', unit: '支', stock: 200, price: 35.0, category: '洁牙耗材' },
  { brand: 'EMS', name: '洁牙头', specification: '牙周型', unit: '支', stock: 0, price: 45.0, category: '洁牙耗材' },
  { brand: '赛特力', name: '洁牙头', specification: '通用型', unit: '支', stock: 120, price: 38.0, category: '洁牙耗材' },
  { brand: '啄木鸟', name: '洁牙头', specification: '通用型', unit: '支', stock: 300, price: 25.0, category: '洁牙耗材' },

  { brand: '3M', name: '托槽', specification: 'MBT 022', unit: '副', stock: 45, price: 280.0, category: '正畸耗材' },
  { brand: '3M', name: '托槽', specification: 'ROTH 022', unit: '副', stock: 35, price: 270.0, category: '正畸耗材' },
  { brand: '奥美科', name: '托槽', specification: 'MBT 022', unit: '副', stock: 0, price: 260.0, category: '正畸耗材' },

  { brand: '日本森田', name: '牙胶尖', specification: '06锥度 25#', unit: '盒', stock: 80, price: 55.0, category: '根管耗材' },
  { brand: '日本森田', name: '牙胶尖', specification: '06锥度 30#', unit: '盒', stock: 75, price: 55.0, category: '根管耗材' },
  { brand: '登士柏', name: '牙胶尖', specification: '06锥度 25#', unit: '盒', stock: 60, price: 50.0, category: '根管耗材' },

  { brand: '豪孚迪', name: '车针', specification: '金刚砂球钻', unit: '支', stock: 150, price: 28.0, category: '牙科器械' },
  { brand: '固美', name: '车针', specification: '金刚砂球钻', unit: '支', stock: 200, price: 22.0, category: '牙科器械' },
];

const seedClinics = [
  { name: '阳光口腔诊所', contact_person: '张医生', phone: '13800138001', address: '北京市朝阳区阳光路123号' },
  { name: '康美牙科门诊', contact_person: '李护士', phone: '13800138002', address: '北京市海淀区康美路456号' },
  { name: '微笑齿科', contact_person: '王院长', phone: '13800138003', address: '北京市西城区微笑街789号' },
  { name: '雅美口腔医院', contact_person: '刘主任', phone: '13800138004', address: '北京市东城区雅美大道321号' },
  { name: '瑞尔齿科诊所', contact_person: '陈医生', phone: '13800138005', address: '北京市丰台区瑞尔路654号' },
];

async function seed() {
  await initDatabase();

  console.log('🌱 开始填充种子数据...\n');

  const existingProducts = query('SELECT COUNT(*) as count FROM products');
  if (existingProducts[0]?.count === 0) {
    console.log('📦 填充产品数据...');
    for (const p of seedProducts) {
      run(
        'INSERT INTO products (brand, name, specification, unit, stock, price, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [p.brand, p.name, p.specification, p.unit, p.stock, p.price, p.category]
      );
    }
    console.log(`   ✅ 已添加 ${seedProducts.length} 个产品`);
  } else {
    console.log(`   ℹ️  产品数据已存在，跳过 (${existingProducts[0].count} 个产品)`);
  }

  const existingClinics = query('SELECT COUNT(*) as count FROM clinics');
  if (existingClinics[0]?.count === 0) {
    console.log('🏥 填充诊所数据...');
    for (const c of seedClinics) {
      run(
        'INSERT INTO clinics (name, contact_person, phone, address) VALUES (?, ?, ?, ?)',
        [c.name, c.contact_person, c.phone, c.address]
      );
    }
    console.log(`   ✅ 已添加 ${seedClinics.length} 个诊所`);
  } else {
    console.log(`   ℹ️  诊所数据已存在，跳过 (${existingClinics[0].count} 个诊所)`);
  }

  console.log('\n🎉 种子数据填充完成！\n');

  console.log('📊 数据统计:');
  const productCount = query('SELECT COUNT(*) as count FROM products')[0]?.count || 0;
  const clinicCount = query('SELECT COUNT(*) as count FROM clinics')[0]?.count || 0;
  console.log(`   产品总数: ${productCount}`);
  console.log(`   诊所总数: ${clinicCount}`);
}

seed().catch(console.error);
