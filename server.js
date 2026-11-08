const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');
process.env.TZ = process.env.TZ || 'Asia/Manila';
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const DB_FILE = process.env.FMIS_DB_FILE || path.join(__dirname, 'cupsion.db');
const db = new DatabaseSync(DB_FILE);
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BARISTA_PASSWORD = 'barista123';
const COOKIE_FLAGS = process.env.NODE_ENV === 'production' ? '; Secure' : '';

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
    stock REAL NOT NULL DEFAULT 0,
    expires_on TEXT
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

  CREATE TABLE IF NOT EXISTS recipes (
    menu_id TEXT NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
    inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL DEFAULT 'units',
    PRIMARY KEY (menu_id, inventory_id)
  );

  CREATE TABLE IF NOT EXISTS sale_consumption (
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    inventory_id TEXT NOT NULL,
    ingredient_name TEXT NOT NULL,
    unit TEXT NOT NULL,
    quantity REAL NOT NULL,
    PRIMARY KEY (sale_id, inventory_id)
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
  addInv.run('ube-powder',    'Ube powder',    'g',  14);
  addInv.run('matcha-powder', 'Matcha powder', 'g',  42);
  addInv.run('cups',          'Cups',          'pcs', 1200);

  const upsert = db.prepare('INSERT INTO report_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('status',   'Pending review');
  upsert.run('signedBy', null);
  upsert.run('signedAt', null);
  upsert.run('date',     null);
}
seedIfEmpty();

const inventoryColumns = db.prepare('PRAGMA table_info(inventory)').all().map(column => column.name);
if (!inventoryColumns.includes('expires_on')) {
  db.exec('ALTER TABLE inventory ADD COLUMN expires_on TEXT');
}
const recipeColumns = db.prepare('PRAGMA table_info(recipes)').all().map(column => column.name);
if (!recipeColumns.includes('unit')) {
  db.exec("ALTER TABLE recipes ADD COLUMN unit TEXT NOT NULL DEFAULT 'units'");
  db.exec('UPDATE recipes SET unit = (SELECT unit FROM inventory WHERE inventory.id = recipes.inventory_id)');
}
db.exec(`
  INSERT OR IGNORE INTO recipes (menu_id, inventory_id, quantity, unit)
    SELECT menu.id, inventory.id, 1, inventory.unit
    FROM menu, inventory
    WHERE menu.is_cup = 1 AND LOWER(inventory.name) = 'cups';
`);

// ---------- Helpers ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function dateKeyOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDaysToDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysBetweenDateKeys(start, end) {
  const [startYear, startMonth, startDay] = start.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  return (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) / 86400000;
}

function mondayOfDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return addDaysToDateKey(value, -((date.getUTCDay() + 6) % 7));
}

