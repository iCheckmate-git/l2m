import { createServer } from 'node:http';
import { mkdirSync, createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'ledger.db');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const shouldSeedDemoData = process.env.SEED_DEMO_DATA === 'true';
const databaseUrl = process.env.DATABASE_URL || '';
const databaseMode = databaseUrl ? 'postgres' : 'sqlite';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

let storage;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (url.pathname === '/api/transactions' && req.method === 'GET') {
      const transactions = await storage.listTransactions();
      return sendJson(res, 200, {
        transactions,
        summary: buildSummary(transactions)
      });
    }

    if (url.pathname === '/api/summary' && req.method === 'GET') {
      const transactions = await storage.listTransactions();
      return sendJson(res, 200, buildSummary(transactions));
    }

    if (url.pathname === '/api/transactions' && req.method === 'POST') {
      const payload = await readJson(req);
      const transaction = validateTransaction(payload);
      const id = await storage.insertTransaction(transaction);
      const transactions = await storage.listTransactions();

      return sendJson(res, 201, {
        id,
        summary: buildSummary(transactions)
      });
    }

    if (url.pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
      const id = Number(url.pathname.split('/').pop());
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: 'Invalid transaction id.' });
      }

      const deletedCount = await storage.deleteTransaction(id);
      if (!deletedCount) {
        return sendJson(res, 404, { error: 'Transaction not found.' });
      }

      const transactions = await storage.listTransactions();
      return sendJson(res, 200, { ok: true, summary: buildSummary(transactions) });
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        databaseMode
      });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    return sendJson(res, status, {
      error: error.message || 'Unexpected server error.'
    });
  }
});

bootstrap();

async function bootstrap() {
  storage = databaseMode === 'postgres'
    ? await createPostgresStorage()
    : createSqliteStorage();

  if (shouldSeedDemoData) {
    await seedData(storage);
  }

  server.listen(port, host, () => {
    console.log(`Lineage 2M ledger is running at http://${host}:${port}`);
    console.log(`Database mode: ${databaseMode}`);
  });
}

function createSqliteStorage() {
  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'purchase')),
      title TEXT NOT NULL,
      crystals INTEGER NOT NULL CHECK (crystals >= 0),
      real_amount REAL NOT NULL DEFAULT 0 CHECK (real_amount >= 0),
      real_currency TEXT NOT NULL DEFAULT 'USD',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  const insertTransactionStmt = db.prepare(`
    INSERT INTO transactions (type, title, crystals, real_amount, real_currency, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listTransactionsStmt = db.prepare(`
    SELECT id, type, title, crystals, real_amount, real_currency, notes, created_at
    FROM transactions
    ORDER BY datetime(created_at) DESC, id DESC
  `);
  const deleteTransactionStmt = db.prepare('DELETE FROM transactions WHERE id = ?');
  const countTransactionsStmt = db.prepare('SELECT COUNT(*) AS total FROM transactions');

  return {
    async countTransactions() {
      return Number(countTransactionsStmt.get().total);
    },
    async listTransactions() {
      return listTransactionsStmt.all().map(normalizeRow);
    },
    async insertTransaction(transaction) {
      const result = insertTransactionStmt.run(
        transaction.type,
        transaction.title,
        transaction.crystals,
        transaction.realAmount,
        transaction.realCurrency,
        transaction.notes,
        transaction.createdAt
      );
      return Number(result.lastInsertRowid);
    },
    async deleteTransaction(id) {
      const result = deleteTransactionStmt.run(id);
      return Number(result.changes);
    }
  };
}

async function createPostgresStorage() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: shouldUseSsl()
      ? { rejectUnauthorized: false }
      : undefined
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'purchase')),
      title TEXT NOT NULL,
      crystals INTEGER NOT NULL CHECK (crystals >= 0),
      real_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (real_amount >= 0),
      real_currency TEXT NOT NULL DEFAULT 'USD',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  return {
    async countTransactions() {
      const result = await pool.query('SELECT COUNT(*)::int AS total FROM transactions');
      return Number(result.rows[0].total);
    },
    async listTransactions() {
      const result = await pool.query(`
        SELECT id, type, title, crystals, real_amount, real_currency, notes, created_at
        FROM transactions
        ORDER BY created_at DESC, id DESC
      `);
      return result.rows.map(normalizeRow);
    },
    async insertTransaction(transaction) {
      const result = await pool.query(
        `
          INSERT INTO transactions (type, title, crystals, real_amount, real_currency, notes, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [
          transaction.type,
          transaction.title,
          transaction.crystals,
          transaction.realAmount,
          transaction.realCurrency,
          transaction.notes,
          transaction.createdAt
        ]
      );
      return Number(result.rows[0].id);
    },
    async deleteTransaction(id) {
      const result = await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
      return Number(result.rowCount || 0);
    }
  };
}

