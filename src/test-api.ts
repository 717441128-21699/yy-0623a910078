import http from 'http';

const BASE_URL = 'localhost';
const PORT = 3000;

function request(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: BASE_URL,
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = responseData ? JSON.parse(responseData) : null;
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function printResult(name: string, result: any, showData = false) {
  const status = result.status;
  const statusStr = status >= 200 && status < 300 ? `✅ ${status}` : `❌ ${status}`;
  console.log(`  ${statusStr}  ${name}`);
  if (showData && result.data) {
    console.log(`     ${JSON.stringify(result.data).slice(0, 120)}...`);
  }
}

async function runTests() {
  console.log('\n🧪 开始 API 接口测试...\n');

  console.log('📌 【健康检查】');
  let r = await request('GET', '/api/health');
  printResult('健康检查', r);

  console.log('\n📌 【诊所管理】');
  r = await request('GET', '/api/clinics');
  printResult('获取诊所列表', r, true);

  console.log('\n📌 【产品管理】');
  r = await request('GET', '/api/products');
  printResult('获取产品列表', r, true);

  r = await request('GET', '/api/products?keyword=' + encodeURIComponent('树脂'));
  printResult('搜索"树脂"产品', r, true);

  r = await request('POST', '/api/products/check-duplicates', { name: '树脂' });
  printResult('检测同名多规格 (树脂)', r, true);

  r = await request('GET', '/api/products/search/similar?name=' + encodeURIComponent('洁牙头'));
  printResult('相似产品搜索 (洁牙头)', r, true);

  console.log('\n📌 【订单整理工作区】');

  r = await request('POST', '/api/orders/parse', {
    text: '3M 树脂 A2 两支、麻醉针 30G 一盒、洁牙头五支',
  });
  printResult('解析订单文本', r, true);

  r = await request('POST', '/api/orders', {
    clinic_id: 1,
    source: 'wechat',
    raw_content: '3M 树脂 A2 两支、麻醉针 30G 一盒、洁牙头五支',
    urgency: 'emergency',
    urgency_note: '下午手术前必须到',
    created_by: '客服小王',
    items: [
      { product_id: 1, product_name: '树脂', specification: 'A2', quantity: 2 },
      { product_id: 7, product_name: '麻醉针', specification: '30G', quantity: 1 },
      { product_id: 11, product_name: '洁牙头', specification: '通用型', quantity: 5 },
    ],
  });
  printResult('创建订单', r, true);

  const orderId = r.data?.id || 1;

  r = await request('GET', `/api/orders/${orderId}`);
  printResult('获取订单详情', r, true);

  r = await request('POST', `/api/orders/${orderId}/items`, {
    product_id: 18,
    product_name: '牙胶尖',
    specification: '06锥度 25#',
    quantity: 3,
  });
  printResult('添加订单项', r, true);

  console.log('\n📌 【缺货回复工作区】');

  const lowStockItemId = 2;
  r = await request('GET', `/api/stockout/order-item/${lowStockItemId}/alternatives`);
  printResult('获取缺货替代品', r, true);

  r = await request('POST', `/api/stockout/order-item/${lowStockItemId}/plan`, {
    plan_type: 'alternative',
    alternative_product_id: 4,
    alternative_brand: '登士柏',
    alternative_spec: 'A2',
  });
  printResult('设置缺货方案-替代品牌', r, true);

  r = await request('GET', `/api/stockout/order/${orderId}/summary`);
  printResult('缺货处理汇总', r, true);

  r = await request('GET', `/api/stockout/order/${orderId}/reply`);
  printResult('生成回复文本', r, true);

  r = await request('POST', `/api/stockout/order/${orderId}/confirm`, {
    confirmed_by: '客服小王',
  });
  printResult('确认缺货方案', r, true);

  console.log('\n📌 【配送交接工作区】');

  r = await request('GET', '/api/delivery/pending?view=warehouse');
  printResult('仓库视图-待打包订单', r, true);

  r = await request('GET', `/api/delivery/order/${orderId}`);
  printResult('配送交接详情', r, true);

  r = await request('PUT', `/api/delivery/order/${orderId}/urgency`, {
    urgency: 'emergency',
    urgency_note: '下午2点手术前必须送到',
  });
  printResult('标注紧急程度', r, true);

  r = await request('PUT', `/api/delivery/order/${orderId}/warehouse-note`, {
    warehouse_note: '已检查所有商品，共3件',
    package_count: 1,
  });
  printResult('填写仓库备注', r, true);

  r = await request('PUT', `/api/delivery/order/${orderId}/pack-status`, {
    pack_status: 'completed',
    handed_by: '仓管员小李',
  });
  printResult('完成打包', r, true);

  r = await request('PUT', `/api/delivery/order/${orderId}/driver-note`, {
    driver_note: '请走南门，联系前台张护士',
  });
  printResult('填写司机备注', r, true);

  r = await request('PUT', `/api/delivery/order/${orderId}/delivery-status`, {
    delivery_status: 'delivered',
    received_by: '张医生',
  });
  printResult('确认送达', r, true);

  r = await request('GET', '/api/delivery/stats/daily');
  printResult('每日配送统计', r, true);

  console.log('\n🎉 所有 API 测试完成！\n');
}

runTests().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
