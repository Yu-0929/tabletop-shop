const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// PostgreSQL 连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 图片上传设置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件！'));
    }
  }
});

// 初始化数据库
async function initDatabase() {
  try {
    // 商品分类表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 商品表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id),
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        stock INTEGER DEFAULT 0,
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 订单表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        customer_address TEXT,
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 订单详情表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        product_id INTEGER REFERENCES products(id),
        product_name VARCHAR(200),
        quantity INTEGER NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        subtotal DECIMAL(10, 2) NOT NULL
      )
    `);

    console.log('✅ 数据库初始化完成');
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
  }
}

// ==========================================
// API 路由
// ==========================================

// 首页 - 购物页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 管理后台
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// 获取所有分类
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY name');
    res.json({ success: true, categories: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 新增分类
app.post('/api/categories', async (req, res) => {
  const { name } = req.body;
  
  if (!name) {
    return res.status(400).json({ success: false, error: '分类名称不能为空' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING *',
      [name]
    );
    res.json({ success: true, category: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取所有商品（可按分类筛选）
app.get('/api/products', async (req, res) => {
  const { category_id } = req.query;
  
  try {
    let query = `
      SELECT p.*, c.name as category_name 
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.id
    `;
    
    const params = [];
    
    if (category_id) {
      query += ' WHERE p.category_id = $1';
      params.push(category_id);
    }
    
    query += ' ORDER BY p.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json({ success: true, products: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取单个商品
app.get('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT p.*, c.name as category_name 
       FROM products p 
       LEFT JOIN categories c ON p.category_id = c.id 
       WHERE p.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '商品不存在' });
    }
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 新增商品（含图片上传）
app.post('/api/products', upload.single('image'), async (req, res) => {
  const { category_id, name, description, price, stock } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : null;

  if (!name || !price) {
    return res.status(400).json({ success: false, error: '商品名称和价格不能为空' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (category_id, name, description, price, stock, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [category_id, name, description, price, stock || 0, image_url]
    );
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新商品库存
app.patch('/api/products/:id/stock', async (req, res) => {
  const { id } = req.params;
  const { stock } = req.body;

  if (stock === undefined) {
    return res.status(400).json({ success: false, error: '库存数量不能为空' });
  }

  try {
    const result = await pool.query(
      'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [stock, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: '商品不存在' });
    }
    
    res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 创建订单
app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, customer_address, items } = req.body;

  if (!customer_name || !customer_phone || !items || items.length === 0) {
    return res.status(400).json({ success: false, error: '缺少必要信息' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 计算总金额并检查库存
    let total_amount = 0;
    const orderItems = [];

    for (const item of items) {
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1',
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`商品 ID ${item.product_id} 不存在`);
      }

      const product = productResult.rows[0];

      if (product.stock < item.quantity) {
        throw new Error(`商品「${product.name}」库存不足`);
      }

      const subtotal = product.price * item.quantity;
      total_amount += subtotal;

      orderItems.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        price: product.price,
        subtotal: subtotal
      });

      // 扣减库存
      await client.query(
        'UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [item.quantity, product.id]
      );
    }

    // 创建订单
    const orderResult = await client.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_address, total_amount) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customer_name, customer_phone, customer_address, total_amount]
    );

    const order = orderResult.rows[0];

    // 创建订单详情
    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, subtotal) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.product_id, item.product_name, item.quantity, item.price, item.subtotal]
      );
    }

    await client.query('COMMIT');

    // 发送 LINE 通知
    await sendLineNotification(order, orderItems);

    res.json({ success: true, order: order });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 发送 LINE 通知
async function sendLineNotification(order, items) {
  const LINE_TOKEN = process.env.LINE_TOKEN;
  const USER_ID = process.env.LINE_USER_ID;

  if (!LINE_TOKEN || !USER_ID) {
    console.log('⚠️ LINE 通知未设置');
    return;
  }

  const itemsText = items.map(item => 
    `${item.product_name} x${item.quantity} = NT$${item.subtotal}`
  ).join('\n');

  const message = `🛒 新订单通知

订单编号：#${order.id}
客户姓名：${order.customer_name}
联系电话：${order.customer_phone}
送货地址：${order.customer_address || '（未提供）'}

订购商品：
${itemsText}

总金额：NT$${order.total_amount}
下单时间：${new Date(order.created_at).toLocaleString('zh-TW')}`;

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        to: USER_ID,
        messages: [{
          type: 'text',
          text: message
        }]
      })
    });

    if (response.ok) {
      console.log('✅ LINE 通知发送成功');
    } else {
      console.log('❌ LINE 通知发送失败:', await response.text());
    }
  } catch (error) {
    console.error('❌ LINE 通知异常:', error);
  }
}

// 启动服务器
app.listen(PORT, async () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  await initDatabase();
});
