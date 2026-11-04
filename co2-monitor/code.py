import os
import gc
import time
import json
import board
import busio
import digitalio
import rtc
import supervisor
import microcontroller
import wifi
import ssl
import adafruit_connection_manager
import adafruit_requests
import adafruit_ntp
import adafruit_tca9548a
from adafruit_scd30 import SCD30

# ASTM D5338 CO2 logger — Raspberry Pi Pico W, CircuitPython 10
# Every 30 s row is uploaded straight away to a Google Sheet (via an Apps
# Script web app), which is the record. There is no SD card: rows wait in RAM
# while Wi-Fi or Google is down and are lost only if the board restarts then.

# ── Config (from settings.toml) ───────────────────────────────────────────────
def _env(name, default=""):
    value = os.getenv(name)
    return default if value is None else str(value).strip()

WIFI_SSID       = _env("CIRCUITPY_WIFI_SSID")
WIFI_PASSWORD   = _env("CIRCUITPY_WIFI_PASSWORD")
SHEETS_URL      = _env("SHEETS_URL")
SHEETS_TOKEN    = _env("SHEETS_TOKEN")
LOG_INTERVAL    = int(_env("MEASUREMENT_INTERVAL", "30"))   # s between logged rows
UPLOAD_INTERVAL = int(_env("UPLOAD_INTERVAL", "30"))        # s between uploads
TEMP_OFFSET     = float(_env("TEMP_OFFSET", "2.0"))
ALTITUDE_M      = int(_env("ALTITUDE_M", "0"))              # building elevation
PRESSURE_MBAR   = int(_env("AMBIENT_PRESSURE_MBAR", "0"))   # 0 = use altitude
# "name:port,name:port" — name becomes the column prefix, port is the TCA9548A port
CHANNELS = [
    (c.split(":")[0].strip(), int(c.split(":")[1]))
    for c in _env("CHANNELS", "blank:0,control:1,sample:2").split(",")
]

SENSOR_INTERVAL = 2      # SCD-30 runs continuously; readings are averaged per row
MAX_PENDING     = 480    # rows kept in RAM while uploads fail (4 h at 30 s)
BATCH_MAX       = 60     # rows per upload request
NTP_EVERY       = 6 * 3600
WIFI_RETRY      = 60

HEADER = ["utc", "boot", "uptime_s"]
for _name, _ in CHANNELS:
    HEADER += [_name + "_co2_ppm", _name + "_temp_c", _name + "_rh"]

BOOT_ID = "%08x" % int.from_bytes(os.urandom(4), "big")

def now_s():
    # monotonic_ns stays exact for months; float monotonic() loses precision
    return time.monotonic_ns() // 1_000_000_000

# ── LED ───────────────────────────────────────────────────────────────────────
led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

def blink(times, on_ms, off_ms=100):
    for _ in range(times):
        led.value = True;  time.sleep(on_ms / 1000)
        led.value = False; time.sleep(off_ms / 1000)

# ── Sensors (TCA9548A multiplexer) ────────────────────────────────────────────
# Wiring: SDA → GP4, SCL → GP5, VIN → 3V3, GND → GND
tca = None
sensors = {name: None for name, _ in CHANNELS}

def setup_sensors():
    """Called from main(), inside the restart-on-error guard, so a loose
    multiplexer wire at power-up means a retry in 30 s, not a dead logger."""
    global tca
    i2c = busio.I2C(board.GP5, board.GP4, frequency=50000)
    tca = adafruit_tca9548a.TCA9548A(i2c)
    for name, port in CHANNELS:
        try:
            sensors[name] = setup_sensor(port)
            print("SCD-30 ready:", name, "port", port)
        except Exception as e:
            sensors[name] = None
            print("SCD-30 missing:", name, "port", port, e)

def setup_sensor(port):
    s = SCD30(tca[port], ambient_pressure=PRESSURE_MBAR)
    # These settings live in the sensor's flash; only write them when they differ
    if s.self_calibration_enabled:
        s.self_calibration_enabled = False
    if s.measurement_interval != SENSOR_INTERVAL:
        s.measurement_interval = SENSOR_INTERVAL
    if abs(s.temperature_offset - TEMP_OFFSET) > 0.01:
        s.temperature_offset = TEMP_OFFSET
    if not PRESSURE_MBAR and s.altitude != ALTITUDE_M:
        s.altitude = ALTITUDE_M
    return s

