// dashboard.js — Dashboard logic for the IoT Weather Station
(function () {
  'use strict';

  var REFRESH_MS = 10000;
  var OFFLINE_THRESHOLD_MS = 30000;
  var SPARK_POINTS = 12;       // points shown in each card sparkline
  var TREND_WINDOW = 12;       // readings used for min/max + trend delta

  var SENSOR_META = {
    temp:  { label: 'Nhiệt độ', unit: '°C',  color: '#fb923c', dim: 'rgba(251,146,60,0.13)',  decimals: 1 },
    hum:   { label: 'Độ ẩm',    unit: '%',   color: '#60a5fa', dim: 'rgba(96,165,250,0.13)',  decimals: 0 },
    light: { label: 'Ánh sáng', unit: 'lux', color: '#facc15', dim: 'rgba(250,204,21,0.13)',  decimals: 0 },
    rain:  { label: 'Mưa',       unit: '',    color: '#22d3ee', dim: 'rgba(34,211,238,0.13)',  decimals: 0 }
  };

  var RANGE_LABEL = { '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ', '7d': '7 ngày' };

  var SENSOR_LABEL = { temp: 'Nhiệt độ', hum: 'Độ ẩm', light: 'Ánh sáng' };
  var SEVERITY_LABEL = { high: 'Nghiêm trọng', medium: 'Trung bình', low: 'Thấp' };

  var history = { temp: [], hum: [], light: [], rain: [], labels: [], range: '1h', active: 'temp', compare: false };
  var latest = { temp: null, hum: null, light: null, rain: null, device_id: null, rssi: null, timestamp: null };
  var previous = { temp: null, hum: null, light: null, rain: null };
  var connection = { lastDataAt: 0, hasData: false, online: false };
  var pageLoadedAt = Date.now();
  var alertFilter = 'all';
  var allAlerts = [];
  var chart = null;
  var refreshing = false;

  function $(id) { return document.getElementById(id); }
  var API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;

  /* ============================================================
     Formatting helpers
     ============================================================ */
  function formatClock(d) {
    if (!d) return '--:--:--';
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (v) { return String(v).padStart(2, '0'); })
      .join(':');
  }

  function formatDate(d) {
    if (!d) return '--';
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function formatDateTime(d) {
    if (!d) return '--';
    return formatDate(d) + ' · ' + formatClock(d);
  }

  function relativeTime(dateStr) {
    var then = new Date(dateStr).getTime();
    if (!isFinite(then)) return '';
    var diff = Date.now() - then;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'vừa xong';
    if (mins < 60) return mins + ' phút trước';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' giờ trước';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + ' ngày trước';
    return formatDate(new Date(then));
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ============================================================
     Geolocation
     ============================================================ */
  function startBrowserGeolocation() {
    var el = $('location-value');
    if (!navigator.geolocation) {
      el.textContent = 'Trình duyệt không hỗ trợ';
      return;
    }
    if (!window.isSecureContext) {
      el.textContent = 'Cần HTTPS hoặc localhost';
      return;
    }
    navigator.geolocation.watchPosition(
      function (pos) {
        var c = pos.coords;
        el.textContent = c.latitude.toFixed(4) + ', ' + c.longitude.toFixed(4);
        el.title = 'Độ chính xác khoảng ±' + Math.round(c.accuracy) + ' m';
      },
      function (error) {
        var messages = {
          1: 'Chưa cấp quyền vị trí',
          2: 'Không xác định được vị trí',
          3: 'Hết thời gian chờ vị trí'
        };
        el.textContent = messages[error.code] || 'Không lấy được vị trí';
        el.removeAttribute('title');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );
  }

  /* ============================================================
     Sensor cards
     ============================================================ */
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

  function setTrend(id, key, unit) {
    var el = $(id);
    var current = latest[key];
    var prior = previous[key];
    if (current == null || !isFinite(current)) {
      el.textContent = '—';
      el.className = 'trend';
      return;
    }
    if (prior == null || !isFinite(prior)) {
      el.textContent = 'Chưa có dữ liệu so sánh';
      el.className = 'trend';
      return;
    }
    var delta = current - prior;
    if (Math.abs(delta) < 0.05) {
      el.textContent = 'Ổn định so với lần trước';
      el.className = 'trend';
      return;
    }
    var up = delta > 0;
    var arrow = up ? '↑' : '↓';
    el.textContent = arrow + ' ' + Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0) + unit + ' so với lần trước';
    el.className = 'trend ' + (up ? 'up' : 'down');
  }

  function setRainTrend(el) {
    var current = latest.rain;
    var prior = previous.rain;
    if (current == null) {
      el.textContent = '—';
      el.className = 'trend';
      return;
    }
    if (prior == null) {
      el.textContent = current ? 'Đang có mưa' : 'Đang không mưa';
      el.className = 'trend';
      return;
    }
    if (current !== prior) {
      el.textContent = current ? '↑ Vừa ghi nhận có mưa' : '↓ Vừa ghi nhận hết mưa';
    } else {
      el.textContent = current ? 'Vẫn đang có mưa' : 'Vẫn không có mưa';
    }
    el.className = 'trend';
  }

  function updateSparkline(svgId, values, color) {
    var svg = $(svgId);
    if (!svg) return;
    if (!values.length) {
      svg.innerHTML = '';
      return;
    }
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = max - min || 1;
    var W = 100, H = 34;
    var points = values.map(function (value, index) {
      var x = (index / Math.max(values.length - 1, 1)) * W;
      var y = H - ((value - min) / range) * (H - 6) - 3;
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');
    var area = '0,' + H + ' ' + points + ' ' + W + ',' + H;

    svg.innerHTML =
      '<defs><linearGradient id="g-' + svgId + '" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.01"/>' +
      '</linearGradient></defs>' +
      '<polygon points="' + area + '" fill="url(#g-' + svgId + ')"/>' +
      '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
  }

  function minMaxOf(values) {
    if (!values.length) return null;
    return { min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
  }

  function updateCardMeta() {
    var window_ = {
      temp: history.temp.slice(-TREND_WINDOW),
      hum: history.hum.slice(-TREND_WINDOW),
      light: history.light.slice(-TREND_WINDOW)
    };

    [['temp', 1, '°C'], ['hum', 0, '%'], ['light', 0, ' lux']].forEach(function (cfg) {
      var key = cfg[0], decimals = cfg[1], unit = cfg[2];
      var mm = minMaxOf(window_[key]);
      var el = $('range-' + key);
      if (!mm) {
        el.textContent = 'Chưa có dữ liệu';
        return;
      }
      el.textContent = mm.min.toFixed(decimals) + ' – ' + mm.max.toFixed(decimals) + unit;
    });

    $('range-rain').textContent = latest.rain == null
      ? 'Chưa có dữ liệu'
      : (latest.rain ? 'Đang ướt (có mưa)' : 'Đang khô');
  }

  function updateSummaries() {
    if (latest.temp == null) {
      $('summary-temp').textContent = '—';
      $('summary-hum').textContent = '—';
      $('summary-light').textContent = '—';
      $('summary-rain').textContent = '—';
      return;
    }
    $('summary-temp').textContent = latest.temp > 31
      ? 'Nhiệt độ cao'
      : latest.temp < 21 ? 'Nhiệt độ thấp' : 'Nhiệt độ ổn định';
    $('summary-hum').textContent = latest.hum > 80
      ? 'Độ ẩm cao, dễ ẩm mốc'
      : latest.hum < 35 ? 'Khô, dễ mất nước' : 'Độ ẩm trong ngưỡng';
    $('summary-light').textContent = latest.light > 700
      ? 'Ánh sáng mạnh'
      : latest.light < 150 ? 'Môi trường tối' : 'Ánh sáng vừa phải';
    $('summary-rain').textContent = latest.rain
      ? 'Bề mặt ẩm, có khả năng mưa'
      : 'Bề mặt khô, không có mưa';
  }

  function updateDeviceMeta() {
    $('device-id').textContent = latest.device_id || '--';

    if (typeof latest.rssi === 'number' && isFinite(latest.rssi)) {
      $('rssi').textContent = latest.rssi + ' dBm';
      var bars = $('quality-bars');
      var quality = latest.rssi >= -60 ? 'good'
        : latest.rssi >= -70 ? 'medium'
        : latest.rssi >= -80 ? 'weak' : 'poor';
      bars.className = 'quality-bars ' + quality;
    } else {
      $('rssi').textContent = '--';
      $('quality-bars').className = 'quality-bars';
    }
  }

  function updateCards() {
    $('value-temp').textContent = latest.temp == null ? '--' : latest.temp.toFixed(1);
    $('value-hum').textContent = latest.hum == null ? '--' : Math.round(latest.hum);
    $('value-light').textContent = latest.light == null ? '--' : Math.round(latest.light);
    $('value-rain').textContent = latest.rain == null ? '--' : (latest.rain ? 'Có mưa' : 'Khô ráo');
    $('rain-unit').textContent = latest.rain == null ? 'trạng thái' : (latest.rain ? 'đang mưa' : 'khô ráo');

    setTrend('trend-temp', 'temp', '°C');
    setTrend('trend-hum', 'hum', '%');
    setTrend('trend-light', 'light', ' lux');
    setRainTrend($('trend-rain'));

    updateCardMeta();
    updateSummaries();
    updateDeviceMeta();

    updateSparkline('spark-temp', history.temp.slice(-SPARK_POINTS), SENSOR_META.temp.color);
    updateSparkline('spark-hum', history.hum.slice(-SPARK_POINTS), SENSOR_META.hum.color);
    updateSparkline('spark-light', history.light.slice(-SPARK_POINTS), SENSOR_META.light.color);
    updateSparkline('spark-rain', history.rain.slice(-SPARK_POINTS), SENSOR_META.rain.color);
  }

  function markStale(stale) {
    ['temp', 'hum', 'light', 'rain'].forEach(function (key) {
      var card = document.querySelector('.sensor-card[data-sensor="' + key + '"]');
      if (card) card.classList.toggle('is-stale', stale);
    });
  }

  /* ============================================================
     Connection status
     ============================================================ */
  function setConnectionState(state, label) {
    var chip = $('connection-pill');
    chip.classList.remove('online', 'offline', 'error');
    if (state) chip.classList.add(state);
    $('connection-text').textContent = label;
  }

  function updateConnectionState() {
    if (!connection.hasData) {
      setConnectionState('', 'Đang chờ dữ liệu');
      markStale(false);
      return;
    }
    var age = Date.now() - connection.lastDataAt;
    if (!connection.online || age > OFFLINE_THRESHOLD_MS) {
      setConnectionState('offline', 'Mất kết nối');
      markStale(true);
    } else {
      setConnectionState('online', 'Đang hoạt động');
      markStale(false);
    }
  }

  function updateUptime() {
    var sec = Math.floor((Date.now() - pageLoadedAt) / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    $('uptime').textContent = h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  /* ============================================================
     Alerts
     ============================================================ */
  function alertIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.5a7 7 0 0 1 7 7c0 4.3-2.7 6.8-4.4 8.9a2.2 2.2 0 0 1-5.2 0C7.7 17.3 5 14.8 5 10.5a7 7 0 0 1 7-7Z"/>' +
      '<path d="M12 8v4"/><circle cx="12" cy="15.5" r="0.9" fill="currentColor" stroke="none"/></svg>';
  }

  function renderAlerts() {
    var list = $('alert-list');
    var filtered = alertFilter === 'all'
      ? allAlerts
      : allAlerts.filter(function (a) { return a.severity === alertFilter; });

    if (!filtered.length) {
      list.innerHTML =
        '<div class="empty-state">' + alertIconSvg() +
        '<p>' + (allAlerts.length ? 'Không có cảnh báo ở mức độ này' : 'Không phát hiện bất thường') + '</p>' +
        '<span>' + (allAlerts.length
          ? 'Chọn bộ lọc khác để xem các mức độ còn lại.'
          : 'Hệ thống đang theo dõi nhiệt độ, độ ẩm và ánh sáng theo ngưỡng vật lý.') + '</span>' +
        '</div>';
      return;
    }

    list.innerHTML = '';
    filtered.forEach(function (a) {
      var severity = SEVERITY_LABEL[a.severity] ? a.severity : 'medium';
      var unit = SENSOR_META[a.sensor] ? SENSOR_META[a.sensor].unit : '';
      var row = document.createElement('div');
      row.className = 'alert-item sev-' + severity;

      var icon = document.createElement('span');
      icon.className = 'alert-icon';
      icon.innerHTML = alertIconSvg();

      var body = document.createElement('div');
      body.className = 'alert-body';

      var msg = document.createElement('div');
      msg.className = 'alert-message';
      msg.textContent = a.reason || 'Bất thường không xác định';

      var meta = document.createElement('div');
      meta.className = 'alert-meta';
      var sensorName = SENSOR_LABEL[a.sensor] || a.sensor;
      meta.appendChild(document.createTextNode(sensorName));
      meta.appendChild(dotSpan());
      meta.appendChild(document.createTextNode('Giá trị ' + a.value + unit));
      if (a.expected) {
        meta.appendChild(dotSpan());
        meta.appendChild(document.createTextNode('Kỳ vọng ' + a.expected));
      }

      body.appendChild(msg);
      body.appendChild(meta);

      var time = document.createElement('time');
      time.className = 'alert-time';
      time.dateTime = a.created_at;
      time.textContent = relativeTime(a.created_at);
      time.title = formatDateTime(new Date(a.created_at));

      var tag = document.createElement('span');
      tag.className = 'alert-tag';
      tag.textContent = SEVERITY_LABEL[severity];

      row.appendChild(icon);
      row.appendChild(body);
      row.appendChild(time);
      row.appendChild(tag);
      list.appendChild(row);
    });
  }

  function dotSpan() {
    var s = document.createElement('span');
    s.className = 'dot';
    s.textContent = '·';
    return s;
  }

  function applyAlertBadges() {
    var now = Date.now();
    ['temp', 'hum', 'light'].forEach(function (key) {
      var recent = allAlerts.some(function (a) {
        return a.sensor === key && now - new Date(a.created_at).getTime() < 60000;
      });
      setBadge('badge-' + key, recent ? 'abnormal' : 'normal');
    });
    setBadge('badge-rain', 'normal');

    document.querySelectorAll('.sensor-card').forEach(function (card) {
      var key = card.getAttribute('data-sensor');
      if (key === 'rain') return;
      var bad = allAlerts.some(function (a) {
        return a.sensor === key && now - new Date(a.created_at).getTime() < 60000;
      });
      card.classList.toggle('abnormal', bad);
    });
  }

  function updateBanner() {
    var banner = $('ai-banner');
    var textEl = $('ai-banner-text');
    var now = Date.now();

    var fresh = allAlerts.filter(function (a) {
      return now - new Date(a.created_at).getTime() < 20000;
    })[0];

    if (fresh) {
      var unit = SENSOR_META[fresh.sensor] ? SENSOR_META[fresh.sensor].unit : '';
      textEl.textContent = fresh.reason + ': ' + fresh.value + unit;
      banner.classList.remove('warn');
      banner.hidden = false;
      return;
    }

    // Fall back to device connectivity problems, which are also actionable
    if (connection.hasData && !connection.online) {
      textEl.textContent = 'Thiết bị đang mất kết nối. Dữ liệu hiển thị có thể đã cũ.';
      banner.classList.add('warn');
      banner.hidden = false;
      return;
    }

    banner.hidden = true;
  }

  function loadAlerts() {
    return fetch(API_BASE + '/api/alerts?limit=50')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (alerts) {
        allAlerts = alerts || [];
        $('last-check').textContent = 'Kiểm tra lúc ' + formatClock(new Date()) +
          ' · ' + allAlerts.length + ' cảnh báo ghi nhận';
        renderAlerts();
        applyAlertBadges();
        updateBanner();
      })
      .catch(function (err) {
        console.error('Không tải được cảnh báo:', err);
        $('last-check').textContent = 'Không tải được danh sách cảnh báo';
      });
  }

  /* ============================================================
     History + chart
     ============================================================ */
  function fetchHistory(range) {
    return fetch(API_BASE + '/api/sensors/history?range=' + encodeURIComponent(range))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        return {
          labels: data.labels || [],
          temp: data.temp || [],
          hum: data.hum || [],
          light: data.light || [],
          rain: data.rain || [],
          count: data.count || 0,
          downsampled: !!data.downsampled
        };
      });
  }

  function applyHistory(data) {
    history.labels = data.labels;
    history.temp = data.temp;
    history.hum = data.hum;
    history.light = data.light;
    history.rain = data.rain;
  }

  function formatAxisLabel(iso, range) {
    var d = new Date(iso);
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (range === '7d') return d.getDate() + '/' + (d.getMonth() + 1);
    if (range === '24h') return hm;
    return hm;
  }

  function compareTarget() {
    if (history.active === 'temp') return 'hum';
    if (history.active === 'hum') return 'temp';
    return 'hum';
  }

  function updateCompareButton() {
    var target = SENSOR_META[compareTarget()].label;
    var btn = $('compare-btn');
    var span = btn.querySelector('span');
    btn.classList.toggle('active', history.compare);
    btn.setAttribute('aria-pressed', String(history.compare));
    span.textContent = (history.compare ? 'Tắt so sánh với ' : 'So sánh với ') + target;
  }

  function updateChartSummary() {
    var el = $('chart-summary');
    var n = history.labels.length;
    if (!n) {
      el.textContent = 'Chưa có dữ liệu trong khoảng ' + RANGE_LABEL[history.range];
      return;
    }
    var txt = n + ' mốc đo · ' + RANGE_LABEL[history.range];
    if (history.lastDownsampled) txt += ' · đã lấy mẫu từ ' + history.lastCount + ' bản ghi';
    el.textContent = txt;
  }

  function renderChart() {
    var canvas = $('history-chart');
    var emptyEl = $('chart-empty');
    if (!canvas) return;

    var hasData = history.labels.length > 0;
    emptyEl.hidden = hasData;

    if (typeof Chart === 'undefined') return; // CDN blocked — empty state carries the message

    var activeKey = history.active;
    var meta = SENSOR_META[activeKey];
    var isRain = activeKey === 'rain';
    var cmpKey = history.compare ? compareTarget() : null;
    var cmpMeta = cmpKey ? SENSOR_META[cmpKey] : null;

    var labels = history.labels.map(function (t) { return formatAxisLabel(t, history.range); });
    var activeData = history[activeKey] || [];

    if (!chart) {
      chart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          animation: { duration: 240 },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              align: 'end',
              labels: {
                color: '#a4b4c4',
                usePointStyle: true,
                pointStyle: 'circle',
                boxWidth: 7,
                boxHeight: 7,
                padding: 14,
                font: { size: 12, weight: '600' }
              }
            },
            tooltip: {
              backgroundColor: '#1d2833',
              borderColor: '#33465a',
              borderWidth: 1,
              titleColor: '#e9eff5',
              bodyColor: '#a4b4c4',
              padding: 10,
              cornerRadius: 8,
              displayColors: true,
              boxPadding: 4,
              callbacks: {
                title: function (items) {
                  var i = items[0].dataIndex;
                  var iso = history.labels[i];
                  return iso ? formatDateTime(new Date(iso)) : '';
                },
                label: function (ctx) {
                  var unit = ctx.dataset.unit || '';
                  if (ctx.dataset.label === 'Mưa') {
                    return ctx.dataset.label + ': ' + (ctx.parsed.y >= 0.5 ? 'Có mưa' : 'Khô ráo');
                  }
                  return ctx.dataset.label + ': ' + ctx.parsed.y + unit;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(37,51,64,0.6)', drawTicks: false },
              border: { color: '#253340' },
              ticks: {
                color: '#6f8296',
                maxTicksLimit: 9,
                maxRotation: 0,
                autoSkip: true,
                font: { size: 11 }
              }
            },
            y: {
              position: 'left',
              beginAtZero: false,
              grid: { color: 'rgba(37,51,64,0.6)', drawTicks: false },
              border: { display: false },
              ticks: { color: '#6f8296', font: { size: 11 }, padding: 8 }
            },
            y1: {
              position: 'right',
              display: false,
              grid: { drawOnChartArea: false },
              border: { display: false },
              ticks: { color: '#6f8296', font: { size: 11 }, padding: 8 }
            }
          }
        }
      });
    }

    var datasets = [];

    if (isRain) {
      // Rain is a binary state — a bar chart reads correctly, a line chart does not.
      datasets.push({
        type: 'bar',
        label: 'Mưa',
        data: activeData,
        backgroundColor: meta.color + 'cc',
        borderColor: meta.color,
        borderWidth: 1,
        borderRadius: 2,
        barPercentage: 0.85,
        categoryPercentage: 0.9,
        yAxisID: 'y',
        unit: '',
        order: 2
      });
    } else {
      datasets.push({
        type: 'line',
        label: meta.label,
        data: activeData,
        borderColor: meta.color,
        backgroundColor: meta.dim,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: meta.color,
        pointHoverBorderColor: '#0b0f14',
        pointHoverBorderWidth: 2,
        tension: 0.32,
        fill: true,
        yAxisID: 'y',
        unit: meta.unit,
        order: 2
      });
    }

    if (cmpKey && !isRain) {
      datasets.push({
        type: 'line',
        label: cmpMeta.label,
        data: history[cmpKey] || [],
        borderColor: cmpMeta.color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.32,
        fill: false,
        yAxisID: 'y1',
        unit: cmpMeta.unit,
        order: 1
      });
    }

    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.options.scales.y.title = {
      display: true,
      text: isRain ? 'Trạng thái mưa' : meta.label + ' (' + meta.unit + ')',
      color: '#6f8296',
      font: { size: 11, weight: '600' }
    };
    chart.options.scales.y1.display = !!(cmpKey && !isRain);
    if (cmpKey && !isRain) {
      chart.options.scales.y1.title = {
        display: true,
        text: cmpMeta.label + ' (' + cmpMeta.unit + ')',
        color: '#6f8296',
        font: { size: 11, weight: '600' }
      };
    }
    chart.options.scales.y.beginAtZero = false;
    chart.options.scales.y.max = isRain ? 1 : undefined;
    chart.options.scales.y.min = isRain ? 0 : undefined;
    chart.options.scales.y.ticks.stepSize = isRain ? 1 : undefined;
    chart.options.scales.y.ticks.callback = isRain
      ? function (v) { return v >= 0.5 ? 'Mưa' : 'Khô'; }
      : function (v) { return v; };

    chart.update();
  }

  /* ============================================================
     Data refresh
     ============================================================ */
  function applyLatest(data) {
    previous.temp = latest.temp;
    previous.hum = latest.hum;
    previous.light = latest.light;
    previous.rain = latest.rain;

    latest.temp = data.temp;
    latest.hum = data.hum;
    latest.light = data.light;
    latest.rain = data.rain;
    latest.device_id = data.device_id;
    latest.rssi = data.rssi;
    latest.timestamp = data.timestamp;

    connection.lastDataAt = new Date(data.timestamp).getTime();
    connection.hasData = true;
    connection.online = data.online !== false;
  }

  function refreshData() {
    if (refreshing) return Promise.resolve();
    refreshing = true;

    return fetch(API_BASE + '/api/sensors/latest')
      .then(function (res) {
        if (res.status === 204) {
          setConnectionState('', 'Chưa có dữ liệu');
          return null;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data) return null;
        $('last-updated').textContent = formatClock(new Date(data.timestamp));
        applyLatest(data);
        return fetchHistory(history.range).then(function (h) {
          history.lastDownsampled = h.downsampled;
          history.lastCount = h.count;
          applyHistory(h);
          updateCards();
          renderChart();
          updateChartSummary();
          return loadAlerts();
        });
      })
      .then(updateConnectionState)
      .catch(function (err) {
        console.error(err);
        setConnectionState('error', 'Lỗi kết nối server');
        updateBanner();
      })
      .then(function () {
        refreshing = false;
      });
  }

  /* ============================================================
     Events
     ============================================================ */
  $('refresh-btn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    var label = btn.querySelector('span');
    var original = label.textContent;
    label.textContent = 'Đang tải…';
    refreshData().then(function () {
      btn.disabled = false;
      label.textContent = original;
    });
  });

  $('series-tabs').addEventListener('click', function (event) {
    var button = event.target.closest('.seg-btn');
    if (!button) return;
    history.active = button.dataset.key;
    this.querySelectorAll('.seg-btn').forEach(function (el) {
      var selected = el === button;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    $('history-panel').setAttribute('aria-labelledby', 'tab-' + history.active);
    updateCompareButton();
    renderChart();
  });

  $('range-tabs').addEventListener('click', function (event) {
    var button = event.target.closest('.seg-btn');
    if (!button) return;
    history.range = button.dataset.range;
    this.querySelectorAll('.seg-btn').forEach(function (el) {
      var selected = el === button;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    fetchHistory(history.range)
      .then(function (h) {
        history.lastDownsampled = h.downsampled;
        history.lastCount = h.count;
        applyHistory(h);
      })
      .catch(function (err) { console.error(err); })
      .then(function () {
        updateCards();
        renderChart();
        updateChartSummary();
      });
  });

  $('compare-btn').addEventListener('click', function () {
    history.compare = !history.compare;
    updateCompareButton();
    renderChart();
  });

  $('alert-filters').addEventListener('click', function (event) {
    var button = event.target.closest('.seg-btn');
    if (!button) return;
    alertFilter = button.dataset.severity;
    this.querySelectorAll('.seg-btn').forEach(function (el) {
      var selected = el === button;
      el.classList.toggle('active', selected);
      el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    renderAlerts();
  });

  /* ============================================================
     Init
     ============================================================ */
  function initialize() {
    startBrowserGeolocation();
    updateUptime();
    setInterval(updateUptime, 30000);

    setConnectionState('', 'Đang chờ dữ liệu');
    updateCompareButton();
    updateChartSummary();
    renderChart();

    fetchHistory('1h')
      .then(function (h) {
        history.lastDownsampled = h.downsampled;
        history.lastCount = h.count;
        applyHistory(h);
      })
      .catch(function (err) { console.error('Không tải được lịch sử ban đầu:', err); })
      .then(function () {
        updateCards();
        renderChart();
        updateChartSummary();
        return refreshData();
      });

    setInterval(function () {
      if (document.visibilityState === 'visible') {
        refreshData();
      } else {
        updateConnectionState();
      }
    }, REFRESH_MS);
  }

  initialize();
})();