function shouldUseSsl() {
  if (!databaseUrl) {
    return false;
  }

  if (process.env.DATABASE_SSL === 'false') {
    return false;
  }

  if (process.env.DATABASE_SSL === 'true') {
    return true;
  }

  return process.env.NODE_ENV === 'production';
}

async function seedData(currentStorage) {
  const count = await currentStorage.countTransactions();
  if (count > 0) {
    return;
  }

  const seedTransactions = [
    {
      type: 'income',
      title: 'Clan raid reward',
      crystals: 1250,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Night boss rotation',
      createdAt: shiftDate(-8)
    },
    {
      type: 'expense',
      title: 'Craft upgrade',
      crystals: 480,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Weapon awaken material',
      createdAt: shiftDate(-7)
    },
    {
      type: 'purchase',
      title: 'Weekend top-up pack',
      crystals: 2200,
      realAmount: 34.99,
      realCurrency: 'USD',
      notes: 'Limited in-game shop pack',
      createdAt: shiftDate(-6)
    },
    {
      type: 'income',
      title: 'Marketplace sale',
      crystals: 810,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Rare recipe sold fast',
      createdAt: shiftDate(-5)
    },
    {
      type: 'expense',
      title: 'Accessory reroll',
      crystals: 640,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Two unlucky attempts',
      createdAt: shiftDate(-4)
    },
    {
      type: 'income',
      title: 'Event mission payout',
      crystals: 980,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Spring pass segment',
      createdAt: shiftDate(-3)
    },
    {
      type: 'purchase',
      title: 'Crystal growth bundle',
      crystals: 1500,
      realAmount: 21.5,
      realCurrency: 'USD',
      notes: 'Used for boss prep',
      createdAt: shiftDate(-2)
    },
    {
      type: 'expense',
      title: 'Auction bid',
      crystals: 960,
      realAmount: 0,
      realCurrency: 'USD',
      notes: 'Accessory sniped at close',
      createdAt: shiftDate(-1)
    }
  ];

  for (const item of seedTransactions) {
    await currentStorage.insertTransaction(item);
  }
}

function shiftDate(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(19, 30, 0, 0);
  return date.toISOString();
}

function normalizeRow(row) {
  return {
    id: Number(row.id),
    type: row.type,
    title: row.title,
    crystals: Number(row.crystals),
    realAmount: Number(row.real_amount),
    realCurrency: row.real_currency,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function buildSummary(transactions) {
  const sortedTransactions = transactions
    .slice()
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));

  let totalIncome = 0;
  let totalExpense = 0;
  let totalPurchased = 0;
  let realSpent = 0;

  for (const item of sortedTransactions) {
    if (item.type === 'income') {
      totalIncome += item.crystals;
    }
    if (item.type === 'expense') {
      totalExpense += item.crystals;
    }
    if (item.type === 'purchase') {
      totalPurchased += item.crystals;
      realSpent += item.realAmount;
    }
  }

  const balance = totalIncome + totalPurchased - totalExpense;
  const chart = buildChartSeries(sortedTransactions);
  const lastTransaction = sortedTransactions.at(-1) || null;
  const latestPurchase = sortedTransactions.filter((item) => item.type === 'purchase').at(-1) || null;

  return {
    totals: {
      balance,
      totalIncome,
      totalExpense,
      totalPurchased,
      realSpent: Number(realSpent.toFixed(2)),
      transactionCount: sortedTransactions.length,
      primaryCurrency: latestPurchase?.realCurrency || 'USD'
    },
    chart,
    lastTransaction
  };
}

