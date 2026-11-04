import os
import gc
import time
import json
import board
import busio
import digitalio
import rtc
import sdcardio
import storage
import supervisor
import wifi
import ssl
import adafruit_connection_manager
import adafruit_requests
import adafruit_ntp
import adafruit_tca9548a
from adafruit_scd30 import SCD30

# ASTM D5338 CO2 logger — Raspberry Pi Pico W, CircuitPython 10
# The SD card is the primary record. Google Sheets (via an Apps Script web
# app) is the live copy. Logging to SD never waits on Wi-Fi or Google.

# ── Config (from settings.toml) ───────────────────────────────────────────────
def _env(name, default=""):
    value = os.getenv(name)
    return default if value is None else str(value).strip()

WIFI_SSID       = _env("CIRCUITPY_WIFI_SSID")
WIFI_PASSWORD   = _env("CIRCUITPY_WIFI_PASSWORD")
SHEETS_URL      = _env("SHEETS_URL")
SHEETS_TOKEN    = _env("SHEETS_TOKEN")
LOG_INTERVAL    = int(_env("MEASUREMENT_INTERVAL", "30"))   # s between logged rows
UPLOAD_INTERVAL = int(_env("UPLOAD_INTERVAL", "120"))       # s between uploads
TEMP_OFFSET     = float(_env("TEMP_OFFSET", "2.0"))
ALTITUDE_M      = int(_env("ALTITUDE_M", "0"))              # building elevation
PRESSURE_MBAR   = int(_env("AMBIENT_PRESSURE_MBAR", "0"))   # 0 = use altitude
# "name:port,name:port" — name becomes the column prefix, port is the TCA9548A port
CHANNELS = [
    (c.split(":")[0].strip(), int(c.split(":")[1]))
    for c in _env("CHANNELS", "blank:0,control:1,sample:2").split(",")
]

SENSOR_INTERVAL = 2      # SCD-30 runs continuously; readings are averaged per row
MAX_PENDING     = 240    # rows kept in RAM for upload (2 h at 30 s); SD keeps all
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
i2c = busio.I2C(board.GP5, board.GP4, frequency=50000)
tca = adafruit_tca9548a.TCA9548A(i2c)

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

sensors = {}
for name, port in CHANNELS:
    try:
        sensors[name] = setup_sensor(port)
        print("SCD-30 ready:", name, "port", port)
    except Exception as e:
        sensors[name] = None
        print("SCD-30 missing:", name, "port", port, e)

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

# ── SD card (SPI) ─────────────────────────────────────────────────────────────
# Wiring (Adafruit 5V-ready breakout): CLK → GP10, DI → GP11, DO → GP12,
# CS → GP13, 5V → VBUS, GND → GND
# A card that drops out (loose contact, removed) is remounted automatically;
# rows logged meanwhile wait in RAM and are written once it is back.
SD_BAUD    = 4_000_000   # slower than the 8 MHz default; tolerates longer wires
SD_RETRY   = 60          # s between remount attempts
SD_BACKLOG = 120         # rows held while the card is out (1 h at 30 s)

_spi = busio.SPI(clock=board.GP10, MOSI=board.GP11, MISO=board.GP12)
_sd = None
SD_PATH = None
_next_sd_try = 0
sd_backlog = []

def sd_unmount():
    global _sd, SD_PATH
    SD_PATH = None
    try:
        storage.umount("/sd")
    except Exception:
        pass
    if _sd:
        try:
            _sd.deinit()
        except Exception:
            pass
        _sd = None

def sd_mount():
    """(Re)mount the card and pick the log file. Returns True when ready."""
    global _sd, SD_PATH
    sd_unmount()
    try:
        _sd = sdcardio.SDCard(_spi, board.GP13, baudrate=SD_BAUD)
        storage.mount(storage.VfsFat(_sd), "/sd")
        path = "/sd/d5338_log.csv"
        header_line = ",".join(HEADER)
        try:
            with open(path) as f:
                if f.readline().strip() != header_line:
                    path = "/sd/d5338_log_" + BOOT_ID + ".csv"   # channel set changed
        except OSError:
            pass
        try:
            os.stat(path)
        except OSError:
            with open(path, "w") as f:
                f.write(header_line + "\n")
        SD_PATH = path
        print("SD logging to", SD_PATH)
        return True
    except Exception as e:
        print("SD card not available:", e)
        sd_unmount()
        return False

