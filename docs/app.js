const ASTM_CHANNELS = {
    'pico-ch-01': { label: 'Blank', role: 'Background reference', colorVar: '--blank' },
    'pico-ch-02': { label: "Jack's candy", role: 'Positive control', colorVar: '--positive' },
    'pico-ch-03': { label: 'PPG-based polyurethane', role: 'Test material', colorVar: '--sample' },
};

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const alertLastFired = {};
const ALERT_LOG_MAX = 50;

let supabaseClient;
let charts = {};
let channelColors = {};
let alertRules = [];
let channelData = {};
let selectedRange = '24h';
let alertBannerTimeout;

document.addEventListener('DOMContentLoaded', async () => {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    initCharts();
    await loadAlertRules();
    await loadChannels();
    await loadHistoricalData();
    subscribeRealtime();
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

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});

async function loadAlertRules() {
    const { data } = await supabaseClient
        .from('alert_rules')
        .select('*')
        .eq('is_active', true);
    if (data) alertRules = data;
}

async function loadChannels() {
    const { data } = await supabaseClient
        .from('channel_status')
        .select('*');
    if (!data) return;

    const container = document.getElementById('channel-cards');
    container.innerHTML = '';

    data.forEach((ch, i) => {
        channelColors[ch.channel_id] = getChannelColor(ch.channel_id, i);
        channelData[ch.channel_id] = { co2: [], temp: [], humidity: [] };
        if (isHidden(ch.channel_id)) return;
        container.appendChild(buildChannelCard(ch));
    });
}

async function loadHistoricalData() {
    const now = new Date();
    const since = selectedRange === '7d'
        ? new Date(now - 7 * 24 * 3600 * 1000).toISOString()
        : new Date(now - 24 * 3600 * 1000).toISOString();

    const { data } = await supabaseClient
        .from('readings')
        .select('channel_id, co2_ppm, temp_c, humidity_rh, recorded_at')
        .gte('recorded_at', since)
        .order('recorded_at', { ascending: true })
        .range(0, 49999);

    if (!data) return;

    Object.values(channelData).forEach(d => {
        d.co2 = []; d.temp = []; d.humidity = [];
    });

    const rows = selectedRange === '7d' ? downsample5min(data) : data;

    rows.forEach(r => {
        if (!channelData[r.channel_id]) return;
        if (isHidden(r.channel_id)) return;
        const t = new Date(r.recorded_at);
        channelData[r.channel_id].co2.push({ x: t, y: r.co2_ppm });
        channelData[r.channel_id].temp.push({ x: t, y: r.temp_c });
        channelData[r.channel_id].humidity.push({ x: t, y: r.humidity_rh });
    });

    rebuildChartDatasets();
}

function subscribeRealtime() {
    supabaseClient
        .channel('readings-live')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'readings' },
            payload => handleNewReading(payload.new)
        )
        .subscribe();
}

function handleNewReading(r) {
    if (!channelData[r.channel_id]) return;
    if (isHidden(r.channel_id)) return;

    const t = new Date(r.recorded_at);
    channelData[r.channel_id].co2.push({ x: t, y: r.co2_ppm });
    channelData[r.channel_id].temp.push({ x: t, y: r.temp_c });
    channelData[r.channel_id].humidity.push({ x: t, y: r.humidity_rh });

    const cutoff = selectedRange === '7d'
        ? Date.now() - 7 * 24 * 3600 * 1000
        : Date.now() - 24 * 3600 * 1000;
    ['co2', 'temp', 'humidity'].forEach(k => {
        channelData[r.channel_id][k] = channelData[r.channel_id][k]
            .filter(p => p.x.getTime() >= cutoff);
    });

    updateChartDataset(r.channel_id);
    updateChannelCard(r);
    checkAlertThresholds(r);
}

