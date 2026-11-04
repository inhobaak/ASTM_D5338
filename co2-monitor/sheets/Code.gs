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
// Reading needs no token: anyone with the URL can see the data, as on the
// public dashboard. Writing still needs TOKEN.

const TAB_PREFIX = 'data_';
const MAX_HOURS = 24 * 45;   // longest range one request may read
const CHUNK = 5000;          // rows read per call while walking back in time

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
    let added = 0;
    body.rows.forEach(row => {
      const boot = row[1], uptime = Number(row[2]);
      if (boot === lastBoot && uptime <= lastUptime) return;  // already stored
      const month = row[0] ? String(row[0]).slice(0, 7) : 'unsynced';
      (byTab[month] = byTab[month] || []).push(row);
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
