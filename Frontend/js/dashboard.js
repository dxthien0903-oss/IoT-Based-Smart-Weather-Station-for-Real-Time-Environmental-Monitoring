// dashboard.js — Logic cho trang Dashboard chính
(function () {
  'use strict';

  const formatTime = (d = new Date()) => {
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
  };

  const chartMeta = {
    temp: { label: 'Nhiệt độ', unit: '°C', color: '#ef9169' },
    hum: { label: 'Độ ẩm', unit: '%', color: '#6fb8d6' },
    light: { label: 'Ánh sáng', unit: 'lux', color: '#edd066' },
    rain: { label: 'Mưa', unit: '', color: '#7fb897' }
  };

  const MAX_HISTORY_POINTS = 72;
  const historyState = { temp: [], hum: [], light: [], rain: [], range: '1h', active: 'temp', compare: false };
  const readingState = { temp: 28.4, hum: 62, light: 540, rain: 0, lastTemp: null, lastHum: null, lastLight: null, lastRain: null };
  const connectionState = { lastDataAt: Date.now(), offlineThresholdMs: 30000 };
  const aiState = { lastCheck: null };
  const $ = (id) => document.getElementById(id);
  const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;

  function startBrowserGeolocation() {
    const locationValue = $('location-value');
    if (!navigator.geolocation) {
      locationValue.textContent = 'Trình duyệt không hỗ trợ định vị';
      return;
    }
    if (!window.isSecureContext) {
      locationValue.textContent = 'Cần HTTPS hoặc localhost';
      return;
    }

    navigator.geolocation.watchPosition(
      ({ coords }) => {
        locationValue.textContent = `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`;
        locationValue.title = `Độ chính xác khoảng ±${Math.round(coords.accuracy)} m`;
      },
      (error) => {
        const messages = {
          1: 'Chưa cấp quyền truy cập vị trí',
          2: 'Không xác định được vị trí',
          3: 'Hết thời gian chờ lấy vị trí'
        };
        locationValue.textContent = messages[error.code] || 'Không thể lấy vị trí';
        locationValue.removeAttribute('title');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );
  }

  function addHistoryPoint(key, value) {
    historyState[key].push(value);
    if (historyState[key].length > MAX_HISTORY_POINTS) {
      historyState[key].shift();
    }
  }

  function setBadge(id, state) {
    const el = $(id);
    if (state === 'pending') {
      el.textContent = 'Đang chờ';
      el.className = 'status-badge pending';
      return;
    }
    el.textContent = state === 'abnormal' ? 'Bất thường' : 'Bình thường';
    el.className = `status-badge ${state}`;
  }

  function setTrend(elementId, current, previous, unit) {
    const el = document.getElementById(elementId);
    if (previous == null || !Number.isFinite(previous)) {
      el.textContent = '—';
      el.className = 'trend';
      return;
    }
    const delta = current - previous;
    if (Math.abs(delta) < 0.05) {
      el.textContent = 'Ổn định so với lần trước';
      el.className = 'trend';
      return;
    }
    const direction = delta > 0 ? 'up' : 'down';
    const sign = delta > 0 ? '+' : '-';
    el.textContent = `${direction === 'up' ? '↑' : '↓'} ${sign}${Math.abs(delta).toFixed(1)}${unit} so với lần trước`;
    el.className = `trend ${direction}`;
  }

  function updateSparkline(svgId, values, color) {
    const svg = document.getElementById(svgId);
    if (!values.length) { svg.innerHTML = ''; return; }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 38 - ((value - min) / range) * 30 - 4;
      return `${x},${y}`;
    }).join(' ');

    svg.innerHTML = `
      <defs>
        <linearGradient id="grad-${svgId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <polyline points="0,38 ${points} 100,38" fill="url(#grad-${svgId})" stroke="none"></polyline>
    `;
  }

  function updateCards(data) {
    $('value-temp').textContent = Number(data.temp).toFixed(1);
    $('value-hum').textContent = Number(data.hum).toFixed(0);
    $('value-light').textContent = Number(data.light).toFixed(0);
    $('value-rain').textContent = data.rain ? 'Có mưa' : 'Khô ráo';
    $('rain-unit').textContent = data.rain ? 'mưa' : 'khô';

    setTrend('trend-temp', data.temp, readingState.lastTemp, '°C');
    setTrend('trend-hum', data.hum, readingState.lastHum, '%');
    setTrend('trend-light', data.light, readingState.lastLight, ' lux');
    $('trend-rain').textContent = data.rain !== readingState.lastRain ? (data.rain ? '↑ có mưa' : '↓ không mưa') : 'Ổn định';
    $('trend-rain').className = 'trend';

    const tempValues = historyState.temp.slice(-12);
    const humValues = historyState.hum.slice(-12);
    const lightValues = historyState.light.slice(-12);
    const tempMin = Math.min(...tempValues);
    const tempMax = Math.max(...tempValues);
    const humMin = Math.min(...humValues);
    const humMax = Math.max(...humValues);
    const lightMin = Math.min(...lightValues);
    const lightMax = Math.max(...lightValues);

    $('range-temp').textContent = Number.isFinite(tempMin) ? `Hôm nay: ${tempMin.toFixed(1)}–${tempMax.toFixed(1)}°C` : 'Hôm nay: --';
    $('range-hum').textContent = Number.isFinite(humMin) ? `Hôm nay: ${humMin.toFixed(0)}–${humMax.toFixed(0)}%` : 'Hôm nay: --';
    $('range-light').textContent = Number.isFinite(lightMin) ? `Hôm nay: ${lightMin.toFixed(0)}–${lightMax.toFixed(0)} lux` : 'Hôm nay: --';
    $('range-rain').textContent = data.rain ? 'Cảm biến: ướt' : 'Cảm biến: khô';

    $('summary-temp').textContent = data.temp > 31 ? 'Nhiệt độ cao, cần kiểm tra tủ nhiệt' : data.temp < 21 ? 'Mát hơn so với mức trung bình' : 'Nhiệt độ ở mức ổn định';
    $('summary-hum').textContent = data.hum > 80 ? 'Độ ẩm cao, nguy cơ ẩm mốc' : data.hum < 35 ? 'Không khí khô, cần bổ sung độ ẩm' : 'Độ ẩm trong ngưỡng cho phép';
    $('summary-light').textContent = data.light > 700 ? 'Ánh sáng mạnh, môi trường khá sáng' : data.light < 150 ? 'Môi trường tối, kiểm tra đèn' : 'Ánh sáng ở mức vừa phải';
    $('summary-rain').textContent = data.rain ? 'Phát hiện bề mặt ẩm, có khả năng mưa' : 'Bề mặt khô, không phát hiện mưa';

    setBadge('badge-temp', data.temp > 35 ? 'abnormal' : 'normal');
    setBadge('badge-hum', data.hum > 82 ? 'abnormal' : 'normal');
    setBadge('badge-light', data.light < 80 ? 'abnormal' : 'normal');
    setBadge('badge-rain', 'normal');

    readingState.lastTemp = data.temp;
    readingState.lastHum = data.hum;
    readingState.lastLight = data.light;
    readingState.lastRain = data.rain;

    updateSparkline('spark-temp', historyState.temp.slice(-20), '#ef9169');
    updateSparkline('spark-hum', historyState.hum.slice(-20), '#6fb8d6');
    updateSparkline('spark-light', historyState.light.slice(-20), '#edd066');
    updateSparkline('spark-rain', historyState.rain.slice(-20), '#7fb897');
  }

  function setAiState() {
    const last = $('last-check');
    if (aiState.lastCheck) {
      last.hidden = false;
      last.textContent = `Lần kiểm tra gần nhất: ${formatTime(aiState.lastCheck)}`;
    } else {
      last.hidden = true;
      last.textContent = '';
    }
  }

  function showAlertList(message) {
    const list = $('alert-list');
    list.innerHTML = `<div class="empty-state">${message}</div>`;
  }

  function addAlert(sensor, value, threshold, message, severity) {
    const list = $('alert-list');
    const empty = list.querySelector('.empty-state');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'alert-item';
    row.innerHTML = `
      <div class="time">${formatTime()}</div>
      <div>
        <div class="message">${message}</div>
        <span class="meta">Cảm biến: ${sensor} · Giá trị: ${value} · Ngưỡng: ${threshold}</span>
      </div>
      <span class="alert-tag">${severity}</span>
    `;
    list.prepend(row);
    while (list.children.length > 5) list.removeChild(list.lastChild);
  }

  function showBanner(text) {
    const banner = $('ai-banner');
    const textNode = $('ai-banner-text');
    if (!text) {
      banner.classList.remove('show');
      textNode.textContent = '';
      return;
    }
    textNode.textContent = text;
    banner.classList.add('show');
    clearTimeout(showBanner.tid);
    showBanner.tid = setTimeout(() => banner.classList.remove('show'), 7000);
  }

  function setConnectionState(state, label) {
    const pill = $('connection-pill');
    pill.classList.remove('warning', 'pending');
    if (state === 'warning') pill.classList.add('warning');
    if (state === 'pending') pill.classList.add('pending');
    $('connection-text').textContent = label;
  }

  function updateConnectionState() {
    const now = Date.now();
    const isOffline = now - connectionState.lastDataAt > connectionState.offlineThresholdMs;
    if (isOffline) {
      setConnectionState('warning', 'Mất kết nối');
    } else {
      setConnectionState('online', 'Đã kết nối');
    }
  }

  function setCompareButton() {
    const compareMap = {
      temp: 'Độ ẩm',
      hum: 'Nhiệt độ',
      light: 'Độ ẩm',
      rain: 'Độ ẩm'
    };
    const compareTarget = compareMap[historyState.active] || 'Độ ẩm';
    const btn = $('compare-btn');
    const text = btn.querySelector('span');
    const isPressed = historyState.compare;
    btn.classList.toggle('active', isPressed);
    btn.setAttribute('aria-pressed', String(isPressed));
    text.textContent = isPressed ? `Tắt so sánh với ${compareTarget}` : `So sánh với ${compareTarget}`;
  }

  const SENSOR_LABEL = { temp: 'Nhiệt độ', hum: 'Độ ẩm', light: 'Ánh sáng' };
  const SENSOR_UNIT = { temp: '°C', hum: '%', light: ' lux' };
  const SEVERITY_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };

  async function loadAlerts() {
    const res = await fetch(`${API_BASE}/api/alerts?limit=20`);
    if (!res.ok) throw new Error('Không lấy được cảnh báo');
    const alerts = await res.json();

    aiState.lastCheck = new Date();
    setAiState();

    const list = $('alert-list');
    list.innerHTML = '';
    if (!alerts.length) showAlertList('Chưa phát hiện bất thường');

    alerts.forEach((a) => {
      const d = new Date(a.created_at);
      const unit = SENSOR_UNIT[a.sensor] || '';
      const row = document.createElement('div');
      row.className = 'alert-item';
      row.innerHTML = `
        <div class="time">${d.getDate()}/${d.getMonth() + 1} ${formatTime(d)}</div>
        <div>
          <div class="message">${a.reason}</div>
          <span class="meta">Cảm biến: ${SENSOR_LABEL[a.sensor] || a.sensor} · Giá trị: ${a.value}${unit} · Kỳ vọng: ${a.expected || '—'}</span>
        </div>
        <span class="alert-tag">${SEVERITY_LABEL[a.severity] || a.severity}</span>
      `;
      list.appendChild(row);
    });

    // Badge trên thẻ chỉ báo "Bất thường" nếu có cảnh báo trong 60 giây gần nhất
    const now = Date.now();
    ['temp', 'hum', 'light'].forEach((k) => {
      const recent = alerts.some((a) => a.sensor === k && now - new Date(a.created_at).getTime() < 60000);
      setBadge(`badge-${k}`, recent ? 'abnormal' : 'normal');
    });
    setBadge('badge-rain', 'normal');

    // Banner chỉ hiện với cảnh báo rất mới (dưới 20 giây)
    const fresh = alerts.find((a) => now - new Date(a.created_at).getTime() < 20000);
    showBanner(fresh ? `${fresh.reason}: ${fresh.value}${SENSOR_UNIT[fresh.sensor] || ''}` : '');
  }

  async function fetchHistory(range) {
    const res = await fetch(`${API_BASE}/api/sensors/history?range=${range}`);
    if (!res.ok) throw new Error('Không lấy được lịch sử');
    const data = await res.json();
    return { labels: data.labels, temp: data.temp, hum: data.hum, light: data.light, rain: data.rain };
  }

  function applyHistory(data) {
    historyState.labels = data.labels;
    historyState.temp = data.temp;
    historyState.hum = data.hum;
    historyState.light = data.light;
    historyState.rain = data.rain;
  }

  function formatLabel(iso, range) {
    const d = new Date(iso);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return range === '7d' ? `${d.getDate()}/${d.getMonth() + 1} ${hm}` : hm;
  }

  async function refreshData() {
    try {
      const res = await fetch(`${API_BASE}/api/sensors/latest`);
      if (res.status === 204) return;
      if (!res.ok) throw new Error('Server lỗi ' + res.status);
      const data = await res.json();

      $('last-updated').textContent = formatTime(new Date(data.timestamp));
      connectionState.lastDataAt = new Date(data.timestamp).getTime();
      readingState.temp = data.temp;
      readingState.hum = data.hum;
      readingState.light = data.light;
      readingState.rain = data.rain;

      if (historyState.range !== '7d') applyHistory(await fetchHistory(historyState.range));

      updateCards(readingState);
      renderChart();
      await loadAlerts();
      updateConnectionState();
    } catch (err) {
      console.error(err);
      setConnectionState('warning', 'Lỗi kết nối server');
    }
  }

  function buildChartLabels(range) {
    const now = new Date();
    const length = range === '1h' ? 24 : range === '6h' ? 28 : range === '24h' ? 36 : 30;
    const labels = [];
    for (let index = length - 1; index >= 0; index -= 1) {
      const d = new Date(now.getTime() - index * 5 * 60 * 1000);
      if (range === '7d') labels.push(`${d.getDate()}/${d.getMonth() + 1}`);
      else labels.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    }
    return labels;
  }

  function renderChart() {
    const canvas = document.getElementById('history-chart');
    if (!canvas.__chart) {
      canvas.__chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: buildChartLabels(historyState.range),
          datasets: [
            { label: 'Nhiệt độ', data: [], borderColor: '#ef9169', backgroundColor: 'rgba(239,145,105,0.15)', borderWidth: 2.5, pointRadius: 0, tension: 0.35, fill: false, yAxisID: 'y' },
            { label: 'Độ ẩm', data: [], borderColor: '#6fb8d6', backgroundColor: 'rgba(111,184,214,0.12)', borderWidth: 2, pointRadius: 0, tension: 0.35, fill: false, yAxisID: 'y1', hidden: true }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: true, labels: { color: '#d3dde4', usePointStyle: true, boxWidth: 10, boxHeight: 10, padding: 16 } },
            tooltip: { callbacks: { label(context) { return `${context.dataset.label}: ${context.parsed.y}${context.dataset.unit || ''}`; } } }
          },
          scales: {
            x: { grid: { color: 'rgba(211,221,228,0.12)' }, ticks: { color: '#d3dde4' }, title: { display: true, text: 'Thời gian', color: '#d3dde4' } },
            y: { position: 'left', grid: { color: 'rgba(211,221,228,0.12)' }, ticks: { color: '#d3dde4' }, title: { display: true, text: 'Nhiệt độ (°C)', color: '#d3dde4' } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#d3dde4' }, title: { display: true, text: 'Độ ẩm (%)', color: '#d3dde4' } }
          }
        }
      });
    }

    const activeKey = historyState.active;
    const compareKey = historyState.compare ? (activeKey === 'temp' ? 'hum' : activeKey === 'hum' ? 'temp' : 'hum') : null;
    const labels = (historyState.labels || []).map((t) => formatLabel(t, historyState.range));
    const chart = canvas.__chart;
    const activeData = historyState[activeKey];
    const comparison = compareKey ? historyState[compareKey] : [];

    chart.data.labels = labels;
    chart.data.datasets[0].label = chartMeta[activeKey].label;
    chart.data.datasets[0].unit = chartMeta[activeKey].unit;
    chart.data.datasets[0].data = activeData;
    chart.data.datasets[0].borderColor = chartMeta[activeKey].color;
    chart.data.datasets[0].backgroundColor = `${chartMeta[activeKey].color}22`;
    chart.data.datasets[0].hidden = false;

    chart.data.datasets[1].label = compareKey ? chartMeta[compareKey].label : 'Độ ẩm';
    chart.data.datasets[1].unit = compareKey ? chartMeta[compareKey].unit : '%';
    chart.data.datasets[1].data = comparison;
    chart.data.datasets[1].borderColor = compareKey ? chartMeta[compareKey].color : '#6fb8d6';
    chart.data.datasets[1].backgroundColor = compareKey ? `${chartMeta[compareKey].color}22` : 'rgba(111,184,214,0.12)';
    chart.data.datasets[1].hidden = !compareKey;

    chart.options.scales.y.title.text = `${chartMeta[activeKey].label} (${chartMeta[activeKey].unit})`;
    chart.options.scales.y1.title.text = compareKey ? `${chartMeta[compareKey].label} (${chartMeta[compareKey].unit})` : 'Độ ẩm (%)';
    chart.options.scales.y1.display = !!compareKey;
    chart.update();
  }

  // ---------- Event listeners ----------
  document.getElementById('refresh-btn').addEventListener('click', () => refreshData());

  document.getElementById('series-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;
    historyState.active = button.dataset.key;
    document.querySelectorAll('.tab-button').forEach((el) => {
      const selected = el === button;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    setCompareButton();
    renderChart();
  });

  document.getElementById('range-tabs').addEventListener('click', async (event) => {
    const button = event.target.closest('.range-button');
    if (!button) return;
    historyState.range = button.dataset.range;
    document.querySelectorAll('.range-button').forEach((el) => el.classList.toggle('active', el === button));
    try {
      const data = await fetchHistory(historyState.range);
      applyHistory(data);
    } catch (err) { console.error(err); }
    renderChart();
  });

  document.getElementById('compare-btn').addEventListener('click', () => {
    historyState.compare = !historyState.compare;
    setCompareButton();
    renderChart();
  });

  // ---------- Initialize ----------
  async function initialize() {
    startBrowserGeolocation();

    try {
      const initial = await fetchHistory('1h');
      applyHistory(initial);
    } catch (err) {
      console.error('Không lấy được lịch sử ban đầu:', err);
    }

    await refreshData();
    setCompareButton();
    setAiState();
  }

  initialize();
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshData();
    }
    updateConnectionState();
  }, 10000);
})();

