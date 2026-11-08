const formatQuantity = value => {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
};

function formatForecastDate(value) {
  if (!value) return '—';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function runOutMonth(value, currentYear) {
  if (!value) return '—';
  const [year, month] = value.split('-').map(Number);
  if (year > currentYear) return `After ${currentYear}`;
  if (year < currentYear) return 'Already passed';
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    timeZone: 'UTC'
  });
}

function renderInventoryForecast(forecast) {
  const body = document.getElementById('forecast-inventory');
  body.replaceChildren();
  if (!forecast.inventory.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.textContent = 'No inventory items to forecast.';
    return;
  }

  const year = Number(forecast.date.slice(0, 4));
  for (const item of forecast.inventory) {
    const row = body.insertRow();
    const values = [
      item.name,
      `${formatQuantity(item.stock)} ${item.unit || ''}`.trim(),
      item.averageDailyUse === null ? '—' : `${formatQuantity(item.averageDailyUse)} ${item.unit || ''}`.trim(),
      item.status === 'out' ? 'Out of stock' : item.status === 'forecast' ? `Around ${formatForecastDate(item.runOutDate)}` : ({
        'no-history': 'Not enough tracked sales',
        'unit-mismatch': 'Cannot estimate: units changed',
        'no-demand': 'No recorded use'
      }[item.status] || 'Unavailable')
    ];
    for (const value of values) row.insertCell().textContent = value;
    row.insertCell().textContent = item.status === 'out'
      ? 'Already out'
      : item.status === 'forecast'
        ? runOutMonth(item.runOutDate, year)
        : '—';
  }
}

function renderBestseller(period, forecast) {
  const leader = document.getElementById(`forecast-${period}`);
  const runners = document.getElementById(`forecast-${period}-runners`);
  const prediction = forecast.bestsellers[period];
  document.getElementById(`forecast-${period}-window`).textContent =
    `${formatForecastDate(prediction.startDate)} – ${formatForecastDate(prediction.endDate)} · ${prediction.remainingDays} day(s) remaining`;
  if (!prediction.leaders.length) {
    leader.textContent = 'Not enough sales data';
    runners.textContent = 'Record cup sales to create a prediction.';
    return;
  }

  const top = prediction.leaders[0];
  leader.textContent = `${top.name} · ~${formatQuantity(top.projectedTotal)} cups`;
  runners.textContent = prediction.leaders
    .slice(1)
    .map(item => `${item.name}: ~${formatQuantity(item.projectedTotal)} cups`)
    .join(' · ');
}

async function loadForecast() {
  const error = document.getElementById('forecast-error');
  try {
    const response = await fetch('/api/forecast?t=' + Date.now());
    if (!response.ok) throw new Error(`Forecast request failed (${response.status}).`);
    const forecast = await response.json();
    renderInventoryForecast(forecast);
    renderBestseller('week', forecast);
    renderBestseller('month', forecast);
  } catch (requestError) {
    error.textContent = requestError.message || 'Unable to load the forecast.';
    error.hidden = false;
  }
}

loadForecast();