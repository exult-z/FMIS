const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
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
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('login-error')),
    'Incorrect username or password.'
  ), 5000);

  await driver.findElement(By.name('password')).clear();
  await driver.findElement(By.name('password')).sendKeys('1234');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.urlContains('/Index.html'), 5000);

  const menuItem = await driver.wait(
    until.elementLocated(By.css('#pos-menu [data-id="ml"]')),
    5000
  );
  await menuItem.click();
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('cart-items')),
    'Matcha Latte'
  ), 5000);
  assert.equal(await driver.findElement(By.id('cart-total')).getText(), '₱ 70');

  await driver.findElement(By.id('cash-received')).sendKeys('100');
  assert.equal(await driver.findElement(By.id('cash-change')).getText(), '₱ 30');
  await driver.findElement(By.css('#pos-form button[type="submit"]')).click();
  await driver.wait(until.elementTextIs(
    driver.findElement(By.id('cart-total')),
    '₱ 0'
  ), 5000);

  await driver.findElement(By.linkText('Sales chart')).click();
  await driver.wait(until.elementTextContains(
    driver.findElement(By.id('sales-count')),
    '1 sale recorded today'
  ), 5000);
  assert.equal(await driver.findElement(By.id('stat-total')).getText(), '₱ 70');

  await driver.findElement(By.linkText('Log out')).click();
  await driver.wait(until.urlContains('/Login.html'), 5000);
  assert.match(await driver.getTitle(), /Login/);
});
