// Keys are the channel names the Pico writes as column prefixes
// (CHANNELS in its settings.toml: "blank:0,control:1,sample:2").
const ASTM_CHANNELS = {
    blank:   { label: 'Blank', role: 'Background reference', colorVar: '--blank' },
    control: { label: 'Microcrystalline cellulose', role: 'Positive control', colorVar: '--positive' },
    sample:  { label: 'Self-healing polyurethane', role: 'Test material', colorVar: '--sample' },
};

// Inlet air is not CO2-stripped, so room CO2 and compost respiration are
// removed by subtracting the blank vessel: net = vessel CO2 - blank CO2.
const BLANK_CHANNEL = 'blank';

// Chart key -> metric stored per channel
const METRICS = { net: 'net', co2: 'co2', temp: 'temp', humidity: 'humidity' };

// step = seconds per averaged point (0 = every 30 s row)
const RANGES = {
    '24h': { hours: 24,  step: 0 },
    '7d':  { hours: 168, step: 300 },
    '30d': { hours: 720, step: 1800 },
};

// The Pico uploads every 30 s row as it is taken.
const STALE_MINUTES = 2;
const OFFLINE_MINUTES = 10;

let charts = {};
let channelColors = {};
let channelData = {};
let columnIndex = {};      // channel -> positions of its values in a row
let columnsKey = '';
let lastUtc = null;
let selectedRange = '24h';
let lastPointTime = null;  // to break chart lines where data is missing