# Running sums for the current row: name -> [co2, temp, rh, n]
sums = {name: [0.0, 0.0, 0.0, 0] for name, _ in CHANNELS}

def poll_sensors():
    for name, port in CHANNELS:
        s = sensors[name]
        try:
            if s is None:
                s = sensors[name] = setup_sensor(port)
            if s.data_available:
                acc = sums[name]
                acc[0] += s.CO2
                acc[1] += s.temperature
                acc[2] += s.relative_humidity
                acc[3] += 1
        except Exception as e:
            print("Sensor error:", name, e)
            sensors[name] = None

def take_row():
    row = [utc_now(), BOOT_ID, now_s()]
    for name, _ in CHANNELS:
        co2, temp, rh, n = sums[name]
        if n:
            row += [round(co2 / n, 1), round(temp / n, 2), round(rh / n, 1)]
        else:
            row += ["", "", ""]
        sums[name] = [0.0, 0.0, 0.0, 0]
    return row

# ── Time (UTC only; Sheets/Excel can convert to local) ────────────────────────
def time_synced():
    return time.localtime().tm_year >= 2025

def utc_now(secs=None):
    if not time_synced():
        return ""   # boot + uptime_s still let you place the row later
    t = time.localtime() if secs is None else time.localtime(secs)
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)

# ── Wi-Fi, NTP, Google Sheets ─────────────────────────────────────────────────
_GTS_ROOTS = """-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo
27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w
Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw
TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl
qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH
szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8
Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk
MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92
wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p
aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN
VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb
C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy
h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4
7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J
ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef
MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/
Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT
6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ
0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm
2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb
bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c
-----END CERTIFICATE-----"""   # GTS Root R4 + R1 (script.google.com chains to R4)

pool        = adafruit_connection_manager.get_radio_socketpool(wifi.radio)
ssl_context = ssl.create_default_context()
ssl_context.load_verify_locations(cadata=_GTS_ROOTS)
http        = adafruit_requests.Session(pool, ssl_context)

_next_wifi_try = 0
_last_ntp      = None

def wifi_up():
    global _next_wifi_try
    if wifi.radio.connected:
        return True
    if not WIFI_SSID or now_s() < _next_wifi_try:
        return False
    _next_wifi_try = now_s() + WIFI_RETRY
    try:
        print("Connecting to Wi-Fi", WIFI_SSID, "...")
        wifi.radio.connect(WIFI_SSID, WIFI_PASSWORD, timeout=15)
        print("Wi-Fi connected:", wifi.radio.ipv4_address)
        return True
    except Exception as e:
        print("Wi-Fi failed (rows are kept in RAM):", e)
        return False

def sync_ntp():
    global _last_ntp
    try:
        rtc.RTC().datetime = adafruit_ntp.NTP(pool, tz_offset=0).datetime
        _last_ntp = now_s()
        print("Time synced (UTC):", utc_now())
        # Rows logged before the first sync get their time back from uptime_s
        now_t, now_up = time.time(), now_s()
        for row in pending:
            if row[0] == "" and row[1] == BOOT_ID:
                row[0] = utc_now(now_t - (now_up - row[2]))
    except Exception as e:
        print("NTP failed:", e)

pending = []
upload_failures = 0   # consecutive upload passes that raised a network error
MAX_UPLOAD_FAILURES = 10   # then restart code.py (~5 min at 30 s)

def upload_batch():
    """Send up to BATCH_MAX pending rows. Returns True if the sheet accepted them."""
    batch = pending[:BATCH_MAX]
    body = json.dumps({"token": SHEETS_TOKEN, "header": HEADER, "rows": batch})
    # Apps Script answers POST with a 302 that must be fetched with GET;
    # adafruit_requests would re-POST it, so follow the redirect by hand.
    resp = http.post(SHEETS_URL, data=body, allow_redirects=False, timeout=30,
                     headers={"Content-Type": "application/json"})
    status = resp.status_code
    location = resp.headers.get("location")
    resp.close()
    if status in (301, 302, 303) and location:
        resp = http.get(location, timeout=30)
        status = resp.status_code
    try:
        result = resp.json() if status == 200 else {"ok": False, "error": "HTTP %d" % status}
    except ValueError:
        result = {"ok": False, "error": "non-JSON reply (check SHEETS_URL deployment)"}
    resp.close()
    if result.get("ok"):
        del pending[:len(batch)]
        print("Uploaded", len(batch), "rows; sheet added", result.get("added"))
        return True
    print("Upload rejected:", result.get("error"))
    return False

