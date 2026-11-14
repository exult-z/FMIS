const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const projectRoot = path.resolve(__dirname, '..');
let appProcess;
let driver;
let baseUrl;
let testDirectory;

async function postForm(pathname, values) {
  const result = await driver.executeAsyncScript((url, fields, done) => {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields)
    }).then(response => done({ status: response.status, url: response.url }))
      .catch(error => done({ error: error.message }));
  }, pathname, values);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.status, 200);
  return result;
}

async function getDatabase() {
  return driver.executeAsyncScript(done => {
    fetch('/api/db').then(response => response.json()).then(done)
      .catch(error => done({ error: error.message }));
  });
}

async function findAvailablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (appProcess.exitCode !== null) {
      throw new Error(`FMIS server exited during startup (code ${appProcess.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/Login.html`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('FMIS server did not become ready within five seconds.');
}

before(async () => {
  testDirectory = await mkdtemp(path.join(os.tmpdir(), 'fmis-selenium-'));
  const port = await findAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  appProcess = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      FMIS_DB_FILE: path.join(testDirectory, 'test.db'),
      FMIS_PRODUCT_IMAGES_DIR: path.join(testDirectory, 'product-images'),
      PORT: String(port),
      NODE_ENV: 'test'
    },
    stdio: 'ignore'
  });
  await waitForApp();

  const options = new chrome.Options().addArguments('--headless=new', '--window-size=1280,900');
  driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 10000, script: 10000 });
});

after(async () => {
  if (driver) await driver.quit();
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill();
    await once(appProcess, 'exit');
  }
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
});

test('owner can sign in, record a sale, view it in sales, and sign out', async () => {
  await driver.get(`${baseUrl}/Login.html`);
  await driver.findElement(By.name('password')).sendKeys('incorrect');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('error=wrong_password'), 5000);
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('login-error')),
    'Incorrect username or password.'
  ), 5000);

  await driver.findElement(By.name('password')).clear();
  await driver.findElement(By.name('password')).sendKeys('1234');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('/Index.html'), 5000);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);

  let menuItem = await driver.wait(
    until.elementLocated(By.css('#pos-menu [data-id="ml"]')),
    5000
  );
  const matchaPhoto = await menuItem.findElement(By.css('.product-photo'));
  assert.match(await matchaPhoto.getAttribute('src'), /product-images\/matcha-latte\.jpg$/);
  await driver.wait(
    () => driver.executeScript('return arguments[0].complete && arguments[0].naturalWidth > 0;', matchaPhoto),
    5000
  );
  await driver.wait(until.elementIsDisabled(menuItem), 5000);
  assert.match(await menuItem.findElement(By.css('.availability-message')).getText(), /Add ingredients/);
  const salesBeforeRejectedOrder = (await getDatabase()).sales.length;
  const rejectedOrder = await postForm('/record-sale', {
    orderData: JSON.stringify([{ id: 'ml', qty: 1 }]),
    method: 'Cash',
    cashReceived: '100'
  });
  assert.match(rejectedOrder.url, /Index\.html\?error=recipe&item=Matcha%20Latte$/);
  assert.equal((await getDatabase()).sales.length, salesBeforeRejectedOrder);

  await postForm('/menu/recipe', {
    menuId: 'ml',
    inventoryId: 'matcha-powder',
    quantity: '1',
    unit: 'g'
  });
  await postForm('/menu/recipe', {
    menuId: 'addon',
    inventoryId: 'ube-powder',
    quantity: '1',
    unit: 'g'
  });
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  menuItem = await driver.wait(
    until.elementLocated(By.css('#pos-menu [data-id="ml"]')),
    5000
  );
  const addOnItem = await driver.wait(
    until.elementLocated(By.css('#pos-addons [data-id="addon"]')),
    5000
  );
  assert.equal(await addOnItem.isEnabled(), true);
  const noAddOnsButton = await driver.findElement(By.id('pos-no-addons'));
  assert.equal(await noAddOnsButton.getAttribute('aria-pressed'), 'true');
  await addOnItem.click();
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('cart-items')),
    'Add-on'
  ), 5000);
  await noAddOnsButton.click();
  assert.doesNotMatch(await driver.findElement(By.id('cart-items')).getText(), /Add-on/);
  assert.equal(await noAddOnsButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await noAddOnsButton.getText(), 'No add-on');

  await menuItem.click();
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('cart-items')),
    'Matcha Latte'
  ), 5000);
  assert.equal(await driver.findElement(By.id('cart-total')).getText(), '₱ 70');

  await driver.findElement(By.id('cash-received')).sendKeys('100');
  assert.equal(await driver.findElement(By.id('cash-change')).getText(), '₱ 30');
  const recordSaleButton = await driver.findElement(By.css('#pos-form button[type="submit"]'));
  await driver.executeScript('arguments[0].click();', recordSaleButton);
  await driver.wait(until.elementTextIs(
    driver.findElement(By.id('cart-total')),
    '₱ 0'
  ), 5000);

  await driver.findElement(By.linkText('Sales chart')).click();
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('sales-count')),
    '1 sale recorded today'
  ), 5000);
  assert.equal(await driver.findElement(By.id('stat-total')).getText(), '₱ 70');

  await postForm('/menu/recipe/delete', { menuId: 'ml', inventoryId: 'matcha-powder' });
  await postForm('/menu/recipe/delete', { menuId: 'addon', inventoryId: 'ube-powder' });
  await driver.findElement(By.linkText('Log out')).click();
  await driver.wait(until.urlContains('/Login.html'), 5000);
  assert.match(await driver.getTitle(), /Login/);
});

