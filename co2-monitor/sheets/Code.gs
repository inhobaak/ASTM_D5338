// ASTM D5338 CO2 logger — Google Apps Script receiver
// Paste into Extensions → Apps Script of the target spreadsheet, set the
// TOKEN script property, then Deploy → New deployment → Web app
// (Execute as: Me, Who has access: Anyone). See README.md in this folder.
//
// The Pico POSTs JSON:
//   {"token": "...", "header": ["utc","boot","uptime_s","blank_co2_ppm",...],
//    "rows": [["2026-10-30T15:04:05Z","a1b2c3d4",123,812.4,...], ...]}
// Rows go to a monthly tab ("data_2026-10") so no single tab gets huge.
// Rows are de-duplicated on (boot, uptime_s) so a retried batch is safe.
//
// The dashboard (docs/ on GitHub Pages) reads with GET:
//   /exec?hours=24            rows from the last 24 h
//   /exec?hours=168&step=300  last 7 days averaged into 5-minute buckets
//   /exec?since=<utc>         only rows newer than <utc> (live polling)
//   /exec?cumulative=1        cumulative net CO2 since TEST_START (see below)
// Reading needs no token: anyone with the URL can see the data, as on the
// public dashboard. Writing still needs TOKEN.
//
// Cumulative CO2 evolution: set the script property TEST_START to the UTC
// time the vessels were loaded (e.g. 2026-11-05T15:00:00Z). From then on
// every uploaded row adds the area under (vessel CO2 - blank CO2) to a running
// total per vessel, in ppm x minutes (trapezoid rule, also across gaps). The
// dashboard multiplies by the air flow and CO2 density to get grams of CO2.
// A snapshot is stored every 10 min in the "cumulative" tab. Changing
// TEST_START starts the totals again from the new time.
//
// Pausing (ice refill, watering): the dashboard's Pause button POSTs
//   {"action": "pause" | "resume" | "status", "key": CONTROL_KEY, "note": "..."}
// and each pause becomes a row in the "pauses" tab (start_utc, end_utc, note).
// The Pico keeps logging raw data, but rows from the start of a pause until
// SETTLE_MIN minutes (default 15) after it ends are left out of the
// cumulative totals: the trapezoid then runs straight from the last good row
// before the pause to the first good row after it (linear interpolation).
// The settling time covers the headspace refilling with CO2 after the vessel
// was open. Editing the pauses tab by hand recomputes the totals on the next
// upload. Set CONTROL_KEY (the 4-digit PIN asked on every pause and resume)
// in the script properties. After 5 wrong PINs in a row the button is locked
// for 15 minutes.

const TAB_PREFIX = 'data_';
const MAX_HOURS = 24 * 45;   // longest range one request may read
const CHUNK = 5000;          // rows read per call while walking back in time
const BLANK = 'blank';       // channel subtracted as the baseline
const CUM_TAB = 'cumulative';
const PAUSE_TAB = 'pauses';
const SETTLE_MIN_DEFAULT = 15;
const MAX_PIN_TRIES = 5;     // wrong PINs in a row before pausing is locked
const PIN_LOCK_MIN = 15;     // minutes the lock lasts

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action) return reply(control(body));
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return reply({ ok: false, error: 'bad token' });
    if (!Array.isArray(body.header) || !Array.isArray(body.rows)) {
      return reply({ ok: false, error: 'missing header or rows' });
    }

    const props = PropertiesService.getScriptProperties();
    let lastBoot = props.getProperty('LAST_BOOT');
    let lastUptime = Number(props.getProperty('LAST_UPTIME') || -1);

    // Group new rows by month tab; utc is "" until the Pico has synced NTP.
    const byTab = {};
    const fresh = [];
    let added = 0;
    body.rows.forEach(row => {
      const boot = row[1], uptime = Number(row[2]);
      if (boot === lastBoot && uptime <= lastUptime) return;  // already stored
      const month = row[0] ? String(row[0]).slice(0, 7) : 'unsynced';
      (byTab[month] = byTab[month] || []).push(row);
      if (row[0]) fresh.push([String(row[0])].concat(row.slice(3)));
      lastBoot = boot;
      lastUptime = uptime;
      added++;
    });

    Object.keys(byTab).forEach(month => {
      const sheet = getTab(TAB_PREFIX + month, body.header);
      const rows = byTab[month];
      const first = sheet.getLastRow() + 1;
      // Keep utc as text so Sheets doesn't turn it into a local-time date
      sheet.getRange(first, 1, rows.length, 1).setNumberFormat('@');
      sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
    });

    if (added) {
      props.setProperties({ LAST_BOOT: String(lastBoot), LAST_UPTIME: String(lastUptime) });
      try {
        integrate(body.header.slice(3), fresh);
      } catch (err) {
        console.error('cumulative update failed: ' + err);   // never lose an upload over it
      }
    }
    return reply({ ok: true, added: added, skipped: body.rows.length - added });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Opening the bare /exec URL in a browser shows the service name and the
