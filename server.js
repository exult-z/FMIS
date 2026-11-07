const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const DB_FILE = path.join(__dirname, 'cupsion.db');
const db = new DatabaseSync(DB_FILE);
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BARISTA_PASSWORD = 'barista123';

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

  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'barista')),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
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

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const salesColumns = db.prepare('PRAGMA table_info(sales)').all().map(column => column.name);
if (!salesColumns.includes('recorded_by')) {
  db.exec("ALTER TABLE sales ADD COLUMN recorded_by TEXT NOT NULL DEFAULT 'Owner'");
}

if (!db.prepare("SELECT username FROM users WHERE role = 'owner'").get()) {
  const initialPassword = getSetting('ownerPin') || '1234';
  const credentials = hashPassword(initialPassword);
  db.prepare('INSERT INTO users (username, name, role, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run('owner', 'Maria Santos', 'owner', credentials.salt, credentials.hash);
}
db.prepare("DELETE FROM settings WHERE key IN ('ownerPin', 'ownerName')").run();

function sessionUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith('fmis_session='));
  if (!cookie) return null;

  const token = cookie.slice('fmis_session='.length);
  if (!/^[\w-]{43}$/.test(token)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT u.username, u.name, u.role, u.must_change
    FROM sessions s JOIN users u ON u.username = s.username
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, Date.now());
  if (!row) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + SESSION_TTL;
  db.prepare('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, username, expiresAt);
  res.setHeader('Set-Cookie', `fmis_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

function currentSessionHash(req) {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith('fmis_session='));
  if (!cookie) return null;
  const token = cookie.slice('fmis_session='.length);
  return /^[\w-]{43}$/.test(token) ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  return res.status(403).send('Owner access required.');
}

app.use((req, res, next) => {
  const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
  if (pathname === '/login' || pathname.toLowerCase() === '/login.html' || pathname === '/logout') {
    return next();
  }
  if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?)$/i.test(pathname)) return next();

  req.user = sessionUser(req);
  if (!req.user) {
    if (pathname.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
    return res.redirect('/Login.html');
  }

  const lowerPath = pathname.toLowerCase();
  if (req.user.must_change && lowerPath !== '/settings.html' && lowerPath !== '/api/me' && lowerPath !== '/change-password') {
    if (pathname.startsWith('/api/')) return res.status(403).json({ error: 'Change your default password first.' });
    return res.redirect('/Settings.html?must_change=1');
  }

  if (req.user.role === 'barista' &&
      ['/index.html', '/ledger.html', '/inventory.html', '/sales.html', '/prices.html', '/report.html', '/logs.html'].includes(lowerPath)) {
    return res.redirect('/Barista_index.html');
  }
  if (req.user.role === 'owner' && lowerPath.startsWith('/barista_')) {
    return res.redirect('/Index.html');
  }
  next();
});

app.get('/', (req, res) => res.redirect(req.user ? (req.user.role === 'barista' ? '/Barista_index.html' : '/Index.html') : '/Login.html'));
app.use(express.static(__dirname));

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
      SELECT s.id, s.time, s.method, s.amount, s.recorded_by AS recordedBy,
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
    SELECT s.id, s.time, s.method, s.amount, s.recorded_by AS recordedBy,
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
    currentUser: { role: req.user.role, name: req.user.name, username: req.user.username },
    menu, inventory, sales, logs,
    reportStatus: rep.status,
    reportSignedBy: rep.signedBy,
    reportSignedAt: rep.signedAt,
    reportDate: rep.date,
    history: historyObject()
  });
});

app.get('/api/me', (req, res) => res.json({
  role: req.user.role,
  name: req.user.name,
  username: req.user.username,
  mustChange: Boolean(req.user.must_change)
}));

app.get('/api/users', requireOwner, (req, res) => {
  const users = db.prepare("SELECT username, name FROM users WHERE role = 'barista' ORDER BY name").all();
  res.json({ users });
});

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
  const role = req.body.role;
  const username = role === 'owner' ? 'owner' : String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT username, name, role, password_salt, password_hash, must_change FROM users WHERE username = ? AND role = ?')
    .get(username, role);

  if (!user || !passwordMatches(password, user.password_salt, user.password_hash)) {
    return res.redirect('/Login.html?error=wrong_password');
  }

  startSession(res, user.username);
  const destination = user.must_change
    ? '/Settings.html?must_change=1'
    : (user.role === 'barista' ? '/Barista_index.html' : '/Index.html');
  res.redirect(destination);
});

app.get('/logout', (req, res) => {
  const tokenHash = currentSessionHash(req);
  if (tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  res.setHeader('Set-Cookie', 'fmis_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/Login.html');
});

app.post('/register-barista', requireOwner, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(username) || !name || name.length > 80) {
    return res.redirect('/Settings.html?error=invalid_barista');
  }
  if (db.prepare('SELECT username FROM users WHERE username = ?').get(username)) {
    return res.redirect('/Settings.html?error=duplicate_username');
  }

  const credentials = hashPassword(DEFAULT_BARISTA_PASSWORD);
  db.prepare('INSERT INTO users (username, name, role, password_salt, password_hash, must_change) VALUES (?, ?, ?, ?, ?, 1)')
    .run(username, name, 'barista', credentials.salt, credentials.hash);
  addLog(req.user.name, `Registered barista account "${name}" (${username})`);
  res.redirect('/Settings.html?registered=1');
});

app.post('/change-password', (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const user = db.prepare('SELECT password_salt, password_hash FROM users WHERE username = ?').get(req.user.username);
  if (!passwordMatches(currentPassword, user.password_salt, user.password_hash)) {
    return res.redirect('/Settings.html?error=wrong_current_password');
  }
  if (newPassword.length < 8) return res.redirect('/Settings.html?error=password_too_short');
  if (newPassword !== confirmPassword) return res.redirect('/Settings.html?error=password_mismatch');

  const credentials = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, must_change = 0 WHERE username = ?')
    .run(credentials.salt, credentials.hash, req.user.username);

  const oldSessionHash = currentSessionHash(req);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(req.user.username);
  startSession(res, req.user.username);
  if (oldSessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(oldSessionHash);
  addLog(req.user.name, 'Changed account password');
  res.redirect('/Settings.html?password_changed=1');
});

// ---------- Sales ----------
app.post('/record-sale', (req, res) => {
  const summary = (req.body.orderSummary || '').trim();
  const amount  = parseInt(req.body.amount, 10);
  const method  = (String(req.body.method || '').toLowerCase() === 'gcash') ? 'GCash' : 'Cash';

  if (!summary || !amount || amount <= 0) {
    return res.redirect(req.user.role === 'barista' ? '/Barista_index.html?error=empty' : '/Index.html?error=empty');
  }

  const items = parseOrder(summary);
  const today = todayKey();
  const timeStr = stamp();

  try {
    db.exec('BEGIN');
    const info = db.prepare('INSERT INTO sales (time, date, method, amount, recorded_by) VALUES (?, ?, ?, ?, ?)')
      .run(timeStr, today, method, amount, req.user.name);
    const saleId = info.lastInsertRowid;

    const addItem = db.prepare('INSERT INTO sale_items (sale_id, name, qty, is_cup, price) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) {
      addItem.run(saleId, it.name, it.qty, isCupItem(it.name) ? 1 : 0, priceOf(it.name));
    }

    const cupsCount = items.filter(it => isCupItem(it.name)).reduce((s, it) => s + it.qty, 0);
    db.prepare("UPDATE inventory SET stock = MAX(0, stock - ?) WHERE LOWER(name) = 'cups'").run(cupsCount);

    addLog(req.user.name, `Recorded sale #${saleId} (${summary} – ₱ ${amount}, ${method})`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
    return res.redirect(req.user.role === 'barista' ? '/Barista_index.html?error=server' : '/Index.html?error=server');
  }

  res.redirect(req.user.role === 'barista' ? '/Barista_index.html' : '/Index.html');
});

