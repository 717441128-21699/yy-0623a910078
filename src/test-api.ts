import http from 'http';

const BASE_URL = 'localhost';
const PORT = 3000;
const NEGATIVE_MODE = process.env.NEGATIVE_TEST === '1' || process.env.NEGATIVE_TEST === 'true';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: string[] = [];

const modeLabel = NEGATIVE_MODE
  ? '⚠️  【负向测试模式】 - 故意请求不存在/错误的接口，验证测试框架会失败退出'
  : '✅ 【正向测试模式】 - 正常全量接口测试，全部通过才返回 0';

console.log('\n' + '═'.repeat(70));
console.log(modeLabel);
console.log('═'.repeat(70));

function request(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const parsedPath = path.split('?');
    const pathname = parsedPath[0];
    const queryString = parsedPath[1] || '';
    const encodedQuery = queryString
      ? '?' + queryString.split('&').map(pair => {
          const [k, v] = pair.split('=');
          if (v === undefined) return pair;
          let decodedV: string;
          try {
            decodedV = decodeURIComponent(v);
          } catch {
            decodedV = v;
          }
          if (decodedV === v && /[^\x00-\x7F]/.test(v)) {
            return `${k}=${encodeURIComponent(v)}`;
          }
          return pair;
        }).join('&')
      : '';
    const encodedPath = pathname + encodedQuery;

    const options = {
      hostname: BASE_URL,
      port: PORT,
      path: encodedPath,
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

async function runNegativeTests() {
  console.log('\n📌 负向测试：故意请求错误/不存在的接口，验证测试框架检测到失败\n');

  console.log('  💡 预期：所有断言都会失败，最后 exit(1)');
  console.log('  💡 目的：证明测试框架不会把接口不通误报成通过\n');

  let r = await request('GET', '/api/nonexistent-business-endpoint');
  assertStatus('1. 请求不存在的业务接口应该失败(期望200，实际404→失败)', r, 200);

  r = await request('GET', '/api/orders/99999');
  assertStatus('2. 请求不存在的订单应该失败(期望200，实际404→失败)', r, 200);

  r = await request('POST', '/api/orders/99999/items', { product_name: 'test', quantity: 1 });
  assertStatus('3. 给不存在的订单加商品应该失败(期望201，实际404→失败)', r, 201);

  r = await request('GET', '/api/stockout/order/99999/reply');
  assertStatus('4. 不存在订单生成回复应该失败(期望200，实际404→失败)', r, 200);

  r = await request('POST', '/api/stockout/order/99999/confirm', { confirmed_by: 'test' });
  assertStatus('5. 不存在订单确认回复应该失败(期望200，实际404→失败)', r, 200);

  r = await request('GET', '/api/delivery/order/99999');
  assertStatus('6. 不存在配送单应该失败(期望200，实际404→失败)', r, 200);

  r = await request('POST', '/api/products', {});
  assertStatus('7. 产品创建缺参数应该失败(期望201，实际400→失败)', r, 201);

  r = await request('POST', '/api/orders', { clinic_id: 1 });
  assertStatus('8. 订单创建缺source应该失败(期望201，实际400→失败)', r, 201);

  r = await request('PUT', '/api/delivery/order/99999/urgency', { urgency: 'invalid' });
  assertStatus('9. 无效紧急程度应该失败(期望200，实际400→失败)', r, 200);

  r = await request('GET', '/api/health');
  const serviceOk = r.status === 200 && r.data?.service === 'dental-order-collab';
  assert('10. 负向模式也先确认服务可用(这步应该通过)', serviceOk,
    `服务状态: ${r.status}, 响应: ${JSON.stringify(r.data)}`);

  console.log('\n' + '═'.repeat(70));
  console.log(`📊 负向测试结果: ${passedTests}/${totalTests} 通过, ${failedTests} 失败`);
  console.log('═'.repeat(70));

  if (failures.length > 0) {
    console.log('\n❌ 负向测试成功检测到以下失败：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log();
    console.log('✅ 负向测试验证通过：测试框架正确检测到了接口不通并收集了失败');
    console.log('   即将以 exit(1) 退出，证明负向场景下命令会失败\n');
    process.exit(1);
  } else {
    console.log('\n❌ 负向测试失败：所有断言都通过了，这是不正常的！');
    console.log('   说明测试框架没有正确检测到接口错误\n');
    process.exit(1);
  }
}

async function runPositiveTests() {
  console.log('\n🧪 开始正向 API 接口测试（含断言）\n');

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
  assert('第1项 from_correction=false', item0?.from_correction === false, `实际: ${item0?.from_correction}`);

  const item1 = parseItems[1];
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

  // ── 缺货回复 + 审批流程 ──
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

  r = await request('POST', '/api/stockout/order-item/99999/plan', {
    plan_type: 'restock', restock_date: '2026-06-25',
  });
  assertStatus('POST 不存在的订单项 → 404', r, 404);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/summary`);
  assertStatus('GET 缺货汇总', r, 200);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply?created_by=客服小李`);
  assertStatus('GET 生成回复v1', r, 200);
  assert('回复v1包含替代产品信息', r.data?.reply_text?.includes('登士柏'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1包含替代品名+规格', r.data?.reply_text?.includes('树脂') && r.data?.reply_text?.includes('A2'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1包含缺货处理方案', r.data?.reply_text?.includes('缺货商品处理方案'), `回复内容: ${(r.data?.reply_text || '').slice(0, 300)}`);
  assert('回复v1有version', !!r.data?.version, `实际: ${JSON.stringify(r.data?.version)}`);
  const v1Id = r.data?.version?.id;
  const v1Number = r.data?.version?.version_number;
  assert('回复v1 version_number=1', v1Number === 1, `实际: ${v1Number}`);
  assert('回复v1 status=pending', r.data?.version?.status === 'pending', `实际: ${r.data?.version?.status}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v1Id}/submit`, {
    submitted_by: '客服小李',
  });
  assertStatus('POST 提交待确认v1', r, 200);
  assert('提交后status=submitted', r.data?.version?.status === 'submitted', `实际: ${r.data?.version?.status}`);
  assert('submitted_by正确', r.data?.version?.submitted_by === '客服小李', `实际: ${r.data?.version?.submitted_by}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v1Id}/confirm`, {
    confirmed_by: '主管王经理',
  });
  assertStatus('POST 主管确认v1', r, 200);
  assert('确认后status=confirmed', r.data?.confirmed_version?.status === 'confirmed', `实际: ${r.data?.confirmed_version?.status}`);
  assert('confirmed_by正确', r.data?.confirmed_version?.confirmed_by === '主管王经理', `实际: ${r.data?.confirmed_version?.confirmed_by}`);
  assert('previous_confirmed_version为null', r.data?.previous_confirmed_version === null, `实际: ${JSON.stringify(r.data?.previous_confirmed_version)}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 回复版本历史(确认后)', r, 200);
  assert('版本历史confirmed_version_id=v1Id', r.data?.confirmed_version_id === v1Id, `实际: ${r.data?.confirmed_version_id}`);
  assert('版本历史confirmed_version_number=1', r.data?.confirmed_version_number === 1, `实际: ${r.data?.confirmed_version_number}`);
  assert('current_active_version_number=1', r.data?.current_active_version_number === 1, `实际: ${r.data?.current_active_version_number}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply?created_by=客服小李`);
  assertStatus('GET 生成回复v2', r, 200);
  const v2Id = r.data?.version?.id;
  const v2Number = r.data?.version?.version_number;
  assert('回复v2 version_number=2', v2Number === 2, `实际: ${v2Number}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v2Id}/confirm`, {
    confirmed_by: '主管王经理',
  });
  assertStatus('POST 直接确认v2(未submitted)→400', r, 400);
  assert('错误提示包含submitted', r.data?.error?.includes('submitted'), `实际: ${r.data?.error}`);
  assert('v1仍为确认状态', r.data?.error?.includes('已确认的版本不受影响'), `实际: ${r.data?.error}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 历史(错误确认后)', r, 200);
  assert('确认版本仍为v1(未被影响)', r.data?.confirmed_version_id === v1Id, `实际: ${r.data?.confirmed_version_id}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v2Id}/submit`, {
    submitted_by: '客服小李',
  });
  assertStatus('POST 提交v2待确认', r, 200);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v2Id}/confirm`, {
    confirmed_by: '主管王经理',
  });
  assertStatus('POST 主管确认v2', r, 200);
  assert('v2确认后status=confirmed', r.data?.confirmed_version?.status === 'confirmed', `实际: ${r.data?.confirmed_version?.status}`);
  assert('previous_confirmed_version是v1', r.data?.previous_confirmed_version?.id === v1Id, `实际: ${r.data?.previous_confirmed_version?.id}`);
  assert('previous_confirmed_version的status改为replaced', r.data?.previous_confirmed_version?.status === 'replaced', `实际: ${r.data?.previous_confirmed_version?.status}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 历史(v2确认后)', r, 200);
  assert('current_active_version_id=v2Id', r.data?.current_active_version_id === v2Id, `实际: ${r.data?.current_active_version_id}`);
  assert('current_active_version_number=2', r.data?.current_active_version_number === 2, `实际: ${r.data?.current_active_version_number}`);
  assert('confirmed_version_id=v2Id', r.data?.confirmed_version_id === v2Id, `实际: ${r.data?.confirmed_version_id}`);

  r = await request('POST', `/api/stockout/order/${stockoutOrderId}/reply/${v2Id}/send`, {
    sent_by: '客服小李',
  });
  assertStatus('POST 标记v2已发送', r, 200);
  assert('标记后status=sent', r.data?.version?.status === 'sent', `实际: ${r.data?.version?.status}`);

  r = await request('GET', `/api/stockout/order/${stockoutOrderId}/reply-history`);
  assertStatus('GET 历史(发送后)', r, 200);
  assert('current_status=sent', r.data?.current_status === 'sent', `实际: ${r.data?.current_status}`);
  assert('sent_version_id=v2Id', r.data?.sent_version_id === v2Id, `实际: ${r.data?.sent_version_id}`);

  // ── 人工纠错 ──
  console.log('\n📌 【人工纠错功能】');

  r = await request('POST', '/api/orders/corrections', {
    raw_text_pattern: '麻醉针 30G',
    product_id: 7,
    corrected_by: '客服小王',
  });
  assertStatus('POST 创建纠错规则', r, 201);
  const corrId = r.data?.correction?.id;
  assert('纠错创建成功', !!corrId, `实际: ${JSON.stringify(r.data?.correction)}`);
  assert('纠错product_id=7', r.data?.correction?.product_id === 7, `实际: ${r.data?.correction?.product_id}`);
  assert('纠错use_count=0', r.data?.correction?.use_count === 0, `实际: ${r.data?.correction?.use_count}`);

  r = await request('POST', '/api/orders/parse', {
    text: '麻醉针 30G 一盒',
  });
  assertStatus('POST 解析(匹配纠错)', r, 200);
  const correctedItem = (r.data?.items || [])[0];
  assert('解析项from_correction=true', correctedItem?.from_correction === true, `实际: ${correctedItem?.from_correction}`);
  assert('解析项correction_id正确', correctedItem?.correction_id === corrId, `实际: ${correctedItem?.correction_id}`);
  assert('解析项correction_use_count=1', correctedItem?.correction_use_count === 1, `实际: ${correctedItem?.correction_use_count}`);
  assert('解析项specWarning仍有', !!correctedItem?.specWarning, `实际: ${correctedItem?.specWarning}`);
  assert('解析项specWarning包含其他规格提醒', correctedItem?.specWarning?.includes('其他规格'), `实际: ${correctedItem?.specWarning}`);

  r = await request('GET', '/api/orders/corrections');
  assertStatus('GET 纠错列表', r, 200);
  assert('纠错列表非空', Array.isArray(r.data?.data) && r.data.data.length > 0);
  assert('use_count已更新为1', r.data?.data[0]?.use_count === 1, `实际: ${r.data?.data[0]?.use_count}`);

  r = await request('DELETE', `/api/orders/corrections/${corrId}`);
  assertStatus('DELETE 删除纠错规则', r, 200);

  // ── 订单批次拆分 ──
  console.log('\n📌 【订单批次拆分】');

  r = await request('POST', `/api/orders/${stockoutOrderId}/batches/auto-split`, {
    created_by: '客服小李',
  });
  assertStatus('POST 自动拆分批次', r, 201);
  assert('批次数量>=1', r.data?.total_batches >= 1, `实际: ${r.data?.total_batches}`);
  assert('批次含商品', r.data?.batches?.every((b: any) => b.items?.length > 0), `实际: ${JSON.stringify(r.data?.batches)}`);
  const batches = r.data?.batches || [];
  const batch1Id = batches[0]?.id;
  assert('批次1有id', !!batch1Id);

  r = await request('GET', `/api/orders/${stockoutOrderId}/batches`);
  assertStatus('GET 批次列表', r, 200);
  assert('批次数量匹配', r.data?.total_batches === batches.length, `实际: ${r.data?.total_batches}`);

  r = await request('GET', `/api/delivery/order/${stockoutOrderId}/batches`);
  assertStatus('GET 配送批次详情', r, 200);
  assert('配送批次有商品', r.data?.batches?.every((b: any) => b.items?.length > 0), `实际: ${JSON.stringify(r.data?.batches)}`);

  r = await request('PUT', `/api/delivery/order/${stockoutOrderId}/batches/${batch1Id}/urgency`, {
    urgency: 'emergency',
    urgency_note: '今天必须发',
  });
  assertStatus('PUT 批次紧急程度', r, 200);
  assert('urgency=emergency', r.data?.urgency === 'emergency', `实际: ${r.data?.urgency}`);

  r = await request('PUT', `/api/delivery/order/${stockoutOrderId}/batches/${batch1Id}/warehouse-note`, {
    warehouse_note: '已检查',
    package_count: 1,
  });
  assertStatus('PUT 批次仓库备注', r, 200);
  assert('warehouse_note正确', r.data?.warehouse_note === '已检查', `实际: ${r.data?.warehouse_note}`);

  r = await request('PUT', `/api/delivery/order/${stockoutOrderId}/batches/${batch1Id}/pack-status`, {
    pack_status: 'completed',
    handed_by: '仓管员小李',
  });
  assertStatus('PUT 批次打包完成', r, 200);
  assert('pack_status=completed', r.data?.pack_status === 'completed', `实际: ${r.data?.pack_status}`);

  r = await request('PUT', `/api/delivery/order/${stockoutOrderId}/batches/${batch1Id}/driver-note`, {
    driver_note: '请走南门',
  });
  assertStatus('PUT 批次司机备注', r, 200);
  assert('driver_note正确', r.data?.driver_note === '请走南门', `实际: ${r.data?.driver_note}`);

  r = await request('PUT', `/api/delivery/order/${stockoutOrderId}/batches/${batch1Id}/delivery-status`, {
    delivery_status: 'delivered',
    received_by: '张医生',
  });
  assertStatus('PUT 批次确认送达', r, 200);
  assert('delivery_status=delivered', r.data?.delivery_status === 'delivered', `实际: ${r.data?.delivery_status}`);

  r = await request('GET', '/api/delivery/pending/batches?view=warehouse');
  assertStatus('GET 按批次查看待配送(仓库视图)', r, 200);
  assert('group_by=batch', r.data?.group_by === 'batch', `实际: ${r.data?.group_by}`);
  assert('批次含items', r.data?.data?.every((b: any) => Array.isArray(b.items)), `实际: ${JSON.stringify(r.data?.data[0])}`);

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

  r = await request('GET', '/api/nonexistent-business-endpoint');
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
  console.log('\n' + '═'.repeat(70));
  console.log(`📊 测试结果: ${passedTests}/${totalTests} 通过, ${failedTests} 失败`);
  console.log('═'.repeat(70));

  if (failures.length > 0) {
    console.log('\n❌ 失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log();
    process.exit(1);
  } else {
    console.log('\n🎉 全部正向测试通过！命令以 exit(0) 退出\n');
    process.exit(0);
  }
}

if (NEGATIVE_MODE) {
  runNegativeTests().catch((err) => {
    console.error('负向测试执行异常:', err.message);
    process.exit(1);
  });
} else {
  runPositiveTests().catch((err) => {
    console.error('正向测试执行异常:', err.message);
    process.exit(1);
  });
}