function buildChartSeries(transactions) {
  const days = [];
  const dayMap = new Map();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);

  for (let index = 0; index < 7; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = date.toISOString().slice(0, 10);
    const day = {
      key,
      label: date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      income: 0,
      purchase: 0,
      expense: 0,
      net: 0,
      balance: 0
    };
    days.push(day);
    dayMap.set(key, day);
  }

  for (const item of transactions) {
    const key = item.createdAt.slice(0, 10);
    const bucket = dayMap.get(key);
    if (!bucket) {
      continue;
    }

    if (item.type === 'income') {
      bucket.income += item.crystals;
    }
    if (item.type === 'purchase') {
      bucket.purchase += item.crystals;
    }
    if (item.type === 'expense') {
      bucket.expense += item.crystals;
    }
  }

  const historicalBalance = transactions.reduce((total, item) => {
    const inRange = dayMap.has(item.createdAt.slice(0, 10));
    if (inRange) {
      return total;
    }
    if (item.type === 'expense') {
      return total - item.crystals;
    }
    return total + item.crystals;
  }, 0);

  let chartBalance = historicalBalance;
  for (const day of days) {
    day.net = day.income + day.purchase - day.expense;
    chartBalance += day.net;
    day.balance = chartBalance;
  }

  return days;
}

async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    throw createError(400, 'Request body is empty.');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw createError(400, 'Invalid JSON payload.');
  }
}

function validateTransaction(payload) {
  const type = typeof payload.type === 'string' ? payload.type.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const crystals = Number(payload.crystals);
  const realAmount = Number(payload.realAmount || 0);
  const realCurrency = typeof payload.realCurrency === 'string' && payload.realCurrency.trim()
    ? payload.realCurrency.trim().toUpperCase()
    : 'USD';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const createdAt = payload.createdAt ? new Date(payload.createdAt) : new Date();

  if (!['income', 'expense', 'purchase'].includes(type)) {
    throw createError(400, 'Type must be income, expense, or purchase.');
  }

  if (!title || title.length < 2) {
    throw createError(400, 'Title must contain at least 2 characters.');
  }

  if (!Number.isFinite(crystals) || crystals < 0) {
    throw createError(400, 'Crystals must be a valid non-negative number.');
  }

  if (!Number.isFinite(realAmount) || realAmount < 0) {
    throw createError(400, 'Real money amount must be a valid non-negative number.');
  }

  if (!/^[A-Z]{3}$/.test(realCurrency)) {
    throw createError(400, 'Currency must be a 3-letter code like USD or UAH.');
  }

  if (type !== 'purchase' && realAmount > 0) {
    throw createError(400, 'Real money amount is allowed only for purchase transactions.');
  }

  if (Number.isNaN(createdAt.getTime())) {
    throw createError(400, 'Created at must be a valid date.');
  }

  return {
    type,
    title,
    crystals: Math.round(crystals),
    realAmount: Number(realAmount.toFixed(2)),
    realCurrency,
    notes,
    createdAt: createdAt.toISOString()
  };
}

async function serveStatic(requestPath, res) {
  let relativePath = requestPath === '/' ? '/index.html' : requestPath;
  relativePath = relativePath.replace(/^\/+/, '');
  const filePath = path.join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Forbidden.' });
  }

  if (!existsSync(filePath)) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });

  createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
