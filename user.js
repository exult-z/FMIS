(async () => {
  const response = await fetch('/api/me');
  if (!response.ok) return;
  const user = await response.json();
  document.body.dataset.role = user.role;
  document.querySelectorAll('.who').forEach(element => {
    element.textContent = `${user.name} · ${user.role === 'owner' ? 'Owner' : 'Barista'}`;
  });

  if (user.role !== 'owner') return;
  const dbResponse = await fetch('/api/db');
  if (!dbResponse.ok) throw new Error('Unable to load inventory alerts.');
  const { inventory, expiryAlerts } = await dbResponse.json();
  const stockAlerts = inventory.filter(item => ['low', 'critical'].includes(item.stockStatus));
  if (!stockAlerts.length && !expiryAlerts.length) return;

  const notice = document.createElement('section');
  notice.className = 'system-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const heading = document.createElement('strong');
  heading.textContent = 'Inventory attention notice';
  notice.append(heading);

  const list = document.createElement('ul');
  for (const item of stockAlerts) {
    const row = document.createElement('li');
    const status = item.stockStatus === 'critical' ? 'critically low' : 'low';
    row.textContent = `${item.name} (${item.stock} ${item.unit}) is ${status} in stock.`;
    list.append(row);
  }

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  for (const item of expiryAlerts) {
    const row = document.createElement('li');
    const expired = item.expiresOn < todayKey;
    row.textContent = `${item.name} (${item.stock} ${item.unit}) ${
      expired ? 'expired on' : 'expires on'
    } ${item.expiresOn}.`;
    list.append(row);
  }
  notice.append(list);

  const inventoryLink = document.createElement('a');
  inventoryLink.href = '/Inventory.html';
  inventoryLink.textContent = 'Review inventory';
  notice.append(inventoryLink);
  document.querySelector('main')?.before(notice);
})();
