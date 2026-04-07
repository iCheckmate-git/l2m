const state = {
  transactions: [],
  summary: null,
  filter: 'all'
};

const transactionForm = document.getElementById('transactionForm');
const typeField = document.getElementById('typeField');
const realAmountField = document.getElementById('realAmountField');
const currencyField = document.getElementById('currencyField');
const tableBody = document.getElementById('transactionTable');
const metricCards = document.getElementById('metricCards');
const insights = document.getElementById('insights');
const filters = document.getElementById('filters');
const chartCanvas = document.getElementById('activityChart');
const metricTemplate = document.getElementById('metricCardTemplate');

const typeLabels = {
  income: 'Приход',
  expense: 'Расход',
  purchase: 'Покупка'
};

transactionForm.addEventListener('submit', handleSubmit);
typeField.addEventListener('change', syncPurchaseFields);
filters.addEventListener('click', handleFilterClick);
window.addEventListener('resize', renderChart);

syncPurchaseFields();
loadDashboard();

async function loadDashboard() {
  try {
    const response = await fetch('/api/transactions');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Не удалось загрузить данные.');
    }

    state.transactions = payload.transactions || [];
    state.summary = payload.summary || null;
    render();
  } catch (error) {
    tableBody.innerHTML = `<tr><td colspan="6" class="empty-state">${error.message}</td></tr>`;
  }
}

function render() {
  renderMetrics();
  renderTable();
  renderInsights();
  renderChart();
}

function renderMetrics() {
  const totals = state.summary?.totals;
  if (!totals) {
    metricCards.innerHTML = '';
    return;
  }

  const cards = [
    {
      label: 'Текущий баланс',
      value: formatCrystals(totals.balance),
      hint: 'Кристаллы в распоряжении персонажа'
    },
    {
      label: 'Чистый приход',
      value: formatCrystals(totals.totalIncome),
      hint: 'Без учета покупок за реальные деньги'
    },
    {
      label: 'Куплено',
      value: formatCrystals(totals.totalPurchased),
      hint: `${formatMoney(totals.realSpent, totals.primaryCurrency)} инвестировано`
    },
    {
      label: 'Расход',
      value: formatCrystals(totals.totalExpense),
      hint: `${totals.transactionCount} операций в журнале`
    }
  ];

  metricCards.innerHTML = '';
  for (const item of cards) {
    const fragment = metricTemplate.content.cloneNode(true);
    fragment.querySelector('.metric-card__label').textContent = item.label;
    fragment.querySelector('.metric-card__value').textContent = item.value;
    fragment.querySelector('.metric-card__hint').textContent = item.hint;
    metricCards.appendChild(fragment);
  }
}

function renderTable() {
  const filtered = state.transactions.filter((item) => {
    return state.filter === 'all' ? true : item.type === state.filter;
  });

  if (!filtered.length) {
    tableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Записей по этому фильтру пока нет.</td></tr>';
    return;
  }

  tableBody.innerHTML = filtered.map((item) => {
    const moneyContent = item.type === 'purchase'
      ? `<span class="money-pill">${formatMoney(item.realAmount, item.realCurrency)}</span>`
      : '<span class="money-pill">-</span>';

    return `
      <tr class="ledger-row">
        <td data-label="Дата">
          <strong>${formatDate(item.createdAt)}</strong>
          <div class="table-note">${escapeHtml(item.notes || 'Без комментария')}</div>
        </td>
        <td data-label="Тип"><span class="type-badge type-badge--${item.type}">${typeLabels[item.type]}</span></td>
        <td data-label="Операция" class="ledger-title-cell">${escapeHtml(item.title)}</td>
        <td data-label="Кристаллы"><span class="crystal-pill">${formatCrystals(item.crystals)}</span></td>
        <td data-label="Реал">${moneyContent}</td>
        <td data-label="Действие" class="ledger-action-cell">
          <button class="delete-button" data-id="${item.id}" title="Удалить запись">x</button>
        </td>
      </tr>
    `;
  }).join('');

  for (const button of tableBody.querySelectorAll('.delete-button')) {
    button.addEventListener('click', () => deleteTransaction(button.dataset.id));
  }
}

