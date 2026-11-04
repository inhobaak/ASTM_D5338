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

const TAB_PREFIX = 'data_';
const MAX_HOURS = 24 * 45;   // longest range one request may read
const CHUNK = 5000;          // rows read per call while walking back in time
const BLANK = 'blank';       // channel subtracted as the baseline
const CUM_TAB = 'cumulative';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
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
    if (p.cumulative) return reply(readCumulative());
    const hours = Math.min(Number(p.hours) || 24, MAX_HOURS);
    const step = Math.max(Number(p.step) || 0, 0);
    const since = p.since
      ? String(p.since)
      : new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19) + 'Z';

    const data = readSince(since);
    const out = { ok: true, service: 'd5338-co2-logger', columns: data.columns,
                  latest: data.rows.length ? data.rows[data.rows.length - 1] : null };
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

  let st = JSON.parse(props.getProperty('CUM_STATE') || 'null');
  if (!st || st.start !== start) {
    // New test (or TEST_START changed): start over and back-fill from the sheet
    st = { start: start, last_utc: null, last_net: {}, cum: {}, snap: null };
    const tab = getTab(CUM_TAB, ['utc'].concat(vessels.map(v => v + '_net_ppm_min')));
    if (tab.getLastRow() > 1) tab.deleteRows(2, tab.getLastRow() - 1);
    rows = readSince(start).rows.concat(rows);
  }

  const snaps = [];
  rows.forEach(row => {
    const utc = row[0];
    if (utc < start || (st.last_utc && utc <= st.last_utc)) return;
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
