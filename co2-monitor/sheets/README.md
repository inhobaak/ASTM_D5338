# Google Sheets upload

The Pico averages each SCD-30 over every `MEASUREMENT_INTERVAL` (30 s) and,
right after each row (`UPLOAD_INTERVAL`, 30 s), POSTs it to a Google Apps
Script web app that appends it to a spreadsheet. The sheet is the record. If
Wi-Fi or Google is down, rows wait in RAM (up to 4 h) and are sent later.

## Columns

| Column | Meaning |
|---|---|
| `utc` | Row time, UTC (`2026-10-30T15:04:05Z`). Blank until the Pico has synced NTP. |
| `boot` | Random id for this power-up. |
| `uptime_s` | Seconds since that boot. Lets you place rows with a blank `utc`. |
| `<name>_co2_ppm`, `<name>_temp_c`, `<name>_rh` | Mean of the 2 s SCD-30 readings in the interval, per channel. Blank if the sensor gave no data. |

Rows go to a tab per month (`data_2026-10`, ...). Rows that arrive twice
(a retried upload) are skipped.

## Setup (10 min)

1. Create a Google Sheet (e.g. "D5338 CO2 log").
2. **Extensions → Apps Script.** Replace the contents of `Code.gs` with
   [`Code.gs`](Code.gs) from this folder. Save.
3. **Project Settings (gear) → Script Properties → Add property:**
   `TOKEN` = the `SHEETS_TOKEN` value from the Pico's `settings.toml`.
4. **Deploy → New deployment → type: Web app.**
   Execute as: **Me**. Who has access: **Anyone**. Deploy and authorize.
   Copy the **Web app URL** (ends in `/exec`).
5. Open that URL in a browser. You should see
   `{"ok":true,"service":"d5338-co2-logger"}`.
6. Put the URL in the Pico's `settings.toml`:

   ```toml
   SHEETS_URL = "https://script.google.com/macros/s/XXXX/exec"
   ```

   The Pico restarts on save; the first rows appear within `UPLOAD_INTERVAL`.

7. Put the same URL in `docs/config.js` (`SHEETS_URL`) and push, so the
   dashboard on GitHub Pages reads from the sheet.

"Anyone" access is needed because the Pico cannot sign in to Google. The
`TOKEN` check is what stops other people from writing to the sheet, so keep
the token out of public places (GitHub, slides). Reading needs no token: the
dashboard is public, and so is the data behind it.

## Reading the data (dashboard API)

| Request | Returns |
|---|---|
| `/exec` | service name, column names and the newest row |
| `/exec?hours=24` | rows from the last 24 h |
| `/exec?hours=168&step=300` | last 7 days, averaged into 5-minute buckets |
| `/exec?since=2026-11-04T15:00:00Z` | rows newer than that time |

Rows come back as `[utc, blank_co2_ppm, blank_temp_c, blank_rh, ...]`, in
the order given by `columns`; a missing reading is `null`. One request reads
at most 45 days.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit →
New version** so the `/exec` URL stays the same.

## Pausing (ice refill, watering)

The dashboard has a **Pause recording** button. Press it before opening a
vessel or the cold trap, and **Resume recording** once everything is closed.

- The Pico keeps logging raw rows the whole time; nothing is deleted.
- Each pause is a row in the `pauses` tab (`start_utc`, `end_utc`, `note`).
- Rows from the start of a pause until `SETTLE_MIN` minutes after it ends are
  left out of the cumulative CO2. The integral runs straight from the last good
  row before to the first good row after (linear interpolation).
- Gray bands on the charts show paused (dark) and settling (light) time.

Script properties:

| Property | Meaning |
|---|---|
| `CONTROL_KEY` | 4-digit PIN typed on every Pause and Resume (never stored in the browser). After 5 wrong PINs in a row the button locks for 15 min. Keep it out of GitHub. |
| `SETTLE_MIN` | Minutes after a resume still left out (default 15). Use about 3 × headspace volume ÷ air flow, e.g. 0.5 L ÷ 0.1 L/min × 3 = 15 min. |

Forgot to press Pause? Add or fix the row in the `pauses` tab by hand (UTC,
e.g. `2026-11-20T14:05:00Z`). The totals are recounted on the next upload.

## Starting a new test from scratch

In the Apps Script editor, pick **startNewTest** in the function menu and
press **Run**. It:

- deletes every `data_` tab, the `cumulative` tab and the `pauses` tab,
- sets `TEST_START` to that moment, so the CO2 evolution starts at zero,
- drops any older rows the Pico still had queued.

The Pico keeps running; new rows appear in a fresh `data_` tab within 30 s.
Reload the dashboard afterwards. This cannot be undone except through
**File → Version history**, so use **File → Make a copy** first if you want
to keep the old data. It can only be run from the editor, not from the web.

## settings.toml keys

```toml
CIRCUITPY_WIFI_SSID = "..."        # 2.4 GHz, WPA2-Personal or open
CIRCUITPY_WIFI_PASSWORD = "..."    # "" for an open network
SHEETS_URL = "https://script.google.com/macros/s/XXXX/exec"
SHEETS_TOKEN = "..."               # same as the TOKEN script property
CHANNELS = "blank:0,control:1,sample:2"   # column name : TCA9548A port
MEASUREMENT_INTERVAL = "30"        # s per logged row
UPLOAD_INTERVAL = "30"             # s between uploads; keep at 30
TEMP_OFFSET = "2.0"
ALTITUDE_M = "0"                   # building elevation (m) for SCD-30 compensation
# AMBIENT_PRESSURE_MBAR = "985"    # optional; overrides ALTITUDE_M
```

To add vessels, extend `CHANNELS` (e.g. `"blank:0,control:1,rep1:2,rep2:3,rep3:4"`).
A changed channel set starts a new tab header, so check the sheet columns.

## Size limits

A Google spreadsheet holds 10 million cells. Each row uses 3 + 3 × channels
cells:

| Channels | Interval | Cells per 180 days |
|---|---|---|
| 3 | 30 s | 6.2 M |
| 5 | 30 s | 9.3 M (too close; use 60 s) |
| 5 | 60 s | 4.7 M |

## LED

| Pattern | Meaning |
|---|---|
| short flash every interval | row logged |
| long flash | upload accepted |
| 2 fast blinks | upload failed (Wi-Fi, URL or token) — rows are kept |

On unexpected errors `code.py` restarts itself after 30 s instead of
stopping; up to 40 unsent rows are kept in the Pico's built-in memory.