function lastDayOfMonthDateKey(value) {
  const [year, month] = value.split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function stamp() {
  const d = new Date();
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalizeUnit(unit) {
  return String(unit || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
}

function unitGroup(unit) {
  const u = normalizeUnit(unit);
  if (['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc', 'cm3'].includes(u)) return 'volume';
  if (['l', 'liter', 'liters', 'litre', 'litres'].includes(u)) return 'volume';
  if (['g', 'gram', 'grams'].includes(u)) return 'mass';
  if (['kg', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'].includes(u)) return 'mass';
  if (['pcs', 'pc', 'piece', 'pieces', 'unit', 'units'].includes(u)) return 'count';
  return null;
}

function unitToBase(value, unit) {
  const u = normalizeUnit(unit);
  if (['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc', 'cm3'].includes(u)) return value / 1000;
  if (['l', 'liter', 'liters', 'litre', 'litres'].includes(u)) return value;
  if (['g', 'gram', 'grams'].includes(u)) return value;
  if (['kg', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'].includes(u)) return value * 1000;
  return value;
}

function baseToUnit(value, unit) {
  const u = normalizeUnit(unit);
  if (['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc', 'cm3'].includes(u)) return value * 1000;
  if (['l', 'liter', 'liters', 'litre', 'litres'].includes(u)) return value;
  if (['g', 'gram', 'grams'].includes(u)) return value;
  if (['kg', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'].includes(u)) return value / 1000;
  return value;
}

function convertQuantityToUnit(value, fromUnit, toUnit) {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!Number.isFinite(value) || value < 0) return value;
  if (!from || !to || from === to) return value;
  const fromGroup = unitGroup(from);
  const toGroup = unitGroup(to);
  if (fromGroup && toGroup && fromGroup !== toGroup) return NaN;
  return baseToUnit(unitToBase(value, from), to);
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
if (!salesColumns.includes('recorded_by_username')) {
  db.exec('ALTER TABLE sales ADD COLUMN recorded_by_username TEXT');
}
if (!salesColumns.includes('inventory_tracked')) {
  db.exec('ALTER TABLE sales ADD COLUMN inventory_tracked INTEGER NOT NULL DEFAULT 0');
}
if (!salesColumns.includes('cash_received')) {
  db.exec('ALTER TABLE sales ADD COLUMN cash_received INTEGER');
}
if (!salesColumns.includes('change_given')) {
  db.exec('ALTER TABLE sales ADD COLUMN change_given INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare("SELECT username FROM users WHERE role = 'owner'").get()) {
  const initialPassword = getSetting('ownerPin') || '1234';
  const credentials = hashPassword(initialPassword);
  db.prepare('INSERT INTO users (username, name, role, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run('owner', 'Maria Santos', 'owner', credentials.salt, credentials.hash);
}
db.prepare("DELETE FROM settings WHERE key IN ('ownerPin', 'ownerName')").run();
db.exec(`
  UPDATE sales
  SET recorded_by_username = (
    SELECT username FROM users
    WHERE users.name = sales.recorded_by
    GROUP BY users.name
    HAVING COUNT(*) = 1
  )
  WHERE recorded_by_username IS NULL
    AND recorded_by IN (
      SELECT name FROM users GROUP BY name HAVING COUNT(*) = 1
    );
  CREATE INDEX IF NOT EXISTS idx_sales_recorded_by_username
    ON sales(recorded_by_username);
`);

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
  res.setHeader('Set-Cookie', `fmis_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${COOKIE_FLAGS}`);
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
      ['/index.html', '/ledger.html', '/inventory.html', '/sales.html', '/forecast.html', '/prices.html', '/report.html', '/logs.html'].includes(lowerPath)) {
    return res.redirect('/Barista_index.html');
  }
  if (req.user.role === 'owner' && (lowerPath.startsWith('/barista_') || lowerPath === '/barista_forecast.html')) {
    return res.redirect('/Index.html');
  }
  next();
});

app.get('/', (req, res) => res.redirect(req.user ? (req.user.role === 'barista' ? '/Barista_index.html' : '/Index.html') : '/Login.html'));
const PUBLIC_FILES = new Map([
  ['/barista_index.html', 'Barista_index.html'],
  ['/barista_inventory.html', 'Barista_inventory.html'],
  ['/barista_ledger.html', 'Barista_ledger.html'],
  ['/barista_sales.html', 'Barista_sales.html'],
  ['/barista_forecast.html', 'Barista_Forecast.html'],
  ['/index.html', 'Index.html'],
  ['/inventory.html', 'Inventory.html'],
  ['/ledger.html', 'Ledger.html'],
  ['/login.html', 'Login.html'],
  ['/logs.html', 'Logs.html'],
  ['/prices.html', 'Prices.html'],
  ['/report.html', 'Report.html'],
  ['/sales.html', 'Sales.html'],
  ['/forecast.html', 'Forecast.html'],
  ['/forecast.js', 'forecast.js'],
  ['/user.js', 'user.js'],
  ['/settings.html', 'Settings.html'],
  ['/styles.css', 'Styles.css']
]);

app.get('*', (req, res, next) => {
  const file = PUBLIC_FILES.get(req.path.toLowerCase());
  if (!file) return next();
  res.sendFile(path.join(__dirname, file));
});

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

function parseOrder(orderData, summary) {
  if (orderData) {
    let rows;
    try {
      rows = JSON.parse(orderData);
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    const parsed = rows.map(row => {
      if (!row || typeof row !== 'object') return null;
      const qty = Number(row.qty);
      const item = db.prepare('SELECT id, name, price, is_cup AS isCup FROM menu WHERE id = ?').get(String(row.id || ''));
      return item && Number.isSafeInteger(qty) && qty > 0 ? { ...item, qty } : null;
    });
    return parsed.some(item => !item) ? [] : parsed;
  }

  const availableItems = db.prepare('SELECT id, name, price, is_cup AS isCup FROM menu ORDER BY LENGTH(name) DESC').all();
  const parsed = [];
  for (const part of String(summary || '').split(',')) {
    const match = part.trim().match(/^(.+?)\s*\u00d7\s*(\d+)$/);
    if (!match) return [];
    const item = availableItems.find(candidate => candidate.name === match[1].trim());
    const qty = Number(match[2]);
    if (!item || !Number.isSafeInteger(qty) || qty <= 0) return [];
    parsed.push({ ...item, qty });
  }
  return parsed;
}

function salesForUser(user, date = null) {
  const owner = user.role === 'owner';
  const recordedBy = owner
    ? `, CASE
         WHEN u.username IS NULL THEN s.recorded_by
         WHEN u.role = 'owner' THEN u.name || ' · Owner'
         ELSE u.name || ' · Barista'
       END AS recordedBy`
    : '';
  return db.prepare(`
    SELECT s.id, s.time, s.method, s.amount,
           s.cash_received AS cashReceived, s.change_given AS changeGiven${recordedBy},
           GROUP_CONCAT(si.name || ' × ' || si.qty, ', ') AS "order"
    FROM sales s
    LEFT JOIN users u ON u.username = s.recorded_by_username
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE (? = 1 OR s.recorded_by_username = ?)
      AND (? IS NULL OR s.date = ?)
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all(owner ? 1 : 0, user.username, date, date);
}

function historyObject(user) {
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

    const day = { cups, total: d.total, cash: d.cash, gcash: d.gcash };
    if (user.role === 'owner') day.sales = salesForUser(user, d.date);
    out[d.date] = day;
  }
  return out;
}

// ---------- API ----------

app.get('/api/db', (req, res) => {
  const menu = {};
  for (const r of db.prepare('SELECT id, name, price FROM menu').all()) {
    menu[r.id] = { name: r.name, price: r.price, ingredients: [] };
  }
  const recipes = db.prepare(`
    SELECT recipes.menu_id AS menuId, recipes.inventory_id AS inventoryId,
           recipes.quantity, recipes.unit, inventory.name AS ingredientName
    FROM recipes JOIN inventory ON inventory.id = recipes.inventory_id
    ORDER BY inventory.name
  `).all();
  for (const recipe of recipes) {
    if (menu[recipe.menuId]) menu[recipe.menuId].ingredients.push(recipe);
  }

  const inventory = db.prepare('SELECT id, name, unit, stock, expires_on AS expiresOn FROM inventory').all();
  const expiryAlerts = inventory
    .filter(item => item.stock > 0 && item.expiresOn && isValidDateKey(item.expiresOn) && item.expiresOn <= dateKeyOffset(7))
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));

  const sales = salesForUser(req.user);

  const logs = req.user.role === 'owner'
    ? db.prepare('SELECT when_ AS "when", user, action FROM logs ORDER BY id DESC').all()
    : [];

  const rep = getReport();

  res.json({
    settings: {},
    currentUser: { role: req.user.role, name: req.user.name, username: req.user.username },
    menu, inventory, expiryAlerts, sales, logs,
    reportStatus: rep.status,
    reportSignedBy: rep.signedBy,
    reportSignedAt: rep.signedAt,
    reportDate: rep.date,
    history: historyObject(req.user)
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
  const logs = req.user.role === 'owner'
    ? db.prepare('SELECT when_ AS "when", user, action FROM logs ORDER BY id DESC LIMIT 50').all()
    : [];

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

app.get('/api/forecast', (req, res) => {
  const today = todayKey();
  const lookbackStart = dateKeyOffset(-30);
  const firstTrackedSale = db.prepare(`
    SELECT MIN(date) AS firstDate
    FROM sales
    WHERE inventory_tracked = 1 AND date >= ? AND date < ?
  `).get(lookbackStart, today).firstDate;
  const inventoryHistoryDays = firstTrackedSale
    ? daysBetweenDateKeys(firstTrackedSale, today)
    : 0;
  const inventoryById = new Map(
    db.prepare('SELECT id, name, unit, stock FROM inventory').all().map(item => [item.id, item])
  );
  const usageById = new Map();

  if (inventoryHistoryDays > 0) {
    const consumptionRows = db.prepare(`
      SELECT sc.inventory_id AS inventoryId, sc.quantity, sc.unit
      FROM sale_consumption sc
      JOIN sales s ON s.id = sc.sale_id
      WHERE s.inventory_tracked = 1 AND s.date >= ? AND s.date < ?
    `).all(lookbackStart, today);

    for (const row of consumptionRows) {
      const item = inventoryById.get(row.inventoryId);
      if (!item) continue;

      const fromUnit = normalizeUnit(row.unit);
      const toUnit = normalizeUnit(item.unit);
      const fromGroup = unitGroup(fromUnit);
      const toGroup = unitGroup(toUnit);
      const compatible = fromUnit === toUnit || (fromGroup && fromGroup === toGroup);
      const usage = usageById.get(row.inventoryId) || { quantity: 0, incompatibleUnits: false };
      if (!compatible) {
        usage.incompatibleUnits = true;
      } else {
        const quantity = convertQuantityToUnit(Number(row.quantity), row.unit, item.unit);
        if (Number.isFinite(quantity) && quantity >= 0) usage.quantity += quantity;
        else usage.incompatibleUnits = true;
      }
      usageById.set(row.inventoryId, usage);
    }
  }

  const inventory = [...inventoryById.values()].map(item => {
    const usage = usageById.get(item.id);
    const averageDailyUse = inventoryHistoryDays > 0 && usage && !usage.incompatibleUnits
      ? usage.quantity / inventoryHistoryDays
      : null;
    let status = 'no-history';
    let runOutDate = null;
    if (item.stock <= 0) {
      status = 'out';
      runOutDate = today;
    } else if (inventoryHistoryDays > 0 && usage && usage.incompatibleUnits) {
      status = 'unit-mismatch';
    } else if (averageDailyUse !== null && averageDailyUse > 0) {
      status = 'forecast';
      runOutDate = addDaysToDateKey(today, Math.floor(item.stock / averageDailyUse));
    } else if (inventoryHistoryDays > 0) {
      status = 'no-demand';
    }

    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      stock: item.stock,
      averageDailyUse,
      runOutDate,
      status
    };
  });

  const firstProductSale = db.prepare(`
    SELECT MIN(s.date) AS firstDate
    FROM sales s JOIN sale_items si ON si.sale_id = s.id
    WHERE si.is_cup = 1 AND s.date >= ? AND s.date < ?
  `).get(lookbackStart, today).firstDate;
  const productHistoryDays = firstProductSale
    ? daysBetweenDateKeys(firstProductSale, today)
    : 0;
  const weekStart = mondayOfDateKey(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const weekEnd = addDaysToDateKey(weekStart, 6);
  const monthEnd = lastDayOfMonthDateKey(today);
  const productQueryStart = monthStart < lookbackStart ? monthStart : lookbackStart;
  const productRows = db.prepare(`
    SELECT si.name,
           SUM(CASE WHEN s.date >= ? AND s.date < ? THEN si.qty ELSE 0 END) AS recentQuantity,
           SUM(CASE WHEN s.date >= ? AND s.date < ? THEN si.qty ELSE 0 END) AS weekToDate,
           SUM(CASE WHEN s.date >= ? AND s.date < ? THEN si.qty ELSE 0 END) AS monthToDate
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE si.is_cup = 1 AND s.date >= ? AND s.date < ?
    GROUP BY si.name
  `).all(lookbackStart, today, weekStart, today, monthStart, today, productQueryStart, today);

  function topProducts(period, endDate) {
    const remainingDays = daysBetweenDateKeys(today, endDate) + 1;
    if (!productHistoryDays || !productRows.length) {
      return { remainingDays, leaders: [] };
    }
    const quantityKey = period === 'week' ? 'weekToDate' : 'monthToDate';
    const leaders = productRows.map(row => {
      const recentAverage = row.recentQuantity / productHistoryDays;
      const soldSoFar = row[quantityKey] || 0;
      return {
        name: row.name,
        soldSoFar,
        projectedTotal: soldSoFar + recentAverage * remainingDays
      };
    }).sort((a, b) => b.projectedTotal - a.projectedTotal || b.soldSoFar - a.soldSoFar || a.name.localeCompare(b.name));
    return { remainingDays, leaders: leaders.slice(0, 3) };
  }

  res.json({
    method: 'Cumulative Demand Run-Out',
    date: today,
    lookbackDays: inventoryHistoryDays,
    productLookbackDays: productHistoryDays,
    inventory,
    bestsellers: {
      week: { startDate: weekStart, endDate: weekEnd, ...topProducts('week', weekEnd) },
      month: { startDate: monthStart, endDate: monthEnd, ...topProducts('month', monthEnd) }
    }
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
  res.setHeader('Set-Cookie', `fmis_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_FLAGS}`);
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
  const items = parseOrder(req.body.orderData, req.body.orderSummary);
  const summary = items.map(item => `${item.name} × ${item.qty}`).join(', ');
  const amount = items.reduce((total, item) => total + item.price * item.qty, 0);
  const method  = (String(req.body.method || '').toLowerCase() === 'gcash') ? 'GCash' : 'Cash';
  const cashReceived = method === 'Cash' ? Number(req.body.cashReceived) : null;
  const changeGiven = method === 'Cash' ? cashReceived - amount : 0;
  const redirectPath = req.user.role === 'barista' ? '/Barista_index.html' : '/Index.html';

  if (!items.length || items.some(item => item.qty > 10000) || !Number.isSafeInteger(amount) || amount <= 0) {
    return res.redirect(`${redirectPath}?error=empty`);
  }
  if (method === 'Cash' && (!Number.isSafeInteger(cashReceived) || cashReceived < amount)) {
    return res.redirect(`${redirectPath}?error=cash`);
  }

  const today = todayKey();
  const timeStr = stamp();
  let transactionOpen = false;

  try {
    db.exec('BEGIN');
    transactionOpen = true;

    const inventoryUnits = new Map(
      db.prepare('SELECT id, unit FROM inventory').all().map(row => [row.id, row.unit])
    );
    const requiredStock = new Map();
    const recipeQuery = db.prepare('SELECT inventory_id AS inventoryId, quantity, unit FROM recipes WHERE menu_id = ?');
    for (const item of items) {
      for (const ingredient of recipeQuery.all(item.id)) {
        const inventoryUnit = inventoryUnits.get(ingredient.inventoryId) || ingredient.unit;
        const needed = convertQuantityToUnit(ingredient.quantity * item.qty, ingredient.unit, inventoryUnit);
        if (!Number.isFinite(needed)) {
          db.exec('ROLLBACK');
          transactionOpen = false;
          return res.redirect(`${redirectPath}?error=stock&item=${encodeURIComponent((inventoryUnits.get(ingredient.inventoryId) || ingredient.unit) || 'ingredient')}`);
        }
        const quantity = Math.round((requiredStock.get(ingredient.inventoryId) || 0) * 1e6 + needed * 1e6) / 1e6;
        requiredStock.set(ingredient.inventoryId, quantity);
      }
    }

    const getStock = db.prepare('SELECT name, unit, stock FROM inventory WHERE id = ?');
    const updateStock = db.prepare('UPDATE inventory SET stock = stock - ? WHERE id = ?');
    const recordConsumption = db.prepare(`
      INSERT INTO sale_consumption (sale_id, inventory_id, ingredient_name, unit, quantity)
      VALUES (?, ?, ?, ?, ?)
    `);
    const consumption = [];
    for (const [inventoryId, quantity] of requiredStock) {
      const ingredient = getStock.get(inventoryId);
      if (!ingredient) {
        db.exec('ROLLBACK');
        transactionOpen = false;
        return res.redirect(`${redirectPath}?error=stock&item=${encodeURIComponent('ingredient')}`);
      }
      const inventoryUnit = ingredient.unit;
      const requiredQty = convertQuantityToUnit(quantity, inventoryUnit, inventoryUnit);
      if (!Number.isFinite(requiredQty) || ingredient.stock < requiredQty) {
        db.exec('ROLLBACK');
        transactionOpen = false;
        return res.redirect(`${redirectPath}?error=stock&item=${encodeURIComponent(ingredient.name)}`);
      }
      updateStock.run(requiredQty, inventoryId);
      consumption.push({ inventoryId, ingredient, quantity: requiredQty, unit: inventoryUnit });
    }

    const info = db.prepare(`
      INSERT INTO sales (time, date, method, amount, recorded_by, recorded_by_username, inventory_tracked, cash_received, change_given)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(timeStr, today, method, amount, req.user.name, req.user.username, cashReceived, changeGiven);
    const saleId = info.lastInsertRowid;
    for (const used of consumption) {
      recordConsumption.run(saleId, used.inventoryId, used.ingredient.name, used.ingredient.unit, used.quantity);
    }

    const addItem = db.prepare('INSERT INTO sale_items (sale_id, name, qty, is_cup, price) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) {
      addItem.run(saleId, it.name, it.qty, it.isCup, it.price);
    }

    addLog(req.user.name, `Recorded sale #${saleId} (${summary} – ₱ ${amount}, ${method})`);
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (e) {
    if (transactionOpen) db.exec('ROLLBACK');
    console.error(e);
    return res.redirect(`${redirectPath}?error=server`);
  }

  res.redirect(redirectPath);
});

app.post('/void-sale', requireOwner, (req, res) => {
  const id = parseInt(req.body.saleId, 10);
  const sale = db.prepare('SELECT id, amount, method, inventory_tracked AS inventoryTracked FROM sales WHERE id = ?').get(id);

  if (!sale) {
    addLog(req.user.name, `Attempted to void missing sale #${id}`);
    return res.redirect('/Ledger.html');
  }

  const consumed = db.prepare('SELECT inventory_id AS inventoryId, ingredient_name AS ingredientName, quantity FROM sale_consumption WHERE sale_id = ?').all(id);
  const items = db.prepare('SELECT name, qty, is_cup FROM sale_items WHERE sale_id = ?').all(id);
  const cupsToReturn = items.filter(it => it.is_cup === 1).reduce((s, it) => s + it.qty, 0);

  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    if (sale.inventoryTracked) {
      const restore = db.prepare('UPDATE inventory SET stock = stock + ? WHERE id = ?');
      for (const ingredient of consumed) restore.run(ingredient.quantity, ingredient.inventoryId);
    } else {
      db.prepare("UPDATE inventory SET stock = stock + ? WHERE LOWER(name) = 'cups'").run(cupsToReturn);
    }
    const returned = consumed.length
      ? consumed.map(ingredient => `${ingredient.quantity} ${ingredient.ingredientName}`).join(', ')
      : `${cupsToReturn} cup(s)`;
    addLog(req.user.name, `Voided sale #${id} (₱ ${sale.amount}, ${sale.method}); returned ${returned}`);
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
  const stock = Number(req.body.stock);
  const expiresOn = String(req.body.expiresOn || '').trim();
  if (!name) return res.redirect('/Inventory.html?error=name');
  if (!unit) return res.redirect('/Inventory.html?error=unit');
  if (!Number.isFinite(stock) || stock < 0) return res.redirect('/Inventory.html?error=stock');
  if (expiresOn && !isValidDateKey(expiresOn)) return res.redirect('/Inventory.html?error=expiry');

  const exists = db.prepare('SELECT id FROM inventory WHERE LOWER(name) = LOWER(?)').get(name);
  if (exists) return res.redirect('/Inventory.html?error=dupe');

  db.prepare('INSERT INTO inventory (id, name, unit, stock, expires_on) VALUES (?, ?, ?, ?, ?)')
    .run('inv-' + Date.now(), name, unit, stock, expiresOn || null);
  addLog(req.user.name, `Added inventory item "${name}" (${stock} ${unit})`);
  res.redirect('/Inventory.html');
});

app.post('/inventory/unit', requireOwner, (req, res) => {
  const id = String(req.body.id || '');
  const unit = String(req.body.unit || '').trim();
  if (!unit || unit.length > 30) return res.redirect('/Inventory.html?error=unit');

  const item = db.prepare('SELECT name, unit AS previousUnit FROM inventory WHERE id = ?').get(id);
  if (item) {
    db.prepare('UPDATE inventory SET unit = ? WHERE id = ?').run(unit, id);
    addLog(req.user.name, `Updated unit for "${item.name}" from ${item.previousUnit} to ${unit}`);
  }
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
  const qty = Number(req.body.qty);
  const expiresOn = String(req.body.expiresOn || '').trim();
  const item = db.prepare('SELECT name, unit FROM inventory WHERE id = ?').get(id);
  if (!Number.isFinite(qty) || qty <= 0 || (expiresOn && !isValidDateKey(expiresOn))) {
    return res.redirect(`/Inventory.html?error=${expiresOn && !isValidDateKey(expiresOn) ? 'expiry' : 'stock'}`);
  }
  if (item) {
    db.prepare(`
      UPDATE inventory
      SET stock = stock + ?, expires_on = CASE WHEN ? = '' THEN expires_on ELSE ? END
      WHERE id = ?
    `).run(qty, expiresOn, expiresOn, id);
    addLog(req.user.name, `Restocked ${qty} ${item.unit} of ${item.name}`);
  }
  res.redirect('/Inventory.html');
});

app.post('/inventory/expiry', requireOwner, (req, res) => {
  const id = String(req.body.id || '');
  const expiresOn = String(req.body.expiresOn || '').trim();
  if (expiresOn && !isValidDateKey(expiresOn)) return res.redirect('/Inventory.html?error=expiry');
  const item = db.prepare('SELECT name FROM inventory WHERE id = ?').get(id);
  if (item) {
    db.prepare('UPDATE inventory SET expires_on = ? WHERE id = ?').run(expiresOn || null, id);
    addLog(req.user.name, `${expiresOn ? 'Updated' : 'Cleared'} expiration date for "${item.name}"`);
  }
  res.redirect('/Inventory.html');
});

app.post('/inventory/waste', (req, res) => {
  const id = req.body.id;
  const qty = Number(req.body.qty);
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
  if (isCup) {
    const cups = db.prepare("SELECT id, unit FROM inventory WHERE LOWER(name) = 'cups'").get();
    if (cups) {
      db.prepare(`
        INSERT OR IGNORE INTO recipes (menu_id, inventory_id, quantity, unit)
        VALUES (?, ?, 1, ?)
      `).run(id, cups.id, cups.unit);
    }
  }
  addLog(req.user.name, `Added menu item "${name}" at ₱ ${price}${isCup ? '' : ' (not a cup)'}`);
  res.redirect('/Prices.html');
});

app.post('/menu/recipe', requireOwner, (req, res) => {
  const menuId = String(req.body.menuId || '');
  const inventoryId = String(req.body.inventoryId || '');
  const quantity = Number(req.body.quantity);
  const unit = String(req.body.unit || '').trim();
  const menuItem = db.prepare('SELECT name FROM menu WHERE id = ?').get(menuId);
  const ingredient = db.prepare('SELECT name FROM inventory WHERE id = ?').get(inventoryId);

  if (!menuItem || !ingredient || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000
      || !unit || unit.length > 30) {
    return res.redirect(`/Prices.html?error=recipe&menuId=${encodeURIComponent(menuId)}`);
  }

  db.prepare(`
    INSERT INTO recipes (menu_id, inventory_id, quantity, unit) VALUES (?, ?, ?, ?)
    ON CONFLICT(menu_id, inventory_id) DO UPDATE SET
      quantity = excluded.quantity,
      unit = excluded.unit
  `).run(menuId, inventoryId, quantity, unit);
  addLog(req.user.name, `Set ${quantity} ${unit} of ${ingredient.name} per ${menuItem.name}`);
  res.redirect(`/Prices.html?recipe_saved=1&menuId=${encodeURIComponent(menuId)}`);
});

app.post('/menu/recipe/delete', requireOwner, (req, res) => {
  const menuId = String(req.body.menuId || '');
  const inventoryId = String(req.body.inventoryId || '');
  const recipe = db.prepare(`
    SELECT menu.name AS menuName, inventory.name AS ingredientName
    FROM recipes
    JOIN menu ON menu.id = recipes.menu_id
    JOIN inventory ON inventory.id = recipes.inventory_id
    WHERE recipes.menu_id = ? AND recipes.inventory_id = ?
  `).get(menuId, inventoryId);
  if (recipe) {
    db.prepare('DELETE FROM recipes WHERE menu_id = ? AND inventory_id = ?').run(menuId, inventoryId);
    addLog(req.user.name, `Removed ${recipe.ingredientName} from ${recipe.menuName} recipe`);
  }
  res.redirect(`/Prices.html?recipe_saved=1&menuId=${encodeURIComponent(menuId)}`);
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