def upload():
    if not SHEETS_URL or not SHEETS_TOKEN or not pending or not wifi_up():
        return False
    if not time_synced():
        sync_ntp()      # HTTPS certificates can't be checked while the clock reads 2000
        if not time_synced():
            return False
    global upload_failures
    gc.collect()
    try:
        for _ in range(3):               # catch up at most 3 batches per pass
            if not pending or not upload_batch():
                break
        upload_failures = 0
        return not pending
    except Exception as e:
        upload_failures += 1
        print("Upload error:", e, "| free RAM", gc.mem_free(), "| failures", upload_failures)
        # Drop the broken connections; healthy ones stay open between uploads,
        # because the Pico W's network stack fails after ~2 min idle.
        adafruit_connection_manager.connection_manager_close_all(pool)
        gc.collect()
        return False

# ── Keep unsent rows across a restart ─────────────────────────────────────────
# microcontroller.nvm is 4 KB of flash that survives a reset. It is written
# only when code.py restarts after an error, so flash wear is negligible.
def save_pending():
    rows = pending[-40:]
    while rows:
        data = json.dumps(rows).encode()
        if len(data) <= len(microcontroller.nvm) - 2:
            microcontroller.nvm[0:2] = len(data).to_bytes(2, "big")
            microcontroller.nvm[2:2 + len(data)] = data
            print("Saved", len(rows), "unsent rows for after the restart")
            return
        rows = rows[1:]

def restore_pending():
    size = int.from_bytes(microcontroller.nvm[0:2], "big")
    if 0 < size <= len(microcontroller.nvm) - 2:
        try:
            pending.extend(json.loads(bytes(microcontroller.nvm[2:2 + size]).decode()))
            print("Restored", len(pending), "unsent rows from before the restart")
        except ValueError:
            pass
    if size:
        microcontroller.nvm[0:2] = bytes(2)

# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    restore_pending()
    setup_sensors()
    print("Boot", BOOT_ID, "| columns:", ",".join(HEADER))
    if not SHEETS_URL or not SHEETS_TOKEN:
        print("SHEETS_URL / SHEETS_TOKEN not set: nothing will be saved")
    if wifi_up():
        sync_ntp()

    next_row    = now_s() + LOG_INTERVAL
    next_upload = now_s()
    while True:
        poll_sensors()

        if now_s() >= next_row:
            next_row += LOG_INTERVAL
            row = take_row()
            print(row)
            pending.append(row)
            if len(pending) > MAX_PENDING:
                pending.pop(0)            # oldest row is dropped
            blink(1, 150)

            # Upload straight after the row, as the original logger did: the
            # connection never sits idle long enough for the Pico W to drop it.
            if now_s() >= next_upload:
                # Anchor to the row time, not the end of the upload, so a slow
                # upload doesn't push the next one past the next row
                next_upload = now_s() + UPLOAD_INTERVAL - 2
                if wifi_up() and (_last_ntp is None or now_s() - _last_ntp > NTP_EVERY):
                    sync_ntp()
                if upload():
                    blink(1, 400)
                elif SHEETS_URL:
                    blink(2, 100, 100)
                    if upload_failures >= MAX_UPLOAD_FAILURES:
                        raise RuntimeError("uploads failed %d times in a row" % upload_failures)

        time.sleep(0.5)

try:
    main()
except Exception as e:
    # Never stop silently: record the error, wait, and restart code.py
    print("Fatal error, restarting in 30 s:", repr(e))
    try:
        save_pending()
    except Exception as e2:
        print("Could not save unsent rows:", e2)
    time.sleep(30)
    supervisor.reload()
