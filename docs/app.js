// Keys are the channel names the Pico writes as column prefixes
// (CHANNELS in its settings.toml: "blank:0,control:1,sample:2").
const ASTM_CHANNELS = {
    blank:   { label: 'Blank', role: 'Background reference', colorVar: '--blank' },
    control: { label: 'Microcrystalline cellulose', role: 'Positive control', colorVar: '--positive' },
    sample:  { label: 'Self-healing polyurethane', role: 'Test material', colorVar: '--sample' },
};

// Alerts shown while this page is open, for example
//   { channel_id: 'sample', metric: 'temp_c', direction: 'below', threshold: 55 }
// metric is co2_ppm, temp_c or humidity_rh; leave out channel_id to watch all.
const ALERT_RULES = [];

// step = seconds per averaged point (0 = every 30 s row)
const RANGES = {
    '24h': { hours: 24,  step: 0 },
    '7d':  { hours: 168, step: 300 },
    '30d': { hours: 720, step: 1800 },
};

// Rows reach the sheet in 2-minute batches, so allow for that before
// calling a channel stale or offline.
const STALE_MINUTES = 5;
const OFFLINE_MINUTES = 15;

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const alertLastFired = {};
const ALERT_LOG_MAX = 50;

let charts = {};
let channelColors = {};
let channelData = {};
let columnIndex = {};      // channel -> positions of its values in a row
let columnsKey = '';
let lastUtc = null;
let selectedRange = '24h';
let alertBannerTimeout;

document.addEventListener('DOMContentLoaded', async () => {
    initCharts();
    if (!SHEETS_URL) {
        showStatus('Set SHEETS_URL in config.js to the Apps Script /exec URL.');
        return;
    }
    await loadHistoricalData();
    setInterval(pollNewRows, REFRESH_SECONDS * 1000);
    startOfflineCheck();

    document.querySelectorAll('.time-range-selector button').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.time-range-selector button')
                .forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedRange = btn.dataset.range;
            await loadHistoricalData();
        });
    });

    if (ALERT_RULES.length && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});

async function fetchSheet(params) {
    const res = await fetch(`${SHEETS_URL}?${new URLSearchParams(params)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'request failed');
    return data;
}

// "blank_co2_ppm", "blank_temp_c", "blank_rh", ... -> { blank: { co2: 1, temp: 2, rh: 3 }, ... }
// (positions are into a row, where row[0] is the utc time)
function indexColumns(columns) {
    const index = {};
    const suffixes = { _co2_ppm: 'co2', _temp_c: 'temp', _rh: 'rh' };
    columns.forEach((col, i) => {
        Object.entries(suffixes).forEach(([suffix, key]) => {
            if (col.endsWith(suffix)) {
                const name = col.slice(0, -suffix.length);
                (index[name] = index[name] || {})[key] = i + 1;
            }
        });
    });
    return index;
}

function toReading(row, channelId) {
    const idx = columnIndex[channelId];
    return {
        channel_id: channelId,
        recorded_at: row[0],
        co2_ppm: row[idx.co2],
        temp_c: row[idx.temp],
        humidity_rh: row[idx.rh],
    };
}

function addPoints(row) {
    const t = new Date(row[0]);
    Object.keys(columnIndex).forEach(chId => {
        if (isHidden(chId)) return;
        const r = toReading(row, chId);
        channelData[chId].co2.push({ x: t, y: r.co2_ppm });
        channelData[chId].temp.push({ x: t, y: r.temp_c });
        channelData[chId].humidity.push({ x: t, y: r.humidity_rh });
    });
}

async function loadHistoricalData() {
    const range = RANGES[selectedRange];
    let data;
    try {
        data = await fetchSheet({ hours: range.hours, step: range.step });
    } catch (err) {
        showStatus(`Couldn't load data from Google Sheets (${err.message}).`);
        return;
    }

    columnIndex = indexColumns(data.columns);
    columnsKey = data.columns.join(',');
    channelData = {};
    Object.keys(columnIndex).forEach((chId, i) => {
        channelColors[chId] = getChannelColor(chId, i);
        channelData[chId] = { co2: [], temp: [], humidity: [] };
    });

    data.rows.forEach(addPoints);
    lastUtc = data.latest ? data.latest[0] : null;
    renderCards(data.latest);
    rebuildChartDatasets();
}

