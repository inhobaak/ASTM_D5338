import os
import time
import board
import busio
import wifi
import socketpool
import ssl
import rtc
import digitalio
import sdcardio
import storage
import adafruit_requests
import adafruit_ntp
from adafruit_scd30 import SCD30

# ── Config (from settings.toml) ───────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
CHANNEL_ID   = os.getenv("CHANNEL_ID", "pico-ch-01")
TEMP_OFFSET  = float(os.getenv("TEMP_OFFSET", "2.0"))
INTERVAL     = int(os.getenv("MEASUREMENT_INTERVAL", "30"))
MAX_BUFFER   = 100

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_KEY in settings.toml")
    led = digitalio.DigitalInOut(board.LED)
    led.direction = digitalio.Direction.OUTPUT
    while True:
        for _ in range(5):
            led.value = True;  time.sleep(0.1)
            led.value = False; time.sleep(0.1)
        time.sleep(2)

# ── LED ───────────────────────────────────────────────────────────────────────
led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

def blink(times, on_ms, off_ms=100):
    for _ in range(times):
        led.value = True;  time.sleep(on_ms / 1000)
        led.value = False; time.sleep(off_ms / 1000)

# ── WiFi ──────────────────────────────────────────────────────────────────────
print("Connecting to WiFi...")
blink(3, 500, 500)
wifi.radio.connect(
    os.getenv("CIRCUITPY_WIFI_SSID"),
    os.getenv("CIRCUITPY_WIFI_PASSWORD"),
)
print("Connected:", wifi.radio.ipv4_address)

pool        = socketpool.SocketPool(wifi.radio)
ssl_context = ssl.create_default_context()
http        = adafruit_requests.Session(pool, ssl_context)

# ── NTP time sync ─────────────────────────────────────────────────────────────
def sync_ntp():
    try:
        ntp = adafruit_ntp.NTP(pool, tz_offset=0)
        rtc.RTC().datetime = ntp.datetime
        print("Time synced:", time.localtime()[:6])
    except Exception as e:
        print("NTP failed (timestamps may be off):", e)
    # Always record attempt time to prevent tight retry loop
    return time.monotonic()

_last_ntp = sync_ntp()

def get_timestamp():
    t = time.localtime()
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)

# ── SD card (SPI) ────────────────────────────────────────────────────────────
# Default wiring: CLK→GP10, MOSI→GP11, MISO→GP12, CS→GP13
_sd_mounted = False
try:
    _spi = busio.SPI(clock=board.GP10, MOSI=board.GP11, MISO=board.GP12)
    _cs  = digitalio.DigitalInOut(board.GP13)
    _sd  = sdcardio.SDCard(_spi, _cs)
    storage.mount(storage.VfsFat(_sd), "/sd")
    _sd_mounted = True
    print("SD card mounted at /sd")
except Exception as e:
    print("SD card not available:", e)

def log_to_sd(reading):
    if not _sd_mounted:
        return
    try:
        path = "/sd/co2_log.csv"
        write_header = True
        try:
            os.stat(path)
            write_header = False
        except OSError:
            pass
        with open(path, "a") as f:
            if write_header:
                f.write("recorded_at,channel_id,co2_ppm,temp_c,humidity_rh\n")
            f.write("{},{},{},{},{}\n".format(
                reading["recorded_at"], reading["channel_id"],
                reading["co2_ppm"], reading["temp_c"], reading["humidity_rh"]))
    except Exception as e:
        print("SD write error:", e)

# ── Sensor ────────────────────────────────────────────────────────────────────
# Wiring: SDA → GP0 (pin 1), SCL → GP1 (pin 2), VIN → 3V3, GND → GND
i2c    = busio.I2C(board.GP1, board.GP0)
sensor = SCD30(i2c)
sensor.measurement_interval = INTERVAL
sensor.temperature_offset   = TEMP_OFFSET
print(f"SCD-30 ready on channel '{CHANNEL_ID}'")

# ── HTTP POST with local buffer ───────────────────────────────────────────────
_url     = SUPABASE_URL.rstrip("/") + "/rest/v1/readings"
_headers = {
    "apikey":        SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal",
}
_buffer = []

def _post(reading):
    resp = http.post(_url, json=reading, headers=_headers)
    ok   = resp.status_code == 201
    resp.close()
    return ok

def send(reading):
    sent = False
    try:
        sent = _post(reading)
        if sent:
            drained = 0
            while _buffer and drained < 5:
                if _post(_buffer[0]):
                    _buffer.pop(0); drained += 1
                else:
                    break
            return True
    except Exception as e:
        print("Send error:", e)
    if not sent:
        _buffer.append(reading)
        if len(_buffer) > MAX_BUFFER:
            _buffer.pop(0)
    return False

# ── Main loop ─────────────────────────────────────────────────────────────────
while True:
    loop_start = time.monotonic()

    # Re-sync NTP every 6 hours
    if time.monotonic() - _last_ntp > 21600:
        _last_ntp = sync_ntp()

    if not sensor.data_available:
        time.sleep(1)
        continue

    try:
        reading = {
            "channel_id":  CHANNEL_ID,
            "co2_ppm":     round(sensor.CO2, 1),
            "temp_c":      round(sensor.temperature, 1),
            "humidity_rh": round(sensor.relative_humidity, 1),
            "recorded_at": get_timestamp(),
        }
    except Exception as e:
        print("Sensor read error:", e)
        blink(10, 50, 50)
        time.sleep(5)
        continue

    print(reading)
    log_to_sd(reading)
    ok = send(reading)

    if ok and not _buffer:
        blink(1, 500)          # solid flash = sent OK
    else:
        blink(2, 100, 100)     # 2 fast blinks = buffered / WiFi issue

    elapsed = time.monotonic() - loop_start
    time.sleep(max(0, INTERVAL - elapsed))