test('owner can upload a product photo and see it on the take-order screen', async () => {
  await driver.get(`${baseUrl}/Login.html`);
  await driver.findElement(By.name('password')).sendKeys('1234');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('/Index.html'), 5000);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.get(`${baseUrl}/Prices.html`);

  const imagePath = path.join(testDirectory, 'product.png');
  await writeFile(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=',
    'base64'
  ));
  const photoForm = await driver.wait(
    until.elementLocated(By.css('.photo-upload[data-menu-id="ml"]')),
    5000
  );
  await photoForm.findElement(By.css('input[type="file"]')).sendKeys(imagePath);
  await photoForm.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.elementTextContains(
    photoForm.findElement(By.css('.photo-upload-status')),
    'Photo uploaded.'
  ), 5000);
  const uploadedPhoto = await driver.findElement(By.css('tr[data-menu-id="ml"] .product-photo')).getAttribute('src');
  const photoPath = new URL(uploadedPhoto).pathname;
  assert.match(photoPath, /^\/product-images\/uploads\/[a-f0-9]{32}\.png$/);

  const db = await getDatabase();
  assert.equal(db.menu.ml.photo, photoPath);
  const imageResponse = await driver.executeAsyncScript((url, done) => {
    fetch(url).then(response => done({ status: response.status, type: response.headers.get('content-type') }))
      .catch(error => done({ error: error.message }));
  }, photoPath);
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.type, /^image\/png/);

  await driver.get(`${baseUrl}/Index.html`);
  const menuPhoto = await driver.wait(
    until.elementLocated(By.css('#pos-menu [data-id="ml"] .product-photo')),
    5000
  );
  assert.match(await menuPhoto.getAttribute('src'), /product-images\/uploads\/[a-f0-9]{32}\.png$/);
  await driver.wait(
    () => driver.executeScript('return arguments[0].complete && arguments[0].naturalWidth > 0;', menuPhoto),
    5000
  );
  const invalidUpload = await driver.executeAsyncScript(done => {
    fetch('/menu/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menuId: 'ml', imageData: 'data:image/png;base64,Zm9v' })
    }).then(response => done({ status: response.status }))
      .catch(error => done({ error: error.message }));
  });
  assert.equal(invalidUpload.status, 400);
});

test('owner can view wastage type in audit log and remove a barista', async () => {
  await driver.get(`${baseUrl}/Login.html`);
  await driver.findElement(By.name('password')).sendKeys('1234');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('/Index.html'), 5000);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);

  await driver.get(`${baseUrl}/Inventory.html`);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.wait(until.elementLocated(By.css('#waste-select option[value="fresh-milk"]')), 5000);
  await driver.findElement(By.id('waste-select')).sendKeys('Fresh milk');
  await driver.findElement(By.name('reason')).sendKeys('Expired');
  const wastageForm = await driver.findElement(By.css('form[action="/inventory/waste"]'));
  await driver.executeScript('arguments[0].click();', await wastageForm.findElement(By.css('button[type="submit"]')));
  await driver.wait(until.stalenessOf(wastageForm), 5000);

  await driver.get(`${baseUrl}/Logs.html`);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  const wastageGroup = await driver.wait(
    until.elementLocated(By.css('summary[aria-label^="Wastage logged"]')),
    5000
  );
  await wastageGroup.click();
  const wastageRow = wastageGroup.findElement(By.xpath('..')).findElement(By.css('table tbody tr'));
  const wastageCells = await wastageRow.findElements(By.css('td'));
  assert.equal(await wastageCells[2].getText(), 'Expired');
  assert.doesNotMatch(await wastageCells[3].getText(), /\(Expired\)$/);

  await driver.get(`${baseUrl}/Settings.html`);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.findElement(By.css('form[action="/register-barista"] input[name="name"]')).sendKeys('Audit Test Barista');
  await driver.findElement(By.css('form[action="/register-barista"] input[name="username"]')).sendKeys('auditbarista');
  const registerBaristaButton = await driver.findElement(By.css('form[action="/register-barista"] button[type="submit"]'));
  await driver.executeScript('arguments[0].click();', registerBaristaButton);
  const baristaRowSelector = '#barista-users tr[data-username="auditbarista"]';
  await driver.wait(until.elementLocated(By.css(baristaRowSelector)), 5000);
  const removeBaristaButton = await driver.findElement(By.css(`${baristaRowSelector} button[type="submit"]`));
  await driver.executeScript('arguments[0].click();', removeBaristaButton);
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('settings-message')),
    'Barista account removed.'
  ), 5000);
  await driver.wait(async () => !(await driver.findElements(By.css(baristaRowSelector))).length, 5000);

  const users = await driver.executeAsyncScript(async done => {
    const response = await fetch('/api/users');
    done(await response.json());
  });
  assert.deepEqual(users.users, []);
});