async function pollNewRows() {
    if (!lastUtc) return loadHistoricalData();
    let data;
    try {
        data = await fetchSheet({ since: lastUtc });
    } catch (err) {
        return;   // keep showing what we have; the next poll tries again
    }
    if (data.columns.join(',') !== columnsKey) return loadHistoricalData();  // channels changed
    if (!data.rows.length) return;

    data.rows.forEach(row => {
        addPoints(row);
        Object.keys(columnIndex).forEach(chId => {
            if (isHidden(chId)) return;
            const r = toReading(row, chId);
            updateChannelCard(r);
            checkAlertThresholds(r);
        });
    });
    lastUtc = data.rows[data.rows.length - 1][0];

    const cutoff = Date.now() - RANGES[selectedRange].hours * 3600 * 1000;
    Object.keys(channelData).forEach(chId => {
        ['co2', 'temp', 'humidity'].forEach(k => {
            channelData[chId][k] = channelData[chId][k].filter(p => p.x.getTime() >= cutoff);
        });
        updateChartDataset(chId);
    });
}

function showStatus(msg) {
    const container = document.getElementById('channel-cards');
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'loading-state';
    p.textContent = msg;
    container.appendChild(p);
}

function renderCards(latest) {
    const container = document.getElementById('channel-cards');
    container.innerHTML = '';
    const ids = Object.keys(columnIndex).filter(chId => !isHidden(chId));
    if (!ids.length) {
        showStatus('No data in the sheet yet.');
        return;
    }
    ids.forEach(chId => {
        const r = latest ? toReading(latest, chId) : {};
        container.appendChild(buildChannelCard({
            channel_id: chId,
            status: statusFor(r.recorded_at),
            last_reading_at: r.recorded_at,
            last_co2_ppm: r.co2_ppm,
            last_temp_c: r.temp_c,
            last_humidity_rh: r.humidity_rh,
        }));
    });
}

function statusFor(recordedAt) {
    if (!recordedAt) return 'offline';
    const ageMins = (Date.now() - new Date(recordedAt).getTime()) / 60000;
    return ageMins > OFFLINE_MINUTES ? 'offline' : ageMins > STALE_MINUTES ? 'stale' : 'online';
}

function buildChannelCard(ch) {
    const div = document.createElement('div');
    div.className = `channel-card ${escHtml(ch.status || 'offline')}`;
    div.id = `card-${ch.channel_id}`;
    div.dataset.lastSeen = ch.last_reading_at || '';

    const co2 = ch.last_co2_ppm != null ? ch.last_co2_ppm.toFixed(0) : '-';
    const temp = ch.last_temp_c != null ? ch.last_temp_c.toFixed(1) : '-';
    const hum = ch.last_humidity_rh != null ? ch.last_humidity_rh.toFixed(1) : '-';
    const lastSeen = ch.last_reading_at ? timeAgo(new Date(ch.last_reading_at)) : 'never';

    div.innerHTML = `
        <div class="card-header">
            <div>
                <div class="card-role">${escHtml(getChannelRole(ch.channel_id))}</div>
                <div class="card-name">${escHtml(getChannelLabel(ch))}</div>
                <div class="card-location">${escHtml(ch.channel_id)}</div>
            </div>
            <div class="status-dot"></div>
        </div>
        <div class="metric-row">
            <span class="metric-label">CO<sub>2</sub> ppm</span>
            <span class="metric-value co2-val">${co2} ppm</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Temperature</span>
            <span class="metric-value">${temp} °C</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Humidity</span>
            <span class="metric-value">${hum} %</span>
        </div>
        <div class="last-seen">Last: ${lastSeen}</div>
    `;
    return div;
}