function renderInsights() {
  const totals = state.summary?.totals;
  const lastTransaction = state.summary?.lastTransaction;

  if (!totals) {
    insights.innerHTML = '';
    return;
  }

  const cards = [
    {
      label: 'Средний расход за операцию',
      value: formatCrystals(Math.round(totals.totalExpense / Math.max(countByType('expense'), 1)))
    },
    {
      label: 'Средняя покупка за реал',
      value: `${formatCrystals(Math.round(totals.totalPurchased / Math.max(countByType('purchase'), 1)))} / ${formatMoney(totals.realSpent / Math.max(countByType('purchase'), 1), totals.primaryCurrency)}`
    },
    {
      label: 'Последнее движение',
      value: lastTransaction
        ? `${typeLabels[lastTransaction.type]}: ${escapeHtml(lastTransaction.title)}`
        : 'Нет данных'
    }
  ];

  insights.innerHTML = cards.map((item) => {
    return `
      <article class="insight-card">
        <p class="insight-card__label">${item.label}</p>
        <span class="insight-card__value">${item.value}</span>
      </article>
    `;
  }).join('');
}

async function handleSubmit(event) {
  event.preventDefault();

  const formData = new FormData(transactionForm);
  const payload = Object.fromEntries(formData.entries());

  if (payload.createdAt) {
    payload.createdAt = new Date(payload.createdAt).toISOString();
  }

  if (payload.type !== 'purchase') {
    payload.realAmount = 0;
    payload.realCurrency = 'USD';
  }

  try {
    const response = await fetch('/api/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Не удалось сохранить запись.');
    }

    transactionForm.reset();
    typeField.value = 'income';
    syncPurchaseFields();
    await loadDashboard();
  } catch (error) {
    window.alert(error.message);
  }
}

