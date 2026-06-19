import http from 'http';

const BASE_URL = 'localhost';
const PORT = 3000;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: string[] = [];

function request(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
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
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: responseData ? JSON.parse(responseData) : null });
        } catch (e) {
          resolve({ status: res.statusCode || 0, data: responseData });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(name: string, condition: boolean, detail?: string): void {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ ${name}`);
  } else {
    failedTests++;
    const msg = detail ? `${name} — ${detail}` : name;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function assertStatus(name: string, result: { status: number; data: any }, expected: number): void {
  assert(`${name} [HTTP ${result.status}]`, result.status === expected,
    `期望 ${expected}, 实际 ${result.status}`);
}

async function runTests() {
  console.log('\n🧪 开始 API 接口测试（含断言）\n');

  // ── 健康检查 ──
  console.log('📌 【健康检查】');
  let r = await request('GET', '/api/health');
  assertStatus('GET /api/health', r, 200);
  assert('service 字段', r.data?.service === 'dental-order-collab');

  // ── 诊所 ──
  console.log('\n📌 【诊所管理】');
  r = await request('GET', '/api/clinics');
  assertStatus('GET /api/clinics', r, 200);
  assert('诊所列表非空', Array.isArray(r.data?.data) && r.data.data.length > 0);

  r = await request('GET', '/api/clinics/999');
  assertStatus('GET 不存在的诊所 → 404', r, 404);

  // ── 产品 ──
  console.log('\n📌 【产品管理】');
  r = await request('GET', '/api/products');
  assertStatus('GET /api/products', r, 200);
  assert('产品列表非空', Array.isArray(r.data?.data) && r.data.data.length > 0);

  r = await request('GET', '/api/products?keyword=' + encodeURIComponent('树脂'));
  assertStatus('搜索"树脂"', r, 200);
  assert('树脂搜索有结果', Array.isArray(r.data?.data) && r.data.data.length > 0);

  r = await request('POST', '/api/products/check-duplicates', { name: '树脂' });
  assertStatus('同名多规格检测(树脂)', r, 200);
  assert('检测到同名多规格', r.data?.hasMultipleSpecs?.length > 0, `实际: ${JSON.stringify(r.data?.hasMultipleSpecs)}`);
  assert('警告文案不为空', !!r.data?.warning, `实际 warning: ${r.data?.warning}`);

  r = await request('GET', '/api/products/search/similar?name=' + encodeURIComponent('洁牙头'));
  assertStatus('相似产品搜索(洁牙头)', r, 200);

  r = await request('GET', '/api/products/999');
  assertStatus('GET 不存在的产品 → 404', r, 404);

  r = await request('POST', '/api/products', {});
  assertStatus('POST 产品缺必填项 → 400', r, 400);

  // ── 订单整理：解析 + 同名多规格提醒 ──
  console.log('\n📌 【订单整理工作区】');

  r = await request('POST', '/api/orders/parse', {
    text: '3M 树脂 A2 两支、麻醉针 30G 一盒、洁牙头五支',
  });
  assertStatus('POST /api/orders/parse', r, 200);
  assert('解析出3项', r.data?.totalItems === 3, `实际: ${r.data?.totalItems}`);

  const parseItems = r.data?.items || [];
  const item0 = parseItems[0];
  assert('第1项 brand=3M', item0?.brand === '3M', `实际: ${item0?.brand}`);
  assert('第1项 product_name=树脂', item0?.product_name === '树脂', `实际: ${item0?.product_name}`);
  assert('第1项 specification=A2', item0?.specification === 'A2', `实际: ${item0?.specification}`);
  assert('第1项 quantity=2', item0?.quantity === 2, `实际: ${item0?.quantity}`);
  assert('第1项 有specWarning(已匹配但仍提醒其他规格)', !!item0?.specWarning, `实际: ${item0?.specWarning}`);
  assert('第1项 specWarning包含其他规格', item0?.specWarning?.includes('A3') || item0?.specWarning?.includes('B1'), `实际: ${item0?.specWarning}`);

  const item1 = parseItems[1];
  assert('第2项 brand=空', item1?.brand === '', `实际: ${item1?.brand}`);
  assert('第2项 product_name=麻醉针', item1?.product_name === '麻醉针', `实际: ${item1?.product_name}`);
  assert('第2项 specification=30G', item1?.specification === '30G', `实际: ${item1?.specification}`);
  assert('第2项 quantity=1', item1?.quantity === 1, `实际: ${item1?.quantity}`);

  const item2 = parseItems[2];
  assert('第3项 product_name=洁牙头', item2?.product_name === '洁牙头', `实际: ${item2?.product_name}`);
  assert('第3项 quantity=5', item2?.quantity === 5, `实际: ${item2?.quantity}`);

  assert('全局warnings存在', r.data?.warnings?.length > 0, `实际 warnings: ${JSON.stringify(r.data?.warnings)}`);

  // ── 图片订单补录流程 ──
  console.log('\n📌 【图片订单补录流程】');

  r = await request('POST', '/api/orders', {
    clinic_id: 1,
    source: 'wechat',
    raw_content: '微信发来的订货单照片',
    urgency: 'emergency',
    urgency_note: '下午手术前必须到',
    created_by: '客服小王',
    images: [
      { image_url: 'https://example.com/order-photo.jpg', original_name: 'order-photo.jpg', mime_type: 'image/jpeg', file_size: 204800, description: '诊所发来的订货单照片' },
    ],
  });
  assertStatus('POST 创建图片订单(无items)', r, 201);
  const imageOrderId = r.data?.id;
  assert('图片订单有id', !!imageOrderId, `实际: ${imageOrderId}`);
  assert('图片订单含images', Array.isArray(r.data?.images) && r.data.images.length === 1);
  assert('图片订单items为空', Array.isArray(r.data?.items) && r.data.items.length === 0);

  r = await request('POST', `/api/orders/${imageOrderId}/items`, {
    product_id: 1,
    product_name: '树脂',
    specification: 'A2',
    brand: '3M',
    quantity: 2,
  });
  assertStatus('POST 补录第1个商品项', r, 201);
  assert('补录返回item', !!r.data?.item, `实际: ${JSON.stringify(r.data?.item)}`);
  assert('补录返回specWarning', !!r.data?.specWarning, `实际: ${r.data?.specWarning}`);
  assert('补录返回otherSpecs', Array.isArray(r.data?.otherSpecs) && r.data.otherSpecs.length > 0, `实际: ${JSON.stringify(r.data?.otherSpecs)}`);

  r = await request('POST', `/api/orders/${imageOrderId}/items`, {
    product_id: 7,
    product_name: '麻醉针',
    specification: '30G',
    brand: '日本马尼',
    quantity: 1,
  });
  assertStatus('POST 补录第2个商品项', r, 201);

  r = await request('POST', `/api/orders/${imageOrderId}/items`, {
    product_id: 11,
    product_name: '洁牙头',
    specification: '通用型',
    brand: 'EMS',
    quantity: 5,
  });
  assertStatus('POST 补录第3个商品项', r, 201);

  r = await request('GET', `/api/orders/${imageOrderId}`);
  assertStatus('GET 订单详情(补录后)', r, 200);
  assert('详情含organized', !!r.data?.organized, `实际: ${JSON.stringify(r.data?.organized)}`);
  assert('organized.raw_content存在', !!r.data?.organized?.raw_content, `实际: ${r.data?.organized?.raw_content}`);
  assert('organized.image_count=1', r.data?.organized?.image_count === 1, `实际: ${r.data?.organized?.image_count}`);
  assert('organized.item_count=3', r.data?.organized?.item_count === 3, `实际: ${r.data?.organized?.item_count}`);
  assert('organized.items有specWarning', r.data?.organized?.items?.some((i: any) => !!i.specWarning), `实际items: ${JSON.stringify(r.data?.organized?.items?.map((i: any) => i.specWarning))}`);
  assert('详情含images', Array.isArray(r.data?.images) && r.data.images.length === 1);
  assert('详情含items', Array.isArray(r.data?.items) && r.data.items.length === 3);

  r = await request('POST', `/api/orders/${imageOrderId}/images`, {
    image_url: 'https://example.com/extra-photo.png',
    original_name: 'extra-photo.png',
    mime_type: 'image/png',
    description: '追加的第二张图片',
    uploaded_by: '客服小王',
  });
  assertStatus('POST 追加图片', r, 201);
  assert('追加图片有 id', !!r.data?.id);

  const newImageId = r.data?.id;
  r = await request('DELETE', `/api/orders/${imageOrderId}/images/${newImageId}`);
  assertStatus('DELETE 删除图片', r, 200);

  r = await request('DELETE', `/api/orders/${imageOrderId}/images/999`);
  assertStatus('DELETE 不存在的图片 → 404', r, 404);

  r = await request('POST', '/api/orders', { clinic_id: 1 });
  assertStatus('POST 订单缺source → 400', r, 400);

  r = await request('GET', '/api/orders/999');
  assertStatus('GET 不存在的订单 → 404', r, 404);

  // ── 缺货回复 + 版本管理 ──
  console.log('\n📌 【缺货回复工作区】');

  r = await request('POST', '/api/orders', {
    clinic_id: 1,
    source: 'miniprogram',
    raw_content: '登士柏 树脂 A3 一支',
    created_by: '客服小李',
    items: [
      { product_id: 5, product_name: '树脂', specification: 'A3', brand: '登士柏', quantity: 1 },
    ],
  });
  assertStatus('POST 创建缺货订单', r, 201);
  const stockoutOrderId = r.data?.id;

  const stockoutOrderItems = r.data?.items || [];
  const outOfStockItem = stockoutOrderItems.find((i: any) => i.stock_status === 'out_of_stock' || i.stock_status === 'low_stock');
  assert('存在缺货订单项', !!outOfStockItem, `所有项库存状态: ${stockoutOrderItems.map((i: any) => i.stock_status).join(',')}`);

  const stockoutItemId = outOfStockItem?.id;
  r = await request('GET', `/api/stockout/order-item/${stockoutItemId}/alternatives`);
  assertStatus('GET 缺货替代品', r, 200);
  assert('有替代品', r.data?.hasAlternatives === true || (r.data?.alternatives?.length > 0), `实际: ${JSON.stringify(r.data?.hasAlternatives)}`);

  r = await request('POST', `/api/stockout/order-item/${stockoutItemId}/plan`, {
    plan_type: 'alternative',
    alternative_product_id: 4,
  });
  assertStatus('POST 缺货方案(仅传product_id)', r, 201);
  assert('方案返回 alternativeProduct', !!r.data?.alternativeProduct, `实际: ${JSON.stringify(r.data?.alternativeProduct)}`);
  assert('plan.alternative_brand 自动填充', r.data?.plan?.alternative_brand === '登士柏', `实际: ${r.data?.plan?.alternative_brand}`);
  assert('plan.alternative_spec 自动填充', r.data?.plan?.alternative_spec === 'A2', `实际: ${r.data?.plan?.alternative_spec}`);
  assert('autoFilled=true', r.data?.autoFilled === true, `实际: ${r.data?.autoFilled}`);

  r = await request('POST', `/api/stockout/order-item/${stockoutItemId}/plan`, {
    plan_type: 'alternative',
  });
  assertStatus('POST 替代方案缺品牌和ID → 400', r, 400);

  r = await request('POST', `/api/stockout/order-item/99999/plan`, {
    plan_type: 'restock', restock_date: '2026-06-25',
  });
  assertStatus('POST 不存在的订单项 → 404', r, 404);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/summary`);
  assertStatus('GET 缺货汇总', r, 200);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply`);
  assertStatus('GET 生成回复v1', r, 200);
  assert('回复v1包含替代产品信息', r.data?.reply_text?.includes('登士柏'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1包含替代品名+规格', r.data?.reply_text?.includes('树脂') && r.data?.reply_text?.includes('A2'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1包含缺货处理方案', r.data?.reply_text?.includes('缺货商品处理方案'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1有version', !!r.data?.version, `实际: ${JSON.stringify(r.data?.version)}`);
  const v1Id = r.data?.version?.id;
  const v1Number = r.data?.version?.version_number;
  assert('回复v1 version_number=1', v1Number === 1, `实际: ${v1Number}`);

  r = await request('POST', `/api/stockout/order-item/${stockoutItemId}/plan`, {
    plan_type: 'restock',
    restock_date: '2026-07-01',
  });
  assertStatus('POST 更新缺货方案为补货', r, 201);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply`);
  assertStatus('GET 生成回复v2', r, 200);
  assert('回复v2有version', !!r.data?.version, `实际: ${JSON.stringify(r.data?.version)}`);
  const v2Id = r.data?.version?.id;
  const v2Number = r.data?.version?.version_number;
  assert('回复v2 version_number=2', v2Number === 2, `实际: ${v2Number}`);
  assert('回复v2 version_id与v1不同', v2Id !== v1Id, `v1=${v1Id}, v2=${v2Id}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 回复版本历史', r, 200);
  assert('版本历史有2个版本', r.data?.total_versions === 2, `实际: ${r.data?.total_versions}`);
  assert('版本历史confirmed_version_id为null', r.data?.confirmed_version_id === null, `实际: ${r.data?.confirmed_version_id}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/confirm`, {
    version_id: v1Id,
    confirmed_by: '客服小李',
  });
  assertStatus('POST 确认缺货方案(v1)', r, 200);
  assert('确认返回confirmed_version', !!r.data?.confirmed_version, `实际: ${JSON.stringify(r.data?.confirmed_version)}`);
  assert('确认的version_id正确', r.data?.confirmed_version?.id === v1Id, `实际: ${r.data?.confirmed_version?.id}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 回复版本历史(确认后)', r, 200);
  assert('确认后confirmed_version_id=v1Id', r.data?.confirmed_version_id === v1Id, `实际: ${r.data?.confirmed_version_id}`);
  assert('确认后confirmed_version_number=1', r.data?.confirmed_version_number === 1, `实际: ${r.data?.confirmed_version_number}`);

  // ── 配送交接 ──
  console.log('\n📌 【配送交接工作区】');

  r = await request('GET', '/api/delivery/pending?view=warehouse');
  assertStatus('GET 仓库视图', r, 200);

  r = await request('GET', `/api/delivery/order/${imageOrderId}`);
  assertStatus('GET 配送详情', r, 200);
  assert('紧急程度=emergency', r.data?.order?.urgency === 'emergency', `实际: ${r.data?.order?.urgency}`);
  assert('紧急标签=紧急', r.data?.order?.urgency_label === '紧急', `实际: ${r.data?.order?.urgency_label}`);

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/urgency`, {
    urgency: 'routine',
    urgency_note: '可随下次常规配送',
  });
  assertStatus('PUT 标注常规配送', r, 200);
  assert('urgency_display 包含"常规配送"', r.data?.urgency_display?.includes('常规配送'), `实际: ${r.data?.urgency_display}`);

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/urgency`, {
    urgency: 'invalid_level',
  });
  assertStatus('PUT 无效紧急程度 → 400', r, 400);

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/warehouse-note`, {
    warehouse_note: '已检查所有商品，共3件',
    package_count: 1,
  });
  assertStatus('PUT 仓库备注', r, 200);

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/pack-status`, {
    pack_status: 'completed',
    handed_by: '仓管员小李',
  });
  assertStatus('PUT 完成打包', r, 200);
  assert('pack_status=completed', r.data?.pack_status === 'completed');

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/driver-note`, {
    driver_note: '请走南门，联系前台张护士',
  });
  assertStatus('PUT 司机备注', r, 200);

  r = await request('PUT', `/api/delivery/order/${imageOrderId}/delivery-status`, {
    delivery_status: 'delivered',
    received_by: '张医生',
  });
  assertStatus('PUT 确认送达', r, 200);
  assert('delivery_status=delivered', r.data?.delivery_status === 'delivered');

  r = await request('GET', '/api/delivery/stats/daily');
  assertStatus('GET 每日统计', r, 200);

  r = await request('GET', '/api/delivery/order/999');
  assertStatus('GET 不存在的配送 → 404', r, 404);

  // ── 失败场景验证 ──
  console.log('\n📌 【失败场景验证】');

  r = await request('GET', '/api/nonexistent-endpoint');
  assert('不存在接口返回404', r.status === 404, `实际: ${r.status}`);

  r = await request('GET', '/api/orders/999/items');
  assert('不存在订单的items返回404', r.status === 404, `实际: ${r.status}`);

  r = await request('POST', '/api/orders/999/items', { product_name: '测试', quantity: 1 });
  assert('不存在订单追加items返回404', r.status === 404, `实际: ${r.status}`);

  r = await request('GET', '/api/stockout/order/999/reply');
  assert('不存在订单生成回复返回404', r.status === 404, `实际: ${r.status}`);

  r = await request('GET', '/api/stockout/order/999/reply-history');
  assert('不存在订单回复历史返回404', r.status === 404, `实际: ${r.status}`);

  r = await request('POST', '/api/stockout/order/999/confirm', { confirmed_by: 'test' });
  assert('不存在订单确认返回404', r.status === 404, `实际: ${r.status}`);

  console.log('\n📌 【独立失败场景脚本验证】');

  r = await request('GET', '/api/nonexistent-business-endpoint');
  assert('不存在业务接口返回非200', r.status !== 200, `实际状态: ${r.status}`);
  assert('不存在业务接口返回404', r.status === 404, `实际状态: ${r.status}`);

  const stockoutPlanItemOrigReq = await request('POST', '/api/stockout/order-item/99999/plan', {
    plan_type: 'restock',
    restock_date: '2026-06-25',
  });
  assert('无效订单项返回非200', stockoutPlanItemOrigReq.status !== 200, `实际状态: ${stockoutPlanItemOrigReq.status}`);

  let subTestFailed = false;
  let subTestPassed = 0;
  let subTestTotal = 0;

  const subAssert = (cond: boolean, msg: string) => {
    subTestTotal++;
    if (cond) subTestPassed++;
    else subTestFailed = true;
  };

  const subR1 = await request('GET', '/api/nonexistent-test-path');
  subAssert(subR1.status !== 200, '不存在路径应返回非200');
  subAssert(subR1.status === 404, '不存在路径应返回404');

  const subR2 = await request('GET', '/api/health');
  subAssert(subR2.status === 200, '健康检查应返回200');

  assert('子测试: 不存在路径检测正确', !subTestFailed && subTestTotal === 3, `通过${subTestPassed}/${subTestTotal}, failed=${subTestFailed}`);

  // ── 结果 ──
  console.log('\n' + '═'.repeat(50));
  console.log(`📊 测试结果: ${passedTests}/${totalTests} 通过, ${failedTests} 失败`);
  console.log('═'.repeat(50));

  if (failures.length > 0) {
    console.log('\n❌ 失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log();
    process.exit(1);
  } else {
    console.log('\n🎉 全部测试通过！\n');
  }
}

runTests().catch((err) => {
  console.error('测试执行异常:', err.message);
  process.exit(1);
});