// newest row, which is a quick check that the deployment and the Pico work.
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.cumulative) return reply(Object.assign(readCumulative(), pauseInfo()));
    const hours = Math.min(Number(p.hours) || 24, MAX_HOURS);
    const step = Math.max(Number(p.step) || 0, 0);
    const since = p.since
      ? String(p.since)
      : new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19) + 'Z';

    const data = readSince(since);
    const out = Object.assign({ ok: true, service: 'd5338-co2-logger', columns: data.columns,
                  latest: data.rows.length ? data.rows[data.rows.length - 1] : null }, pauseInfo());
    if (p.hours || p.since) out.rows = step ? average(data.rows, step) : data.rows;
    return reply(out);
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

// Rows with utc > since, oldest first, as [utc, value, value, ...].
// columns lists the value columns (boot and uptime_s are dropped).
function readSince(since) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = ss.getSheets()
    .map(s => s.getName())
    .filter(n => n.indexOf(TAB_PREFIX) === 0 && n !== TAB_PREFIX + 'unsynced'
                 && n.slice(TAB_PREFIX.length) >= since.slice(0, 7))
    .sort().reverse();                       // newest month first

  let columns = null;
  const chunks = [];
  for (const name of tabs) {
    const sheet = ss.getSheetByName(name);
    const width = sheet.getLastColumn();
    const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
    columns = columns || header.slice(3);
    let end = sheet.getLastRow();
    let done = false;
    // Rows are appended in time order, so walk back from the bottom
    while (end > 1 && !done) {
      const start = Math.max(2, end - CHUNK + 1);
      const values = sheet.getRange(start, 1, end - start + 1, width).getValues();
      const keep = [];
      for (const row of values) {
        const utc = row[0] instanceof Date ? row[0].toISOString().slice(0, 19) + 'Z' : String(row[0]);
        if (utc > since) keep.push([utc].concat(row.slice(3).map(v => v === '' ? null : v)));
      }
      if (keep.length < values.length) done = true;
      chunks.push(keep);
      end = start - 1;
    }
    if (done) break;
  }
  const rows = [].concat.apply([], chunks.reverse()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { columns: columns || [], rows: rows };
}

// Average rows into buckets of `step` seconds; the bucket start is the utc.
function average(rows, step) {
  const out = [];
  let key = null, sums = null, counts = null;
  const flush = () => {
    if (!sums) return;
    out.push([new Date(key * 1000).toISOString().slice(0, 19) + 'Z']
      .concat(sums.map((s, i) => counts[i] ? Math.round(s / counts[i] * 100) / 100 : null)));
  };
  for (const row of rows) {
    const k = Math.floor(Date.parse(row[0]) / 1000 / step) * step;
    if (k !== key) {
      flush();
      key = k;
      sums = new Array(row.length - 1).fill(0);
      counts = new Array(row.length - 1).fill(0);
    }
    for (let i = 1; i < row.length; i++) {
      if (typeof row[i] === 'number') { sums[i - 1] += row[i]; counts[i - 1]++; }
    }
  }
  flush();
  return out;
}