test('inventory costs update menu prices and unavailable drinks are disabled', async () => {
  await driver.get(`${baseUrl}/logout`);
  await driver.get(`${baseUrl}/Login.html`);
  await driver.findElement(By.name('password')).sendKeys('1234');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('/Index.html'), 5000);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);

  await driver.get(`${baseUrl}/Inventory.html`);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.wait(until.elementLocated(By.id('inventory-table-body')), 5000);
  let db = await getDatabase();
  const initialMilkStock = db.inventory.find(item => item.id === 'fresh-milk').stock;

  const missingCostResult = await postForm('/inventory/restock', {
    id: 'fresh-milk',
    qty: '10'
  });
  assert.match(missingCostResult.url, /Inventory\.html\?error=cost$/);
  db = await getDatabase();
  assert.equal(db.inventory.find(item => item.id === 'fresh-milk').stock, initialMilkStock);

  await postForm('/inventory/restock', {
    id: 'cups',
    qty: '10',
    purchaseCost: '4',
    expiresOn: '2020-01-01'
  });
  await postForm('/inventory/expiry', { id: 'cups', expiresOn: '2020-01-01' });
  await postForm('/inventory/restock', { id: 'fresh-milk', qty: '10', purchaseCost: '100' });
  await postForm('/inventory/restock', { id: 'fresh-milk', qty: '10', purchaseCost: '200' });

  const expiringOn = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  await postForm('/inventory/expiry', { id: 'fresh-milk', expiresOn: expiringOn });
  await postForm('/menu/recipe', {
    menuId: 'ml',
    inventoryId: 'fresh-milk',
    quantity: '0.25',
    unit: 'L'
  });

  db = await getDatabase();
  assert.equal(db.inventory.find(item => item.id === 'cups').expiresOn, null);
  assert.equal(db.inventory.find(item => item.id === 'cups').expirationStatus, 'none');
  assert.equal(db.inventory.find(item => item.id === 'fresh-milk').expirationStatus, 'expiring');
  assert.equal(db.inventory.find(item => item.id === 'matcha-powder').stockStatus, 'critical');
  assert.equal(db.menu.ml.priceAutoCalculated, true);

  const expectedMilkUnitCost = ((initialMilkStock + 10) * 10 + 200) / (initialMilkStock + 20);
  const expectedIngredientCost = 0.4 + expectedMilkUnitCost * 0.25;
  assert.ok(Math.abs(db.inventory.find(item => item.id === 'fresh-milk').unitCost - expectedMilkUnitCost) < 1e-9);
  assert.equal(db.menu.ml.price, Math.ceil(expectedIngredientCost / 0.85 - 1e-9));
  await driver.get(`${baseUrl}/Prices.html`);
  await driver.wait(until.elementLocated(By.css('.system-notice')), 5000);
  await driver.wait(until.elementTextContains(
    driver.findElement(By.css('#prices-body tr[data-menu-id="ml"] td:nth-child(2)')),
    'Auto'
  ), 5000);

  const cupStock = db.inventory.find(item => item.id === 'cups').stock;
  await postForm('/inventory/waste', {
    id: 'cups',
    qty: String(cupStock - 75),
    reason: 'Other'
  });
  await postForm('/inventory/waste', {
    id: 'fresh-milk',
    qty: String(db.inventory.find(item => item.id === 'fresh-milk').stock),
    reason: 'Other'
  });

  db = await getDatabase();
  assert.equal(db.inventory.find(item => item.id === 'cups').stockStatus, 'low');
  assert.equal(db.menu.ml.available, false);
  assert.deepEqual(db.menu.ml.unavailableIngredients, ['Fresh milk']);

  await driver.get(`${baseUrl}/Index.html`);
  const inventoryNotice = await driver.wait(
    until.elementLocated(By.css('.system-notice')),
    5000
  );
  assert.match(await inventoryNotice.getText(), /Cups \(75 pcs\) is low in stock\./);

  const matchaLatte = await driver.wait(until.elementLocated(By.css('#pos-menu [data-id="ml"]')), 5000);
  assert.equal(await matchaLatte.isEnabled(), false);
  assert.match(await matchaLatte.getAttribute('class'), /unavailable/);

  await driver.get(`${baseUrl}/Forecast.html`);
  assert.equal(await driver.findElements(By.xpath("//th[normalize-space()='Month stock runs out']")).then(rows => rows.length), 0);
});
