const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const DB_FILE = path.join(__dirname, 'cupsion.db');
const db = new DatabaseSync(DB_FILE);

// ---------- Schema (runs once) ----------
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS menu (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    price INTEGER NOT NULL,
    is_cup INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    unit  TEXT NOT NULL DEFAULT 'units',
    stock INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sales (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    time   TEXT NOT NULL,
    date   TEXT NOT NULL,
    method TEXT NOT NULL,
    amount INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    qty     INTEGER NOT NULL,
    is_cup  INTEGER NOT NULL,
    price   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    when_  TEXT NOT NULL,
    user   TEXT NOT NULL,
    action TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS report_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------- Seed (only if empty) ----------
function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM menu').get();
  if (row.n > 0) return;

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ownerPin', '1234');

  const addMenu = db.prepare('INSERT INTO menu (id, name, price, is_cup) VALUES (?, ?, ?, ?)');
  addMenu.run('ml',    'Matcha Latte',         70, 1);
  addMenu.run('us',    'Ube Strawberry Latte', 90, 1);
  addMenu.run('hu',    'Halukay Ube',          90, 1);
  addMenu.run('mu',    'Matcha Ube',           80, 1);
  addMenu.run('ic',    'Iced Coffee',          60, 1);
  addMenu.run('addon', 'Add-on',               10, 0);

  const addInv = db.prepare('INSERT INTO inventory (id, name, unit, stock) VALUES (?, ?, ?, ?)');
  addInv.run('fresh-milk',    'Fresh milk',    'L',   32);
  addInv.run('ube-powder',    'Ube powder',    'kg',  14);
  addInv.run('matcha-powder', 'Matcha powder', 'kg',  42);
  addInv.run('cups',          'Cups',          'pcs', 1200);

  const upsert = db.prepare('INSERT INTO report_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('status',   'Pending review');
  upsert.run('signedBy', null);
  upsert.run('signedAt', null);
  upsert.run('date',     null);
}
seedIfEmpty();

// ---------- Helpers ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function stamp() {
  const d = new Date();
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function getReport() {
  const rows = db.prepare('SELECT key, value FROM report_state').all();
  const out = { status: 'Pending review', signedBy: null, signedAt: null, date: null };
  for (const r of rows) {
    if (r.key === 'status')   out.status   = r.value;
    if (r.key === 'signedBy') out.signedBy = r.value;
    if (r.key === 'signedAt') out.signedAt = r.value;
    if (r.key === 'date')     out.date     = r.value;
  }
  return out;
}

function setReport(status, signedBy, signedAt, date) {
  const upsert = db.prepare('INSERT INTO report_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('status',   status);
  upsert.run('signedBy', signedBy);
  upsert.run('signedAt', signedAt);
  if (date !== undefined) upsert.run('date', date);
}

function addLog(user, action) {
  db.prepare('INSERT INTO logs (when_, user, action) VALUES (?, ?, ?)').run(stamp(), user, action);
}

function ownerName() {
  return getSetting('ownerName') || 'Maria Santos';
}

function parseOrder(summary) {
  const out = [];
  (summary || '').split(',').forEach(part => {
    const m = part.trim().match(/^(.+?)\s*×\s*(\d+)/);
    if (m) out.push({ name: m[1].trim(), qty: parseInt(m[2], 10) });
  });
  return out;
}

function isCupItem(name) {
  const row = db.prepare('SELECT is_cup FROM menu WHERE name = ?').get(name);
  return row ? row.is_cup === 1 : true;
}

function priceOf(name) {
  const row = db.prepare('SELECT price FROM menu WHERE name = ?').get(name);
  return row ? row.price : 0;
}

function historyObject() {
  const days = db.prepare(`
    SELECT date,
           SUM(amount) AS total,
           SUM(CASE WHEN LOWER(method) = 'cash'  THEN amount ELSE 0 END) AS cash,
           SUM(CASE WHEN LOWER(method) = 'gcash' THEN amount ELSE 0 END) AS gcash
    FROM sales
    GROUP BY date
    ORDER BY date ASC
  `).all();

  const out = {};
  for (const d of days) {
    const cups = {};
    const cupRows = db.prepare(`
      SELECT si.name, SUM(si.qty) AS qty
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.date = ? AND si.is_cup = 1
      GROUP BY si.name
    `).all(d.date);
    for (const c of cupRows) cups[c.name] = c.qty;

    const sales = db.prepare(`
      SELECT s.id, s.time, s.method, s.amount,
             GROUP_CONCAT(si.name || ' × ' || si.qty, ', ') AS "order"
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.date = ?
      GROUP BY s.id
      ORDER BY s.id DESC
    `).all(d.date);

    out[d.date] = { sales, cups, total: d.total, cash: d.cash, gcash: d.gcash };
  }
  return out;
}

// ---------- API ----------

app.get('/api/db', (req, res) => {
  const menu = {};
  for (const r of db.prepare('SELECT id, name, price FROM menu').all()) {
    menu[r.id] = { name: r.name, price: r.price };
  }

  const inventory = db.prepare('SELECT id, name, unit, stock FROM inventory').all();

  const sales = db.prepare(`
    SELECT s.id, s.time, s.method, s.amount,
           GROUP_CONCAT(si.name || ' × ' || si.qty, ', ') AS "order"
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all();

  const logs = db.prepare('SELECT when_ AS "when", user, action FROM logs ORDER BY id DESC').all();

  const rep = getReport();

  res.json({
    settings: {},
    currentUser: { role: 'owner', name: ownerName() },
    menu, inventory, sales, logs,
    reportStatus: rep.status,
    reportSignedBy: rep.signedBy,
    reportSignedAt: rep.signedAt,
    reportDate: rep.date,
    history: historyObject()
  });
});

app.get('/api/me', (req, res) => res.json({ role: 'owner', name: ownerName() }));

app.get('/api/report', (req, res) => {
  const today = todayKey();

  const todayStats = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(amount), 0) AS total,
           COALESCE(SUM(CASE WHEN LOWER(method) = 'cash'  THEN amount ELSE 0 END), 0) AS cash,
           COALESCE(SUM(CASE WHEN LOWER(method) = 'gcash' THEN amount ELSE 0 END), 0) AS gcash
    FROM sales WHERE date = ?
  `).get(today);

  const cups = {};
  const cupRows = db.prepare(`
    SELECT si.name, SUM(si.qty) AS qty
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.date = ? AND si.is_cup = 1
    GROUP BY si.name
  `).all(today);
  for (const c of cupRows) cups[c.name] = c.qty;

  const todayCups = Object.values(cups).reduce((a, b) => a + b, 0);

  const prev7 = db.prepare(`
    SELECT date, SUM(amount) AS total,
           (SELECT COALESCE(SUM(si.qty), 0)
              FROM sale_items si
              JOIN sales s2 ON s2.id = si.sale_id
              WHERE s2.date = sales.date AND si.is_cup = 1) AS cups
    FROM sales
    WHERE date < ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT 7
  `).all(today);
  const avg7 = prev7.length
    ? Math.round(prev7.reduce((s, d) => s + d.cups, 0) / prev7.length)
    : todayCups;

  const last30Row = db.prepare(`
    SELECT COALESCE(SUM(si.qty), 0) AS cups
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.date < ? AND si.is_cup = 1
      AND s.date >= date('now', '-30 days')
  `).get(today);
  const last30 = (last30Row.cups || 0) + todayCups;

  const rep = getReport();
  const logs = db.prepare('SELECT when_ AS "when", user, action FROM logs ORDER BY id DESC LIMIT 50').all();

  res.json({
    date: today,
    total: todayStats.total, cash: todayStats.cash, gcash: todayStats.gcash, count: todayStats.count,
    cups, avg7, last30,
    todayCups,
    status: rep.status,
    signedBy: rep.signedBy,
    signedAt: rep.signedAt,
    logs
  });
});

// ---------- Auth ----------
app.post('/login', (req, res) => {
  const { role, pin, barista } = req.body;
  if (role === 'owner') {
    if (String(pin) === String(getSetting('ownerPin'))) {
      setSetting('ownerName', 'Maria Santos');
      return res.redirect('/Index.html');
    }
    return res.redirect('/Login.html?error=wrong_pin');
  }
  if (role === 'barista') {
    setSetting('ownerName', barista || 'Barista 1');
    return res.redirect('/Barista_index.html');
  }
  res.redirect('/Login.html');
});

app.get('/logout', (req, res) => {
  setSetting('ownerName', 'Guest');
  res.redirect('/Login.html');
});

// ---------- Sales ----------
app.post('/record-sale', (req, res) => {
  const summary = (req.body.orderSummary || '').trim();
  const amount  = parseInt(req.body.amount, 10);
  const method  = (String(req.body.method || '').toLowerCase() === 'gcash') ? 'GCash' : 'Cash';

  if (!summary || !amount || amount <= 0) {
    return res.redirect('/Index.html?error=empty');
  }

  const items = parseOrder(summary);
  const today = todayKey();
  const timeStr = stamp();

  try {
    db.exec('BEGIN');
    const info = db.prepare('INSERT INTO sales (time, date, method, amount) VALUES (?, ?, ?, ?)')
      .run(timeStr, today, method, amount);
    const saleId = info.lastInsertRowid;

    const addItem = db.prepare('INSERT INTO sale_items (sale_id, name, qty, is_cup, price) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) {
      addItem.run(saleId, it.name, it.qty, isCupItem(it.name) ? 1 : 0, priceOf(it.name));
    }

    const cupsCount = items.filter(it => isCupItem(it.name)).reduce((s, it) => s + it.qty, 0);
    db.prepare("UPDATE inventory SET stock = MAX(0, stock - ?) WHERE LOWER(name) = 'cups'").run(cupsCount);

    addLog(ownerName(), `Recorded sale #${saleId} (${summary} – ₱ ${amount}, ${method})`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
    return res.redirect('/Index.html?error=server');
  }

  res.redirect('/Index.html');
});

app.post('/void-sale', (req, res) => {
  const id = parseInt(req.body.saleId, 10);
  const sale = db.prepare('SELECT id, amount, method FROM sales WHERE id = ?').get(id);

  if (!sale) {
    addLog(ownerName(), `Attempted to void missing sale #${id}`);
    return res.redirect('/Ledger.html');
  }

  const items = db.prepare('SELECT name, qty, is_cup FROM sale_items WHERE sale_id = ?').all(id);
  const cupsToReturn = items.filter(it => it.is_cup === 1).reduce((s, it) => s + it.qty, 0);

  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    db.prepare("UPDATE inventory SET stock = stock + ? WHERE LOWER(name) = 'cups'").run(cupsToReturn);
    addLog(ownerName(), `Voided sale #${id} (₱ ${sale.amount}, ${sale.method}); ${cupsToReturn} cup(s) returned`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
  }
  res.redirect('/Ledger.html');
});

// ---------- Inventory ----------
app.post('/inventory/add', (req, res) => {
  const name = (req.body.name || '').trim();
  const unitChoice = (req.body.unit || 'units').trim();
  const unit = unitChoice === 'Other' ? (req.body.customUnit || '').trim() : unitChoice;
  const stock = Math.max(0, parseInt(req.body.stock, 10) || 0);
  if (!name) return res.redirect('/Inventory.html?error=name');
  if (!unit) return res.redirect('/Inventory.html?error=unit');

  const exists = db.prepare('SELECT id FROM inventory WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) return res.redirect('/Inventory.html?error=dupe');

  db.prepare('INSERT INTO inventory (id, name, unit, stock) VALUES (?, ?, ?, ?)')
    .run('inv-' + Date.now(), name, unit, stock);
  addLog(ownerName(), `Added inventory item "${name}" (${stock} ${unit})`);
  res.redirect('/Inventory.html');
});

app.post('/inventory/delete', (req, res) => {
  const id = req.body.id;
  const item = db.prepare('SELECT name FROM inventory WHERE id = ?').get(id);
  if (item) {
    db.prepare('DELETE FROM inventory WHERE id = ?').run(id);
    addLog(ownerName(), `Removed inventory item "${item.name}"`);
  }
  res.redirect('/Inventory.html');
});

app.post('/inventory/restock', (req, res) => {
  const id = req.body.id;
  const qty = parseInt(req.body.qty, 10) || 0;
  const item = db.prepare('SELECT name, unit FROM inventory WHERE id = ?').get(id);
  if (item && qty > 0) {
    db.prepare('UPDATE inventory SET stock = stock + ? WHERE id = ?').run(qty, id);
    addLog(ownerName(), `Restocked ${qty} ${item.unit} of ${item.name}`);
  }
  res.redirect('/Inventory.html');
});

app.post('/inventory/waste', (req, res) => {
  const id = req.body.id;
  const qty = parseInt(req.body.qty, 10) || 0;
  const reason = req.body.reason || 'Spoiled';
  const item = db.prepare('SELECT name, unit FROM inventory WHERE id = ?').get(id);
  if (item && qty > 0) {
    db.prepare('UPDATE inventory SET stock = MAX(0, stock - ?) WHERE id = ?').run(qty, id);
    addLog(ownerName(), `Logged wastage: ${qty} ${item.unit} of ${item.name} (${reason})`);
  }
  res.redirect('/Inventory.html');
});

// ---------- Menu ----------
app.post('/menu/update', (req, res) => {
  const id = req.body.id;
  const name = (req.body.name || '').trim();
  const price = parseInt(req.body.price, 10);
  if (!name || !price || price <= 0) return res.redirect('/Prices.html?error=bad');
  const existing = db.prepare('SELECT id FROM menu WHERE id = ?').get(id);
  if (!existing) return res.redirect('/Prices.html?error=missing');
  db.prepare('UPDATE menu SET name = ?, price = ? WHERE id = ?').run(name, price, id);
  addLog(ownerName(), `Updated menu item "${name}" to ₱ ${price}`);
  res.redirect('/Prices.html');
});

app.post('/menu/add', (req, res) => {
  const name = (req.body.name || '').trim();
  const price = parseInt(req.body.price, 10);
  const isCup = req.body.isCup === '0' ? 0 : 1;
  if (!name || !price || price <= 0) return res.redirect('/Prices.html?error=bad');
  const id = 'it-' + Date.now();
  db.prepare('INSERT INTO menu (id, name, price, is_cup) VALUES (?, ?, ?, ?)').run(id, name, price, isCup);
  addLog(ownerName(), `Added menu item "${name}" at ₱ ${price}${isCup ? '' : ' (not a cup)'}`);
  res.redirect('/Prices.html');
});

app.post('/menu/delete', (req, res) => {
  const id = req.body.id;
  const item = db.prepare('SELECT name FROM menu WHERE id = ?').get(id);
  if (item) {
    db.prepare('DELETE FROM menu WHERE id = ?').run(id);
    addLog(ownerName(), `Removed menu item "${item.name}"`);
  }
  res.redirect('/Prices.html');
});

// ---------- Report ----------
app.post('/verify-report', (req, res) => {
  const name = (req.body.signedBy || '').trim() || 'Maria Santos';
  setReport('Verified', name, stamp(), todayKey());
  addLog(ownerName(), `Verified & signed off daily report as ${name}`);
  res.redirect('/Report.html');
});

app.post('/unverify-report', (req, res) => {
  setReport('Pending review', null, null);
  addLog(ownerName(), 'Reset report verification (pending review)');
  res.redirect('/Report.html');
});

// ---------- Boot ----------
process.on('SIGINT',  () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

app.listen(PORT, () => console.log(`CupSion FMIS (SQLite) → http://localhost:${PORT}/Login.html`));