def log_to_sd(row):
    global _next_sd_try
    sd_backlog.append(row)
    if len(sd_backlog) > SD_BACKLOG:
        sd_backlog.pop(0)
    if not SD_PATH:
        if now_s() < _next_sd_try:
            return
        _next_sd_try = now_s() + SD_RETRY
        if not sd_mount():
            return
    try:
        with open(SD_PATH, "a") as f:
            f.write("".join(",".join(str(v) for v in r) + "\n" for r in sd_backlog))
        sd_backlog.clear()
    except Exception as e:
        print("SD write error, will remount:", e)
        sd_unmount()

sd_mount()

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
        print("Wi-Fi failed (logging to SD continues):", e)
        return False

def sync_ntp():
    global _last_ntp
    try:
        rtc.RTC().datetime = adafruit_ntp.NTP(pool, tz_offset=0).datetime
        _last_ntp = now_s()
        print("Time synced (UTC):", utc_now())
        # Rows logged before the first sync get their time back from uptime_s
        now_t, now_up = time.time(), now_s()
        for row in pending + sd_backlog:
            if row[0] == "" and row[1] == BOOT_ID:
                row[0] = utc_now(now_t - (now_up - row[2]))
    except Exception as e:
        print("NTP failed:", e)

pending = []
upload_failures = 0   # consecutive upload passes that raised a network error

def reset_wifi():
    """Drop every socket and power-cycle the radio. After a while the Pico W
    can get stuck failing every connection (ECONNABORTED) until this is done."""
    global _next_wifi_try
    print("Resetting Wi-Fi after", upload_failures, "failed uploads")
    adafruit_connection_manager.connection_manager_close_all(pool)
    wifi.radio.enabled = False
    time.sleep(1)
    wifi.radio.enabled = True
    _next_wifi_try = 0          # reconnect on the next upload pass

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
        return False
    finally:
        # Google drops idle connections long before the next upload, and two
        # open TLS sessions take most of the RAM; start fresh every time.
        adafruit_connection_manager.connection_manager_close_all(pool)
        gc.collect()

# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    print("Boot", BOOT_ID, "| columns:", ",".join(HEADER))
    if not SHEETS_URL or not SHEETS_TOKEN:
        print("SHEETS_URL / SHEETS_TOKEN not set: logging to SD only")
    if wifi_up():
        sync_ntp()

    next_row    = now_s() + LOG_INTERVAL
    next_upload = now_s() + UPLOAD_INTERVAL
    while True:
        poll_sensors()

        if now_s() >= next_row:
            next_row += LOG_INTERVAL
            row = take_row()
            print(row)
            log_to_sd(row)
            pending.append(row)
            if len(pending) > MAX_PENDING:
                pending.pop(0)            # still on SD
            blink(1, 50)

        if now_s() >= next_upload:
            next_upload = now_s() + UPLOAD_INTERVAL
            if wifi_up() and (_last_ntp is None or now_s() - _last_ntp > NTP_EVERY):
                sync_ntp()
            if upload():
                blink(1, 400)
            elif SHEETS_URL:
                blink(2, 100, 100)
                # Network errors: reset Wi-Fi after 2 and 4 failed passes; if
                # it still fails, restart code.py (rows already on SD are kept)
                if upload_failures >= 6:
                    raise RuntimeError("uploads failed %d times in a row" % upload_failures)
                if upload_failures in (2, 4):
                    reset_wifi()

        time.sleep(0.5)

try:
    main()
except Exception as e:
    # Never stop silently: record the error, wait, and restart code.py
    print("Fatal error, restarting in 30 s:", repr(e))
    try:
        with open("/sd/errors.log", "a") as f:
            f.write("{} {} {}\n".format(utc_now(), BOOT_ID, repr(e)))
    except Exception:
        pass
    time.sleep(30)
    supervisor.reload()