function updateChannelCard(r) {
    const card = document.getElementById(`card-${r.channel_id}`);
    if (!card) return;

    card.dataset.lastSeen = r.recorded_at;
    card.className = `channel-card ${statusFor(r.recorded_at)}`;

    const values = card.querySelectorAll('.metric-value');
    values[0].textContent = r.co2_ppm != null ? `${Number(r.co2_ppm).toFixed(0)} ppm` : '- ppm';
    values[1].textContent = r.temp_c != null ? `${Number(r.temp_c).toFixed(1)} °C` : '- °C';
    values[2].textContent = r.humidity_rh != null ? `${Number(r.humidity_rh).toFixed(1)} %` : '- %';
    card.querySelector('.last-seen').textContent = `Last: ${timeAgo(new Date(r.recorded_at))}`;
}

function startOfflineCheck() {
    setInterval(() => {
        document.querySelectorAll('.channel-card').forEach(card => {
            const lastSeen = card.dataset.lastSeen;
            if (!lastSeen) return;
            card.className = `channel-card ${statusFor(lastSeen)}`;
            card.querySelector('.last-seen').textContent = `Last: ${timeAgo(new Date(lastSeen))}`;
        });
    }, 60000);
}

function checkAlertThresholds(r) {
    ALERT_RULES.forEach((rule, i) => {
        if (rule.channel_id && rule.channel_id !== r.channel_id) return;
        const value = rule.metric === 'co2_ppm' ? r.co2_ppm
                    : rule.metric === 'temp_c' ? r.temp_c
                    : r.humidity_rh;
        if (value == null) return;

        const triggered = rule.direction === 'above'
            ? value > rule.threshold
            : value < rule.threshold;

        if (!triggered) return;

        const cooldownKey = `${i}|${r.channel_id}`;
        const now = Date.now();
        if (alertLastFired[cooldownKey] && now - alertLastFired[cooldownKey] < ALERT_COOLDOWN_MS) return;
        alertLastFired[cooldownKey] = now;

        const msg = `${getChannelLabel({ channel_id: r.channel_id })}: ${rule.metric} = ${value.toFixed(1)} (${rule.direction} ${rule.threshold})`;
        showAlertBanner(msg);
        addAlertLogEntry(msg);

        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('ASTM D5338 CO₂ Alert', { body: msg });
        }
    });
}

function initCharts() {
    const FONT = 'Arial, Helvetica, sans-serif';
    Chart.defaults.font.family = FONT;
    const TZ = 'America/New_York';
    const fmtTickHour = (v) => new Date(v).toLocaleString('en-US',
        { timeZone: TZ, hour: 'numeric', hour12: true });
    const fmtTickMinute = (v) => new Date(v).toLocaleString('en-US',
        { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
    const fmtTickDay = (v) => new Date(v).toLocaleString('en-US',
        { timeZone: TZ, month: 'short', day: 'numeric' });
    const fmtTooltip = (items) => new Date(items[0].parsed.x).toLocaleString('en-US',
        { timeZone: TZ, month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });

    const commonOpts = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        spanGaps: false,
        layout: { padding: { top: 4, right: 8, bottom: 4, left: 4 } },
        scales: {
            x: {
                type: 'time',
                ticks: {
                    color: chartToken('--text-muted'),
                    font: { family: FONT, size: 13 },
                    maxTicksLimit: 8,
                    autoSkipPadding: 16,
                    callback: function(v, i, ticks) {
                        if (ticks && ticks.length > 1) {
                            const range = ticks[ticks.length - 1].value - ticks[0].value;
                            if (range > 36 * 3600 * 1000) return fmtTickDay(v);
                            return range > 6 * 3600 * 1000 ? fmtTickHour(v) : fmtTickMinute(v);
                        }
                        return fmtTickHour(v);
                    },
                },
                grid: { color: chartToken('--border') },
            },
            y: {
                ticks: { color: chartToken('--text-muted'), font: { family: FONT, size: 13 } },
                grid: { color: chartToken('--border') },
            },
        },
        plugins: {
            legend: { position: 'top', align: 'center', labels: { color: chartToken('--text'), boxWidth: 14, font: { family: FONT, size: 14, weight: 'normal' }, padding: 14, }, },
            tooltip: { callbacks: { title: fmtTooltip }, titleFont: { family: FONT, size: 15 }, bodyFont: { family: FONT, size: 15 } },
        },
    };

    charts.co2 = new Chart(document.getElementById('chart-co2'), {
        type: 'line',
        data: { datasets: [] },
        options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: false } } } },
    });
    charts.temp = new Chart(document.getElementById('chart-temp'), {
        type: 'line',
        data: { datasets: [] },
        options: { ...commonOpts },
    });
    charts.humidity = new Chart(document.getElementById('chart-humidity'), {
        type: 'line',
        data: { datasets: [] },
        options: { ...commonOpts },
    });
}