app.post('/void-sale', requireOwner, (req, res) => {
  const id = parseInt(req.body.saleId, 10);
  const sale = db.prepare('SELECT id, amount, method FROM sales WHERE id = ?').get(id);

  if (!sale) {
    addLog(req.user.name, `Attempted to void missing sale #${id}`);
    return res.redirect('/Ledger.html');
  }

  const items = db.prepare('SELECT name, qty, is_cup FROM sale_items WHERE sale_id = ?').all(id);
  const cupsToReturn = items.filter(it => it.is_cup === 1).reduce((s, it) => s + it.qty, 0);

  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    db.prepare("UPDATE inventory SET stock = stock + ? WHERE LOWER(name) = 'cups'").run(cupsToReturn);
    addLog(req.user.name, `Voided sale #${id} (₱ ${sale.amount}, ${sale.method}); ${cupsToReturn} cup(s) returned`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
  }
  res.redirect('/Ledger.html');
});

// ---------- Inventory ----------
app.post('/inventory/add', requireOwner, (req, res) => {
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
  addLog(req.user.name, `Added inventory item "${name}" (${stock} ${unit})`);
  res.redirect('/Inventory.html');
});

app.post('/inventory/delete', requireOwner, (req, res) => {
  const id = req.body.id;
  const item = db.prepare('SELECT name FROM inventory WHERE id = ?').get(id);
  if (item) {
    db.prepare('DELETE FROM inventory WHERE id = ?').run(id);
    addLog(req.user.name, `Removed inventory item "${item.name}"`);
  }
  res.redirect('/Inventory.html');
});