// ── Cumulative CO2 evolution ────────────────────────────────────────────────
// columns: value column names (no utc/boot/uptime); rows: [utc, values...]
function integrate(columns, rows) {
  const props = PropertiesService.getScriptProperties();
  const start = props.getProperty('TEST_START');
  if (!start) return;
  const co2 = {};
  columns.forEach((c, i) => { if (/_co2_ppm$/.test(c)) co2[c.replace(/_co2_ppm$/, '')] = i + 1; });
  if (!(BLANK in co2)) return;
  const vessels = Object.keys(co2).filter(ch => ch !== BLANK);

  const pauses = readPauses();
  const excluded = excludedWindows(pauses);
  const isExcluded = utc => excluded.some(w => utc >= w[0] && utc < w[1]);

  let st = JSON.parse(props.getProperty('CUM_STATE') || 'null');
  // A pause that starts before rows already counted means the pauses tab was
  // edited after the fact (or a pause was deleted): count everything again.
  const edited = st && (st.pause_sig || '[]') !== pauseSig(pauses, st.last_utc);
  if (!st || st.start !== start || edited) {
    // New test (or TEST_START changed): start over and back-fill from the sheet
    st = { start: start, last_utc: null, last_net: {}, cum: {}, snap: null };
    const tab = getTab(CUM_TAB, ['utc'].concat(vessels.map(v => v + '_net_ppm_min')));
    if (tab.getLastRow() > 1) tab.deleteRows(2, tab.getLastRow() - 1);
    // readSince is "newer than", so step back 1 s to include a row at start
    rows = readSince(iso(Date.parse(start) - 1000)).rows.concat(rows)
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  }

  const snaps = [];
  rows.forEach(row => {
    const utc = row[0];
    if (utc < start || (st.last_utc && utc <= st.last_utc)) return;
    if (isExcluded(utc)) return;            // paused or settling: bridged by the next good row
    const blank = row[co2[BLANK]];
    if (typeof blank !== 'number') return;
    const net = {};
    vessels.forEach(v => { if (typeof row[co2[v]] === 'number') net[v] = row[co2[v]] - blank; });
    const minutes = st.last_utc ? (Date.parse(utc) - Date.parse(st.last_utc)) / 60000 : 0;
    Object.keys(net).forEach(v => {
      const prev = st.last_net[v];
      st.cum[v] = (st.cum[v] || 0) + (prev == null ? net[v] : (prev + net[v]) / 2) * minutes;
      st.last_net[v] = net[v];
    });
    st.last_utc = utc;
    const slot = utc.slice(0, 15);          // 10-minute slot, e.g. 2026-11-05T15:4
    if (st.snap !== slot) {
      st.snap = slot;
      snaps.push([utc].concat(vessels.map(v => Math.round((st.cum[v] || 0) * 10) / 10)));
    }
  });

  st.pause_sig = pauseSig(pauses, st.last_utc);
  props.setProperty('CUM_STATE', JSON.stringify(st));
  if (snaps.length) {
    const tab = getTab(CUM_TAB, ['utc'].concat(vessels.map(v => v + '_net_ppm_min')));
    const first = tab.getLastRow() + 1;
    tab.getRange(first, 1, snaps.length, 1).setNumberFormat('@');
    tab.getRange(first, 1, snaps.length, snaps[0].length).setValues(snaps);
  }
}

function readCumulative() {
  const props = PropertiesService.getScriptProperties();
  const start = props.getProperty('TEST_START');
  const st = JSON.parse(props.getProperty('CUM_STATE') || 'null');
  const out = { ok: true, start: start || null, columns: [], rows: [], latest: null };
  if (!start || !st || st.start !== start) return out;
  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CUM_TAB);
  if (tab && tab.getLastRow() > 1) {
    const width = tab.getLastColumn();
    const values = tab.getRange(1, 1, tab.getLastRow(), width).getValues();
    out.columns = values[0].slice(1).map(c => String(c).replace(/_net_ppm_min$/, ''));
    out.rows = values.slice(1).map(r => [r[0] instanceof Date ? r[0].toISOString().slice(0, 19) + 'Z' : String(r[0])].concat(r.slice(1)));
  }
  out.latest = { utc: st.last_utc, net_ppm_min: st.cum, net_ppm: st.last_net };
  return out;
}