function rebuildChartDatasets() {
    ['co2', 'temp', 'humidity'].forEach(metric => {
        const chart = metric === 'co2' ? charts.co2
                    : metric === 'temp' ? charts.temp
                    : charts.humidity;
        chart.data.datasets = Object.entries(channelData)
            .filter(([chId]) => !isHidden(chId))
            .map(([chId, d]) => ({
                label: getChannelLabel({ channel_id: chId }),
                channelId: chId,
                data: d[metric],
                borderColor: channelColors[chId] || chartToken('--focus'),
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.2,
            }));
        chart.update('none');
    });
}

function updateChartDataset(channelId) {
    ['co2', 'temp', 'humidity'].forEach(metric => {
        const chart = metric === 'co2' ? charts.co2
                    : metric === 'temp' ? charts.temp
                    : charts.humidity;
        const ds = chart.data.datasets.find(d => d.channelId === channelId);
        if (ds) {
            ds.data = channelData[channelId][metric];
            chart.update('none');
        }
    });
}

function showAlertBanner(msg) {
    const banner = document.getElementById('alert-banner');
    banner.textContent = `Alert: ${msg}`;
    banner.classList.add('active');
    clearTimeout(alertBannerTimeout);
    alertBannerTimeout = setTimeout(() => banner.classList.remove('active'), 10000);
}

function addAlertLogEntry(msg) {
    const log = document.getElementById('alert-log');
    const noAlerts = log.querySelector('.no-alerts');
    if (noAlerts) noAlerts.remove();

    const entry = document.createElement('div');
    entry.className = 'alert-entry';
    entry.innerHTML = `
        <span class="alert-time">${new Date().toLocaleTimeString()}</span>
        <span class="alert-msg">${escHtml(msg)}</span>
    `;
    log.appendChild(entry);

    const entries = log.querySelectorAll('.alert-entry');
    if (entries.length > ALERT_LOG_MAX) {
        entries[0].remove();
    }
}

function isHidden(channelId) {
    return !!(ASTM_CHANNELS[channelId] && ASTM_CHANNELS[channelId].hidden);
}

function timeAgo(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

function getChannelLabel(ch) {
    const configured = ASTM_CHANNELS[ch.channel_id];
    return configured ? configured.label : ch.label || ch.channel_id;
}

function getChannelRole(channelId) {
    return ASTM_CHANNELS[channelId] ? ASTM_CHANNELS[channelId].role : 'Measurement channel';
}

function getChannelColor(channelId, index) {
    const configured = ASTM_CHANNELS[channelId];
    if (configured) return chartToken(configured.colorVar);
    const fallbackVars = ['--focus', '--online', '--stale', '--alert', '--offline'];
    return chartToken(fallbackVars[index % fallbackVars.length]);
}

function chartToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