async function deleteTransaction(id) {
  if (!window.confirm('Удалить эту запись из журнала?')) {
    return;
  }

  try {
    const response = await fetch(`/api/transactions/${id}`, {
      method: 'DELETE'
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Не удалось удалить запись.');
    }

    await loadDashboard();
  } catch (error) {
    window.alert(error.message);
  }
}

function handleFilterClick(event) {
  const button = event.target.closest('[data-filter]');
  if (!button) {
    return;
  }

  state.filter = button.dataset.filter;
  for (const chip of filters.querySelectorAll('.filter-chip')) {
    chip.classList.toggle('is-active', chip === button);
  }
  renderTable();
}

function syncPurchaseFields() {
  const isPurchase = typeField.value === 'purchase';
  realAmountField.classList.toggle('is-hidden', !isPurchase);
  currencyField.classList.toggle('is-hidden', !isPurchase);
}

function countByType(type) {
  return state.transactions.filter((item) => item.type === type).length;
}

function renderChart() {
  const chartData = state.summary?.chart || [];
  if (!chartData.length) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const chartBox = chartCanvas.parentElement;
  const width = chartBox.clientWidth * dpr;
  const height = chartBox.clientHeight * dpr;
  if (!width || !height) {
    return;
  }

  chartCanvas.width = width;
  chartCanvas.height = height;
  const ctx = chartCanvas.getContext('2d');
  const padding = {
    top: (window.innerWidth < 560 ? 24 : 32) * dpr,
    right: (window.innerWidth < 560 ? 14 : 28) * dpr,
    bottom: (window.innerWidth < 560 ? 42 : 48) * dpr,
    left: (window.innerWidth < 560 ? 22 : 36) * dpr
  };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...chartData.flatMap((item) => [item.income + item.purchase, item.expense, item.balance]), 1);
  const maxBalance = Math.max(...chartData.map((item) => item.balance), 1);
  const minBalance = Math.min(...chartData.map((item) => item.balance), 0);
  const balanceRange = Math.max(maxBalance - minBalance, 1);

  let frame = 0;
  const frames = 42;

  cancelAnimationFrame(renderChart.rafId);
  const animate = () => {
    frame += 1;
    const progress = easeOutCubic(Math.min(frame / frames, 1));

    ctx.clearRect(0, 0, width, height);
    drawChartGrid(ctx, width, height, padding, chartHeight, chartWidth, dpr);

    const step = chartWidth / chartData.length;
    const barWidth = step * 0.28;

    chartData.forEach((item, index) => {
      const x = padding.left + step * index + step * 0.18;
      const incomeHeight = ((item.income + item.purchase) / maxValue) * chartHeight * progress;
      const expenseHeight = (item.expense / maxValue) * chartHeight * progress;

      drawBar(ctx, x, padding.top + chartHeight - incomeHeight, barWidth, incomeHeight, ['#5ee7ff', '#5af0bf']);
      drawBar(ctx, x + barWidth + step * 0.1, padding.top + chartHeight - expenseHeight, barWidth, expenseHeight, ['#ff9aac', '#ff5b66']);

      ctx.fillStyle = 'rgba(151, 166, 193, 0.8)';
      ctx.font = `${(window.innerWidth < 560 ? 10 : 12) * dpr}px Manrope`;
      ctx.textAlign = 'center';
      ctx.fillText(item.label, x + barWidth, padding.top + chartHeight + 26 * dpr);
    });

    const linePoints = chartData.map((item, index) => {
      const x = padding.left + step * index + step * 0.5;
      const normalized = (item.balance - minBalance) / balanceRange;
      const y = padding.top + chartHeight - normalized * chartHeight * progress;
      return { x, y };
    });

    ctx.save();
    const areaGradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
    areaGradient.addColorStop(0, 'rgba(255, 179, 87, 0.24)');
    areaGradient.addColorStop(1, 'rgba(255, 179, 87, 0)');
    traceSmoothPath(ctx, linePoints);
    const lastPoint = linePoints.at(-1);
    const firstPoint = linePoints[0];
    if (lastPoint && firstPoint) {
      ctx.lineTo(lastPoint.x, padding.top + chartHeight);
      ctx.lineTo(firstPoint.x, padding.top + chartHeight);
    }
    ctx.closePath();
    ctx.fillStyle = areaGradient;
    ctx.fill();
    ctx.restore();

    traceSmoothPath(ctx, linePoints);
    ctx.strokeStyle = '#ffb357';
    ctx.lineWidth = 3 * dpr;
    ctx.shadowColor = 'rgba(255, 179, 87, 0.5)';
    ctx.shadowBlur = 16 * dpr;
    ctx.stroke();
    ctx.shadowBlur = 0;

    linePoints.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, (window.innerWidth < 560 ? 3.5 : 5) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe2b4';
      ctx.fill();
      ctx.strokeStyle = '#ffb357';
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    });

    if (progress < 1) {
      renderChart.rafId = requestAnimationFrame(animate);
    }
  };

  animate();
}

function traceSmoothPath(ctx, points) {
  if (!points.length) {
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const controlX = (current.x + next.x) / 2;
    ctx.quadraticCurveTo(current.x, current.y, controlX, (current.y + next.y) / 2);
  }

  const lastPoint = points.at(-1);
  if (lastPoint) {
    ctx.lineTo(lastPoint.x, lastPoint.y);
  }
}

function drawChartGrid(ctx, width, height, padding, chartHeight, chartWidth, dpr) {
  const compact = window.innerWidth < 560;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;

  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (chartHeight / 4) * index;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  ctx.fillStyle = 'rgba(151, 166, 193, 0.62)';
  ctx.font = `${(compact ? 10 : 12) * dpr}px Manrope`;
  ctx.fillText('7 дней', width - padding.right - (compact ? 38 : 46) * dpr, padding.top - 10 * dpr);
  ctx.fillText('CR', padding.left, padding.top - 10 * dpr);
  ctx.fillText('Баланс', padding.left + chartWidth - (compact ? 34 : 44) * dpr, padding.top - 10 * dpr);
}

function drawBar(ctx, x, y, width, height, colors) {
  const radius = Math.min(width / 2, 14);
  const gradient = ctx.createLinearGradient(x, y, x, y + height);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();
  ctx.fill();
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function formatCrystals(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} CR`;
}

function formatMoney(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  } catch {
    return `${Number(value || 0).toFixed(2)} ${currency}`;
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