document.addEventListener('DOMContentLoaded', async () => {
    initCharts();
    if (!SHEETS_URL) {
        showStatus('Set SHEETS_URL in config.js to the Apps Script /exec URL.');
        return;
    }
    await loadHistoricalData();
    await loadEvolution();
    setInterval(pollNewRows, REFRESH_SECONDS * 1000);
    setInterval(loadEvolution, 5 * 60 * 1000);
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
    const blank = columnIndex[BLANK_CHANNEL];
    const co2 = withOffset(row[idx.co2], channelId);
    const blankCo2 = blank ? withOffset(row[blank.co2], BLANK_CHANNEL) : null;
    return {
        channel_id: channelId,
        recorded_at: row[0],
        co2_ppm: co2,
        net_ppm: channelId !== BLANK_CHANNEL && co2 != null && blankCo2 != null
            ? Math.round((co2 - blankCo2) * 10) / 10 : null,
        temp_c: row[idx.temp],
        humidity_rh: row[idx.rh],
    };
}

function withOffset(value, channelId) {
    if (value == null) return null;
    const offset = (typeof CO2_OFFSET_PPM !== 'undefined' && CO2_OFFSET_PPM[channelId]) || 0;
    return Math.round((value + offset) * 10) / 10;
}

function addPoints(row) {
    const t = new Date(row[0]);
    // A gap of more than 3 rows (or 3 averaged points) is drawn as a break,
    // not as a straight line across the missing data
    const gapMs = Math.max(3 * (RANGES[selectedRange].step || 30), 120) * 1000;
    const gap = lastPointTime && t - lastPointTime > gapMs;
    lastPointTime = t;
    Object.keys(columnIndex).forEach(chId => {
        if (isHidden(chId)) return;
        if (gap) {
            const mid = new Date(t - gapMs / 2);
            Object.values(METRICS).forEach(k => channelData[chId][k].push({ x: mid, y: null }));
        }
        const r = toReading(row, chId);
        channelData[chId].net.push({ x: t, y: r.net_ppm });
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
        channelData[chId] = { net: [], co2: [], temp: [], humidity: [] };
    });

    lastPointTime = null;
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
            updateChannelCard(toReading(row, chId));
        });
    });
    lastUtc = data.rows[data.rows.length - 1][0];

    const cutoff = Date.now() - RANGES[selectedRange].hours * 3600 * 1000;
    Object.keys(channelData).forEach(chId => {
        Object.values(METRICS).forEach(k => {
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
            last_net_ppm: r.net_ppm,
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
    const net = fmtNet(ch.last_net_ppm);
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
        ${ch.channel_id === BLANK_CHANNEL ? '' : `
        <div class="metric-row metric-row-net">
            <span class="metric-label">Net CO<sub>2</sub> (minus blank)</span>
            <span class="metric-value net-val">${net}</span>
        </div>`}
        <div class="metric-row">
            <span class="metric-label">CO<sub>2</sub></span>
            <span class="metric-value co2-val">${co2} ppm</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Temperature</span>
            <span class="metric-value temp-val">${temp} °C</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Humidity</span>
            <span class="metric-value rh-val">${hum} %</span>
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

    const netEl = card.querySelector('.net-val');
    if (netEl) netEl.textContent = fmtNet(r.net_ppm);
    card.querySelector('.co2-val').textContent = r.co2_ppm != null ? `${Number(r.co2_ppm).toFixed(0)} ppm` : '- ppm';
    card.querySelector('.temp-val').textContent = r.temp_c != null ? `${Number(r.temp_c).toFixed(1)} °C` : '- °C';
    card.querySelector('.rh-val').textContent = r.humidity_rh != null ? `${Number(r.humidity_rh).toFixed(1)} %` : '- %';
    card.querySelector('.last-seen').textContent = `Last: ${timeAgo(new Date(r.recorded_at))}`;
}

function fmtNet(v) {
    if (v == null) return '- ppm';
    return `${v > 0 ? '+' : ''}${Number(v).toFixed(0)} ppm`;
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

    charts.net = new Chart(document.getElementById('chart-net'), {
        type: 'line',
        data: { datasets: [] },
        options: { ...commonOpts },
    });
    charts.evolution = new Chart(document.getElementById('chart-evolution'), {
        type: 'line',
        data: { datasets: [] },
        options: {
            ...commonOpts,
            scales: {
                x: { type: 'linear', min: 0, title: { display: true, text: 'Days since start', font: { family: FONT, size: 13 } },
                     ticks: { color: chartToken('--text-muted'), font: { family: FONT, size: 13 } }, grid: { color: chartToken('--border') } },
                y: { title: { display: true, text: '', font: { family: FONT, size: 13 } },
                     ticks: { color: chartToken('--text-muted'), font: { family: FONT, size: 13 } }, grid: { color: chartToken('--border') } },
            },
            plugins: { ...commonOpts.plugins, tooltip: { titleFont: { family: FONT, size: 15 }, bodyFont: { family: FONT, size: 15 },
                       callbacks: { title: items => `Day ${items[0].parsed.x.toFixed(2)}` } } },
        },
    });
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
    Object.entries(METRICS).forEach(([chartKey, metric]) => {
        const chart = charts[chartKey];
        chart.data.datasets = Object.entries(channelData)
            .filter(([chId]) => !isHidden(chId))
            .filter(([chId]) => metric !== 'net' || chId !== BLANK_CHANNEL)
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
    Object.entries(METRICS).forEach(([chartKey, metric]) => {
        const chart = charts[chartKey];
        const ds = chart.data.datasets.find(d => d.channelId === channelId);
        if (ds) {
            ds.data = channelData[channelId][metric];
            chart.update('none');
        }
    });
}

// ── CO2 evolution and biodegradation (ISO 14855-1 / ASTM D5338) ──────────────
// The Apps Script keeps, per vessel, the area under (vessel CO2 - blank CO2)
// since TEST_START in ppm x minutes. Grams of CO2 = area x 1e-6 x air flow
// (L/min) x CO2 density; biodegradation = CO2 / ThCO2, with
// ThCO2 = mass x carbon fraction x 44.01/12.011 (eq. 1 and 2 of the paper).
const CO2_MOLAR_MASS = 44.01;
const C_MOLAR_MASS = 12.011;

function co2DensityGPerL() {
    return EVOLUTION.pressure_kpa * 1000 * CO2_MOLAR_MASS / (8.314 * (EVOLUTION.gas_temp_c + 273.15)) / 1000;
}

function thCO2(chId) {
    const m = EVOLUTION.materials[chId];
    if (!m || !m.mass_g || !m.carbon_fraction) return null;
    return m.mass_g * m.carbon_fraction * CO2_MOLAR_MASS / C_MOLAR_MASS;
}

function co2Grams(ppmMin) {
    if (!EVOLUTION.air_flow_ml_min) return null;
    return ppmMin * 1e-6 * EVOLUTION.air_flow_ml_min / 1000 * co2DensityGPerL();
}

async function loadEvolution() {
    let data;
    try {
        data = await fetchSheet({ cumulative: 1 });
    } catch (err) {
        return;
    }
    const note = document.getElementById('evolution-note');
    const cards = document.getElementById('evolution-cards');
    cards.innerHTML = '';
    if (!data.start || !data.latest || !data.latest.utc) {
        note.textContent = data.start
            ? `Counting from ${fmtLocal(data.start)}; waiting for the first readings.`
            : 'Not started: set TEST_START in the Apps Script (Project Settings → Script properties) to the UTC time the vessels were loaded, e.g. 2026-11-05T15:00:00Z.';
        charts.evolution.data.datasets = [];
        charts.evolution.update('none');
        return;
    }

    const start = Date.parse(data.start);
    const haveFlow = !!EVOLUTION.air_flow_ml_min;
    const mode = haveFlow ? 'pct' : 'area';
    const days = (Date.parse(data.latest.utc) - start) / 86400000;
    note.textContent = `Since ${fmtLocal(data.start)} (day ${days.toFixed(1)}). ` + (haveFlow
        ? `Air flow ${EVOLUTION.air_flow_ml_min} mL/min per vessel; CO2 density ${co2DensityGPerL().toFixed(3)} g/L.`
        : 'Enter the measured air flow per vessel in config.js (EVOLUTION.air_flow_ml_min) to convert to grams of CO2 and % biodegradation.');

    const value = (chId, ppmMin) => {
        const g = co2Grams(ppmMin);
        const th = thCO2(chId);
        if (mode === 'pct') return g != null && th ? g / th * 100 : null;
        return ppmMin / 60;   // ppm x h
    };

    Object.keys(data.latest.net_ppm_min).forEach(chId => {
        const ppmMin = data.latest.net_ppm_min[chId];
        const g = co2Grams(ppmMin);
        const th = thCO2(chId);
        const div = document.createElement('div');
        div.className = 'evolution-card';
        div.id = `evo-${chId}`;
        div.innerHTML = `
            <div class="card-role">${escHtml(getChannelRole(chId))}</div>
            <div class="card-name">${escHtml(getChannelLabel({ channel_id: chId }))}</div>
            <div class="metric-row"><span class="metric-label">Net CO<sub>2</sub> evolved</span>
                <span class="metric-value">${g != null ? `${fixed(g, 3)} g` : `${fixed(ppmMin / 60, 0)} ppm·h`}</span></div>
            <div class="metric-row"><span class="metric-label">ThCO<sub>2</sub></span>
                <span class="metric-value">${th ? `${th.toFixed(2)} g` : 'set mass and carbon'}</span></div>
            <div class="metric-row metric-row-net"><span class="metric-label">Biodegradation</span>
                <span class="metric-value">${g != null && th ? `${fixed(g / th * 100, 1)} %` : '-'}</span></div>`;
        cards.appendChild(div);
    });

    charts.evolution.options.scales.y.title.text = mode === 'pct'
        ? 'Biodegradation (net CO2 / ThCO2, %)' : 'Cumulative net CO2 (ppm·h)';
    charts.evolution.data.datasets = data.columns.map((chId, i) => ({
        label: getChannelLabel({ channel_id: chId }),
        data: data.rows.map(r => ({ x: (Date.parse(r[0]) - start) / 86400000, y: value(chId, r[i + 1]) })),
        borderColor: channelColors[chId] || getChannelColor(chId, i),
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
    }));
    charts.evolution.update('none');
}

// toFixed without "-0.000" for values that round to zero
function fixed(v, digits) {
    const s = Number(v).toFixed(digits);
    return Number(s) === 0 ? Number(0).toFixed(digits) : s;
}

function fmtLocal(utc) {
    return new Date(utc).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric',
        year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
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
