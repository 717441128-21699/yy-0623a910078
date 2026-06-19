import express from 'express';
import cors from 'cors';
import { initDatabase } from './db';
import productsRouter from './routes/products';
import clinicsRouter from './routes/clinics';
import ordersRouter from './routes/orders';
import stockoutRouter from './routes/stockout';
import deliveryRouter from './routes/delivery';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'dental-order-collab',
    timestamp: new Date().toISOString(),
    workspaces: ['orders', 'stockout', 'delivery'],
  });
});

app.use('/api/products', productsRouter);
app.use('/api/clinics', clinicsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/stockout', stockoutRouter);
app.use('/api/delivery', deliveryRouter);

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`\n🚀 牙科订单协同服务已启动`);
      console.log(`📡 服务地址: http://localhost:${PORT}`);
      console.log(`\n📋 API 接口:`);
      console.log(`  健康检查:     GET  /api/health`);
      console.log(`  产品管理:     /api/products`);
      console.log(`  诊所管理:     /api/clinics`);
      console.log(`  订单整理:     /api/orders`);
      console.log(`  缺货回复:     /api/stockout`);
      console.log(`  配送交接:     /api/delivery`);
      console.log(`\n🏢 三个工作区:`);
      console.log(`  1. 订单整理 - 解析文字/图片需求，标准化品名规格`);
      console.log(`  2. 缺货回复 - 替代品牌/补货日期/拆单方案，生成回复`);
      console.log(`  3. 配送交接 - 按紧急程度标注，仓库司机信息同步`);
      console.log();
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

export default app;
