# Google Sheets upload

The Pico averages each SCD-30 over every `MEASUREMENT_INTERVAL` (30 s) and
writes one row to the SD card (`/sd/d5338_log.csv`, the primary record).
Every `UPLOAD_INTERVAL` (120 s) it POSTs the new rows to a Google Apps Script
web app that appends them to a spreadsheet. If Wi-Fi or Google is down, rows
wait in RAM (up to 2 h) and are sent later; the SD card always has everything.

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

## settings.toml keys

```toml
CIRCUITPY_WIFI_SSID = "..."        # 2.4 GHz, WPA2-Personal or open
CIRCUITPY_WIFI_PASSWORD = "..."    # "" for an open network
SHEETS_URL = "https://script.google.com/macros/s/XXXX/exec"
SHEETS_TOKEN = "..."               # same as the TOKEN script property
CHANNELS = "blank:0,control:1,sample:2"   # column name : TCA9548A port
MEASUREMENT_INTERVAL = "30"        # s per logged row
UPLOAD_INTERVAL = "120"            # s between uploads
TEMP_OFFSET = "2.0"
ALTITUDE_M = "0"                   # building elevation (m) for SCD-30 compensation
# AMBIENT_PRESSURE_MBAR = "985"    # optional; overrides ALTITUDE_M
```

To add vessels, extend `CHANNELS` (e.g. `"blank:0,control:1,rep1:2,rep2:3,rep3:4"`).
A changed channel set starts a new SD file so columns never mix.

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

Unexpected errors are written to `/sd/errors.log` and `code.py` restarts
itself after 30 s instead of stopping.