app.post('/inventory/restock', requireOwner, (req, res) => {
  const id = req.body.id;
  const qty = parseInt(req.body.qty, 10) || 0;
  const item = db.prepare('SELECT name, unit FROM inventory WHERE id = ?').get(id);
  if (item && qty > 0) {
    db.prepare('UPDATE inventory SET stock = stock + ? WHERE id = ?').run(qty, id);
    addLog(req.user.name, `Restocked ${qty} ${item.unit} of ${item.name}`);
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
    addLog(req.user.name, `Logged wastage: ${qty} ${item.unit} of ${item.name} (${reason})`);
  }
  res.redirect(req.user.role === 'barista' ? '/Barista_inventory.html' : '/Inventory.html');
});

// ---------- Menu ----------
app.post('/menu/update', requireOwner, (req, res) => {
  const id = req.body.id;
  const name = (req.body.name || '').trim();
  const price = parseInt(req.body.price, 10);
  if (!name || !price || price <= 0) return res.redirect('/Prices.html?error=bad');
  const existing = db.prepare('SELECT id FROM menu WHERE id = ?').get(id);
  if (!existing) return res.redirect('/Prices.html?error=missing');
  db.prepare('UPDATE menu SET name = ?, price = ? WHERE id = ?').run(name, price, id);
  addLog(req.user.name, `Updated menu item "${name}" to ₱ ${price}`);
  res.redirect('/Prices.html');
});

app.post('/menu/add', requireOwner, (req, res) => {
  const name = (req.body.name || '').trim();
  const price = parseInt(req.body.price, 10);
  const isCup = req.body.isCup === '0' ? 0 : 1;
  if (!name || !price || price <= 0) return res.redirect('/Prices.html?error=bad');
  const id = 'it-' + Date.now();
  db.prepare('INSERT INTO menu (id, name, price, is_cup) VALUES (?, ?, ?, ?)').run(id, name, price, isCup);
  addLog(req.user.name, `Added menu item "${name}" at ₱ ${price}${isCup ? '' : ' (not a cup)'}`);
  res.redirect('/Prices.html');
});

app.post('/menu/delete', requireOwner, (req, res) => {
  const id = req.body.id;
  const item = db.prepare('SELECT name FROM menu WHERE id = ?').get(id);
  if (item) {
    db.prepare('DELETE FROM menu WHERE id = ?').run(id);
    addLog(req.user.name, `Removed menu item "${item.name}"`);
  }
  res.redirect('/Prices.html');
});

// ---------- Report ----------
app.post('/verify-report', requireOwner, (req, res) => {
  const name = (req.body.signedBy || '').trim() || 'Maria Santos';
  setReport('Verified', name, stamp(), todayKey());
  addLog(req.user.name, `Verified & signed off daily report as ${name}`);
  res.redirect('/Report.html');
});

app.post('/unverify-report', requireOwner, (req, res) => {
  setReport('Pending review', null, null);
  addLog(req.user.name, 'Reset report verification (pending review)');
  res.redirect('/Report.html');
});

// ---------- Boot ----------
process.on('SIGINT',  () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

app.listen(PORT, () => console.log(`CupSion FMIS (SQLite) → http://localhost:${PORT}/Login.html`));