// ── Pause / resume ──────────────────────────────────────────────────────────
function control(body) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('CONTROL_KEY');
  if (!key) return { ok: false, error: 'CONTROL_KEY is not set in the script properties' };
  // A 4-digit PIN is easy to guess by script, so lock after a few wrong tries
  const fails = JSON.parse(props.getProperty('CONTROL_FAILS') || '{"n":0,"until":0}');
  if (Date.now() < fails.until) {
    return { ok: false, error: 'locked', retry_min: Math.ceil((fails.until - Date.now()) / 60000) };
  }
  if (String(body.key || '') !== String(key).trim()) {
    fails.n++;
    if (fails.n >= MAX_PIN_TRIES) {
      props.setProperty('CONTROL_FAILS', JSON.stringify({ n: 0, until: Date.now() + PIN_LOCK_MIN * 60000 }));
      return { ok: false, error: 'locked', retry_min: PIN_LOCK_MIN };
    }
    props.setProperty('CONTROL_FAILS', JSON.stringify(fails));
    return { ok: false, error: 'bad key', left: MAX_PIN_TRIES - fails.n };
  }
  if (fails.n) props.setProperty('CONTROL_FAILS', JSON.stringify({ n: 0, until: 0 }));

  const tab = getTab(PAUSE_TAB, ['start_utc', 'end_utc', 'note']);
  const n = tab.getLastRow() - 1;
  const values = n > 0 ? tab.getRange(2, 1, n, 3).getValues() : [];
  let open = -1;                            // sheet row of the pause still running
  values.forEach((r, i) => { if (r[0] !== '' && r[1] === '') open = i + 2; });
  const now = iso(Date.now());

  if (body.action === 'pause') {
    if (open < 0) {
      let startUtc = now;
      // never start a pause inside rows that are already counted
      const st = JSON.parse(props.getProperty('CUM_STATE') || 'null');
      if (st && st.last_utc && st.last_utc >= startUtc) startUtc = iso(Date.parse(st.last_utc) + 1000);
      const note = String(body.note || '').replace(/^[=+\-@\s]+/, '').slice(0, 200);
      const row = n + 2;
      tab.getRange(row, 1, 1, 3).setNumberFormat('@');
      tab.getRange(row, 1, 1, 3).setValues([[startUtc, '', note]]);
    }
  } else if (body.action === 'resume') {
    if (open > 0) tab.getRange(open, 2).setNumberFormat('@').setValue(now);
  } else if (body.action !== 'status') {
    return { ok: false, error: 'unknown action' };
  }
  return Object.assign({ ok: true }, pauseInfo());
}

// [{start, end, note}], oldest first; end is null while the pause runs.
function readPauses() {
  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PAUSE_TAB);
  if (!tab || tab.getLastRow() < 2) return [];
  return tab.getRange(2, 1, tab.getLastRow() - 1, 3).getValues()
    .map(r => ({ start: toUtc(r[0]), end: r[1] === '' ? null : toUtc(r[1]), note: String(r[2] || '') }))
    .filter(p => p.start && p.end !== '')
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

function pauseInfo() {
  const pauses = readPauses();
  return { pauses: pauses, paused: pauses.some(p => !p.end), settle_min: settleMinutes() };
}

function settleMinutes() {
  const raw = PropertiesService.getScriptProperties().getProperty('SETTLE_MIN');
  const v = Number(raw);
  return raw !== null && raw !== '' && isFinite(v) && v >= 0 ? v : SETTLE_MIN_DEFAULT;
}

// [from, to) utc ranges left out of the totals: each pause plus settling time
function excludedWindows(pauses) {
  const settle = settleMinutes() * 60000;
  return pauses.map(p => [p.start, p.end ? iso(Date.parse(p.end) + settle) : '9999']);
}

// The pauses that overlap rows already counted, to notice later edits
function pauseSig(pauses, lastUtc) {
  return JSON.stringify(pauses.filter(p => lastUtc && p.start <= lastUtc).map(p => [p.start, p.end]));
}

// Run from the editor to rebuild the totals from the sheet on the next upload
function recomputeEvolution() {
  PropertiesService.getScriptProperties().deleteProperty('CUM_STATE');
}

function toUtc(v) {
  if (v === '' || v == null) return '';
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v).trim());
  return isNaN(t) ? '' : iso(t);
}

function iso(t) {
  return new Date(t).toISOString().slice(0, 19) + 'Z';
}

function getTab(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
