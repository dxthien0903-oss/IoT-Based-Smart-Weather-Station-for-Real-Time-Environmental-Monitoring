// dashboard.js — Logic cho trang Dashboard chính (production-ready)
(function () {
  'use strict';

  var formatTime = function (d) {
    d = d || new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (v) { return String(v).padStart(2, '0'); }).join(':');
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var chartMeta = {
    temp: { label: 'Nhiệt độ', unit: '°C', color: '#ef9169' },
    hum: { label: 'Độ ẩm', unit: '%', color: '#6fb8d6' },
    light: { label: 'Ánh sáng', unit: 'lux', color: '#edd066' },
    rain: { label: 'Mưa', unit: '', color: '#7fb897' }
  };

  var historyState = { temp: [], hum: [], light: [], rain: [], labels: [], range: '1h', active: 'temp', compare: false };
  var readingState = { temp: null, hum: null, light: null, rain: null, lastTemp: null, lastHum: null, lastLight: null, lastRain: null };
  var connectionState = { lastDataAt: 0, hasData: false, offlineThresholdMs: 30000 };
  var pageLoadedAt = Date.now();
  var aiState = { lastCheck: null };
  function $(id) { return document.getElementById(id); }
  var API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;

  function startBrowserGeolocation() {
    var locationValue = $('location-value');
    if (!navigator.geolocation) {
      locationValue.textContent = 'Trình duyệt không hỗ trợ định vị';
      return;
    }
    if (!window.isSecureContext) {
      locationValue.textContent = 'Cần HTTPS hoặc localhost';
      return;
    }
    navigator.geolocation.watchPosition(
      function (pos) {
        var c = pos.coords;
        locationValue.textContent = c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
        locationValue.title = 'Độ chính xác khoảng ±' + Math.round(c.accuracy) + ' m';
      },
      function (error) {
        var messages = { 1: 'Chưa cấp quyền truy cập vị trí', 2: 'Không xác định được vị trí', 3: 'Hết thời gian chờ lấy vị trí' };
        locationValue.textContent = messages[error.code] || 'Không thể lấy vị trí';
        locationValue.removeAttribute('title');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );
  }

  function setBadge(id, state) {
    var el = $(id);
    if (!el) return;
    if (state === 'pending') {
      el.textContent = 'Đang chờ';
      el.className = 'status-badge pending';
      return;
    }
    el.textContent = state === 'abnormal' ? 'Bất thường' : 'Bình thường';
    el.className = 'status-badge ' + state;
  }

  function setTrend(elementId, current, previous, unit) {
    var el = document.getElementById(elementId);
    if (previous == null || !Number.isFinite(previous) || current == null || !Number.isFinite(current)) {
      el.textContent = '—';
      el.className = 'trend';
      return;
    }
    var delta = current - previous;
    if (Math.abs(delta) < 0.05) {
      el.textContent = 'Ổn định so với lần trước';
      el.className = 'trend';
      return;
    }
    var direction = delta > 0 ? 'up' : 'down';
    var sign = delta > 0 ? '+' : '-';
    el.textContent = (direction === 'up' ? '↑' : '↓') + ' ' + sign + Math.abs(delta).toFixed(1) + unit + ' so với lần trước';
    el.className = 'trend ' + direction;
  }

  function updateSparkline(svgId, values, color) {
    var svg = document.getElementById(svgId);
    if (!svg) return;
    if (!values.length) { svg.innerHTML = ''; return; }
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = max - min || 1;
    var points = values.map(function (value, index) {
      var x = (index / Math.max(values.length - 1, 1)) * 100;
      var y = 38 - ((value - min) / range) * 30 - 4;
      return x + ',' + y;
    }).join(' ');

    svg.innerHTML =
      '<defs><linearGradient id="grad-' + svgId + '" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.35"></stop>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.02"></stop>' +
      '</linearGradient></defs>' +
      '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      '<polyline points="0,38 ' + points + ' 100,38" fill="url(#grad-' + svgId + ')" stroke="none"></polyline>';
  }

  function updateDeviceMeta(data) {
    if (data.device_id) $('device-id').textContent = data.device_id;
    if (typeof data.rssi === 'number') {
      $('rssi').textContent = data.rssi + ' dBm';
      var bars = document.querySelector('.quality-bars');
      if (bars) {
        bars.className = 'quality-bars ' + (data.rssi >= -60 ? 'good' : data.rssi >= -75 ? 'weak' : 'weak');
        bars.style.opacity = data.rssi < -85 ? '0.5' : '1';
      }
    } else {
      $('rssi').textContent = '--';
    }
  }

  function tickUptime() {
    var s = Math.floor((Date.now() - pageLoadedAt) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    $('uptime').textContent = h + 'h ' + String(m).padStart(2, '0') + 'm';
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
    var rainTrend = $('trend-rain');
    if (readingState.lastRain == null) { rainTrend.textContent = '—'; }
    else if (data.rain !== readingState.lastRain) { rainTrend.textContent = data.rain ? '↑ có mưa' : '↓ không mưa'; }
    else { rainTrend.textContent = 'Ổn định'; }
    rainTrend.className = 'trend';

    var tempValues = historyState.temp.slice(-12);
    var humValues = historyState.hum.slice(-12);
    var lightValues = historyState.light.slice(-12);
    function minMax(arr, digits, suffix, prefix) {
      if (!arr.length) return prefix + ': --';
      var mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr);
      return prefix + ': ' + mn.toFixed(digits) + '–' + mx.toFixed(digits) + suffix;
    }
    $('range-temp').textContent = minMax(tempValues, 1, '°C', 'Hôm nay');
    $('range-hum').textContent = minMax(humValues, 0, '%', 'Hôm nay');
    $('range-light').textContent = minMax(lightValues, 0, ' lux', 'Hôm nay');
    $('range-rain').textContent = data.rain ? 'Cảm biến: ướt' : 'Cảm biến: khô';

    $('summary-temp').textContent = data.temp > 31 ? 'Nhiệt độ cao, cần kiểm tra tủ nhiệt' : data.temp < 21 ? 'Mát hơn so với mức trung bình' : 'Nhiệt độ ở mức ổn định';
    $('summary-hum').textContent = data.hum > 80 ? 'Độ ẩm cao, nguy cơ ẩm mốc' : data.hum < 35 ? 'Không khí khô, cần bổ sung độ ẩm' : 'Độ ẩm trong ngưỡng cho phép';
    $('summary-light').textContent = data.light > 700 ? 'Ánh sáng mạnh, môi trường khá sáng' : data.light < 150 ? 'Môi trường tối, kiểm tra đèn' : 'Ánh sáng ở mức vừa phải';
    $('summary-rain').textContent = data.rain ? 'Phát hiện bề mặt ẩm, có khả năng mưa' : 'Bề mặt khô, không phát hiện mưa';

    // Badge mặc định: normal — loadAlerts() sẽ nâng lên abnormal nếu có cảnh báo < 60s
    setBadge('badge-temp', 'normal');
    setBadge('badge-hum', 'normal');
    setBadge('badge-light', 'normal');
    setBadge('badge-rain', 'normal');

    updateDeviceMeta(data);

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
    var last = $('last-check');
    if (aiState.lastCheck) {
      last.hidden = false;
      last.textContent = 'Lần kiểm tra gần nhất: ' + formatTime(aiState.lastCheck);
    } else {
      last.hidden = true;
      last.textContent = '';
    }
  }

  function showAlertList(message) {
    var list = $('alert-list');
    list.innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
  }

  function showBanner(text) {
    var banner = $('ai-banner');
    var textNode = $('ai-banner-text');
    if (!text) {
      banner.classList.remove('show');
      textNode.textContent = '';
      return;
    }
    textNode.textContent = text;
    banner.classList.add('show');
    clearTimeout(showBanner.tid);
    showBanner.tid = setTimeout(function () { banner.classList.remove('show'); }, 7000);
  }

  function setConnectionState(state, label) {
    var pill = $('connection-pill');
    pill.classList.remove('warning', 'pending');
    if (state === 'warning') pill.classList.add('warning');
    if (state === 'pending') pill.classList.add('pending');
    $('connection-text').textContent = label;
  }

  function updateConnectionState() {
    if (!connectionState.hasData) {
      setConnectionState('pending', 'Đang chờ dữ liệu');
      return;
    }
    var isOffline = Date.now() - connectionState.lastDataAt > connectionState.offlineThresholdMs;
    if (isOffline) setConnectionState('warning', 'Mất kết nối');
    else setConnectionState('online', 'Đã kết nối');
  }

  function setCompareButton() {
    var compareMap = { temp: 'Độ ẩm', hum: 'Nhiệt độ', light: 'Độ ẩm', rain: 'Độ ẩm' };
    var compareTarget = compareMap[historyState.active] || 'Độ ẩm';
    var btn = $('compare-btn');
    var text = btn.querySelector('span');
    var isPressed = historyState.compare;
    btn.classList.toggle('active', isPressed);
    btn.setAttribute('aria-pressed', String(isPressed));
    text.textContent = isPressed ? 'Tắt so sánh với ' + compareTarget : 'So sánh với ' + compareTarget;
  }

  var SENSOR_LABEL = { temp: 'Nhiệt độ', hum: 'Độ ẩm', light: 'Ánh sáng' };
  var SENSOR_UNIT = { temp: '°C', hum: '%', light: ' lux' };
  var SEVERITY_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };

  function loadAlerts() {
    return fetch(API_BASE + '/api/alerts?limit=20').then(function (res) {
      if (!res.ok) throw new Error('Không lấy được cảnh báo');
      return res.json();
    }).then(function (alerts) {
      aiState.lastCheck = new Date();
      setAiState();

      var list = $('alert-list');
      list.innerHTML = '';
      if (!alerts.length) showAlertList('Chưa phát hiện bất thường');

      alerts.forEach(function (a) {
        var d = new Date(a.created_at);
        var unit = SENSOR_UNIT[a.sensor] || '';
        var row = document.createElement('div');
        row.className = 'alert-item';
        var timeDiv = document.createElement('div');
        timeDiv.className = 'time';
        timeDiv.textContent = d.getDate() + '/' + (d.getMonth() + 1) + ' ' + formatTime(d);
        var bodyDiv = document.createElement('div');
        var msgDiv = document.createElement('div');
        msgDiv.className = 'message';
        msgDiv.textContent = a.reason;
        var metaSpan = document.createElement('span');
        metaSpan.className = 'meta';
        metaSpan.textContent = 'Cảm biến: ' + (SENSOR_LABEL[a.sensor] || a.sensor) + ' · Giá trị: ' + a.value + unit + ' · Kỳ vọng: ' + (a.expected || '—');
        bodyDiv.appendChild(msgDiv);
        bodyDiv.appendChild(metaSpan);
        var tag = document.createElement('span');
        tag.className = 'alert-tag';
        tag.textContent = SEVERITY_LABEL[a.severity] || a.severity;
        row.appendChild(timeDiv);
        row.appendChild(bodyDiv);
        row.appendChild(tag);
        list.appendChild(row);
      });

      var now = Date.now();
      ['temp', 'hum', 'light'].forEach(function (k) {
        var recent = alerts.some(function (a) { return a.sensor === k && now - new Date(a.created_at).getTime() < 60000; });
        setBadge('badge-' + k, recent ? 'abnormal' : 'normal');
      });
      setBadge('badge-rain', 'normal');

      var fresh = null;
      for (var i = 0; i < alerts.length; i++) {
        if (now - new Date(alerts[i].created_at).getTime() < 20000) { fresh = alerts[i]; break; }
      }
      showBanner(fresh ? fresh.reason + ': ' + fresh.value + (SENSOR_UNIT[fresh.sensor] || '') : '');
    });
  }

  function fetchHistory(range) {
    return fetch(API_BASE + '/api/sensors/history?range=' + encodeURIComponent(range)).then(function (res) {
      if (!res.ok) throw new Error('Không lấy được lịch sử');
      return res.json();
    }).then(function (data) {
      return { labels: data.labels || [], temp: data.temp || [], hum: data.hum || [], light: data.light || [], rain: data.rain || [] };
    });
  }

  function applyHistory(data) {
    historyState.labels = data.labels;
    historyState.temp = data.temp;
    historyState.hum = data.hum;
    historyState.light = data.light;
    historyState.rain = data.rain;
  }

  function formatLabel(iso, range) {
    var d = new Date(iso);
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return range === '7d' ? d.getDate() + '/' + (d.getMonth() + 1) + ' ' + hm : hm;
  }

  var refreshing = false;
  function refreshData() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return fetch(API_BASE + '/api/sensors/latest').then(function (res) {
      if (res.status === 204) { updateConnectionState(); return; }
      if (!res.ok) throw new Error('Server lỗi ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return;
      $('last-updated').textContent = formatTime(new Date(data.timestamp));
      connectionState.lastDataAt = new Date(data.timestamp).getTime();
      connectionState.hasData = true;
      readingState.temp = data.temp;
      readingState.hum = data.hum;
      readingState.light = data.light;
      readingState.rain = data.rain;
      return fetchHistory(historyState.range).then(function (h) {
        applyHistory(h);
        updateCards(readingState);
        renderChart();
        return loadAlerts().catch(function (e) { console.error(e); });
      }).then(updateConnectionState);
    }).catch(function (err) {
      console.error(err);
      setConnectionState('warning', 'Lỗi kết nối server');
    }).then(function () { refreshing = false; });
  }

  function renderChart() {
    if (typeof Chart === 'undefined') return; // CDN chưa tải — bỏ qua, tránh crash
    var canvas = document.getElementById('history-chart');
    if (!canvas.__chart) {
      canvas.__chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: [],
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
            tooltip: { callbacks: { label: function (context) { return context.dataset.label + ': ' + context.parsed.y + (context.dataset.unit || ''); } } }
          },
          scales: {
            x: { grid: { color: 'rgba(211,221,228,0.12)' }, ticks: { color: '#d3dde4', maxTicksLimit: 10 }, title: { display: true, text: 'Thời gian', color: '#d3dde4' } },
            y: { position: 'left', grid: { color: 'rgba(211,221,228,0.12)' }, ticks: { color: '#d3dde4' }, title: { display: true, text: 'Nhiệt độ (°C)', color: '#d3dde4' } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#d3dde4' }, title: { display: true, text: 'Độ ẩm (%)', color: '#d3dde4' } }
          }
        }
      });
    }

    var activeKey = historyState.active;
    var compareKey = historyState.compare ? (activeKey === 'temp' ? 'hum' : activeKey === 'hum' ? 'temp' : 'hum') : null;
    var labels = (historyState.labels || []).map(function (t) { return formatLabel(t, historyState.range); });
    var chart = canvas.__chart;
    var activeData = historyState[activeKey] || [];
    var comparison = compareKey ? historyState[compareKey] : [];

    chart.data.labels = labels;
    chart.data.datasets[0].label = chartMeta[activeKey].label;
    chart.data.datasets[0].unit = chartMeta[activeKey].unit;
    chart.data.datasets[0].data = activeData;
    chart.data.datasets[0].borderColor = chartMeta[activeKey].color;
    chart.data.datasets[0].backgroundColor = chartMeta[activeKey].color + '22';
    chart.data.datasets[0].hidden = false;

    chart.data.datasets[1].label = compareKey ? chartMeta[compareKey].label : 'Độ ẩm';
    chart.data.datasets[1].unit = compareKey ? chartMeta[compareKey].unit : '%';
    chart.data.datasets[1].data = comparison;
    chart.data.datasets[1].borderColor = compareKey ? chartMeta[compareKey].color : '#6fb8d6';
    chart.data.datasets[1].backgroundColor = compareKey ? chartMeta[compareKey].color + '22' : 'rgba(111,184,214,0.12)';
    chart.data.datasets[1].hidden = !compareKey;

    chart.options.scales.y.title.text = chartMeta[activeKey].label + ' (' + chartMeta[activeKey].unit + ')';
    chart.options.scales.y1.title.text = compareKey ? chartMeta[compareKey].label + ' (' + chartMeta[compareKey].unit + ')' : 'Độ ẩm (%)';
    chart.options.scales.y1.display = !!compareKey;
    chart.update();
  }

  // ---------- Event listeners ----------
  document.getElementById('refresh-btn').addEventListener('click', function () { refreshData(); });

  document.getElementById('series-tabs').addEventListener('click', function (event) {
    var button = event.target.closest('.tab-button');
    if (!button) return;
    historyState.active = button.dataset.key;
    document.querySelectorAll('.tab-button').forEach(function (el) {
      var selected = el === button;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    setCompareButton();
    renderChart();
  });

  document.getElementById('range-tabs').addEventListener('click', function (event) {
    var button = event.target.closest('.range-button');
    if (!button) return;
    historyState.range = button.dataset.range;
    document.querySelectorAll('.range-button').forEach(function (el) { el.classList.toggle('active', el === button); });
    fetchHistory(historyState.range).then(applyHistory).catch(function (err) { console.error(err); }).then(renderChart);
  });

  document.getElementById('compare-btn').addEventListener('click', function () {
    historyState.compare = !historyState.compare;
    setCompareButton();
    renderChart();
  });

  // ---------- Initialize ----------
  function initialize() {
    startBrowserGeolocation();
    tickUptime();
    setInterval(tickUptime, 30000);
    setConnectionState('pending', 'Đang chờ dữ liệu');
    fetchHistory('1h').then(applyHistory).catch(function (err) {
      console.error('Không lấy được lịch sử ban đầu:', err);
    }).then(refreshData).then(function () {
      setCompareButton();
      setAiState();
    });
  }

  initialize();
  setInterval(function () {
    if (document.visibilityState === 'visible') {
      refreshData();
    } else {
      updateConnectionState();
    }
  }, 10000);
})();