function buildChannelCard(ch) {
    const div = document.createElement('div');
    div.className = `channel-card ${escHtml(ch.status || 'offline')}`;
    div.id = `card-${CSS.escape(ch.channel_id)}`;
    div.dataset.lastSeen = ch.last_reading_at || '';
    div.dataset.role = getChannelLabel(ch);

    const co2 = ch.last_co2_ppm != null ? ch.last_co2_ppm.toFixed(0) : '-';
    const temp = ch.last_temp_c != null ? ch.last_temp_c.toFixed(1) : '-';
    const hum = ch.last_humidity_rh != null ? ch.last_humidity_rh.toFixed(1) : '-';
    const lastSeen = ch.last_reading_at ? timeAgo(new Date(ch.last_reading_at)) : 'never';
    const channelLabel = getChannelLabel(ch);
    const channelRole = getChannelRole(ch.channel_id);

    div.innerHTML = `
        <div class="card-header">
            <div>
                <div class="card-role">${escHtml(channelRole)}</div>
                <div class="card-name">${escHtml(channelLabel)}</div>
                <div class="card-location">${escHtml(ch.location || ch.channel_id)}</div>
            </div>
            <div class="status-dot"></div>
        </div>
        <div class="metric-row">
            <span class="metric-label">CO<sub>2</sub> ppm</span>
            <span class="metric-value co2-val">${co2} ppm</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Temperature</span>
            <span class="metric-value">${temp} deg C</span>
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
    card.className = `channel-card online`;

    card.querySelector('.co2-val').textContent = `${Number(r.co2_ppm).toFixed(0)} ppm`;
    card.querySelectorAll('.metric-value')[1].textContent = `${Number(r.temp_c).toFixed(1)} deg C`;
    card.querySelectorAll('.metric-value')[2].textContent = `${Number(r.humidity_rh).toFixed(1)} %`;
    card.querySelector('.last-seen').textContent = `Last: just now`;
}

function startOfflineCheck() {
    setInterval(() => {
        document.querySelectorAll('.channel-card').forEach(card => {
            const lastSeen = card.dataset.lastSeen;
            if (!lastSeen) return;
            const ageMs = Date.now() - new Date(lastSeen).getTime();
            const ageMins = ageMs / 60000;
            if (ageMins > 10) {
                card.className = 'channel-card offline';
                card.querySelector('.last-seen').textContent =
                    `Last: ${timeAgo(new Date(lastSeen))}`;
            } else if (ageMins > 2) {
                card.className = 'channel-card stale';
            }
        });
    }, 60000);
}

function initCharts() {
    const commonOpts = {
        responsive: true,
        maintainAspectRatio: true,
        animation: false,
        spanGaps: false,
        scales: {
            x: {
                type: 'time',
                time: { tooltipFormat: 'MMM d, HH:mm' },
                ticks: { color: chartToken('--text-muted'), maxTicksLimit: 8 },
                grid: { color: chartToken('--border') },
            },
            y: {
                ticks: { color: chartToken('--text-muted') },
                grid: { color: chartToken('--border') },
            },
        },
        plugins: {
            legend: { labels: { color: chartToken('--text'), boxWidth: 12 } },
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
                borderWidth: 1.5,
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

function checkAlertThresholds(r) {
    alertRules.forEach(rule => {
        if (rule.channel_id && rule.channel_id !== r.channel_id) return;
        const value = rule.metric === 'co2_ppm' ? r.co2_ppm
                    : rule.metric === 'temp_c' ? r.temp_c
                    : r.humidity_rh;
        if (value == null) return;

        const triggered = rule.direction === 'above'
            ? value > rule.threshold
            : value < rule.threshold;

        if (!triggered) return;

        const cooldownKey = `${rule.id}|${r.channel_id}`;
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

function downsample5min(rows) {
    const buckets = {};
    rows.forEach(r => {
        const t = new Date(r.recorded_at);
        const bucket = Math.floor(t.getTime() / (5 * 60 * 1000)) * 5 * 60 * 1000;
        const key = `${r.channel_id}|${bucket}`;
        if (!buckets[key]) {
            buckets[key] = { ...r, recorded_at: new Date(bucket).toISOString(), _n: 0,
                co2_ppm: 0, temp_c: 0, humidity_rh: 0 };
        }
        buckets[key].co2_ppm += r.co2_ppm;
        buckets[key].temp_c += r.temp_c;
        buckets[key].humidity_rh += r.humidity_rh;
        buckets[key]._n += 1;
    });
    return Object.values(buckets).map(b => ({
        ...b,
        co2_ppm: b.co2_ppm / b._n,
        temp_c: b.temp_c / b._n,
        humidity_rh: b.humidity_rh / b._n,
    })).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
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
