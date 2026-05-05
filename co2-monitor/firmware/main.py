from machine import Pin, I2C
import time

import config
import scd30 as scd30_mod
import wifi as wifi_mod
import sender as sender_mod
import led

# ── Hardware init ────────────────────────────────────────────────────────────

i2c = I2C(0, sda=Pin(0), scl=Pin(1), freq=100_000)

sensor = scd30_mod.SCD30(i2c)
sensor.set_temperature_offset(config.TEMP_OFFSET)
sensor.set_measurement_interval(config.MEASUREMENT_INTERVAL)
sensor.start_continuous_measurement()

# ── Network + cloud init ──────────────────────────────────────────────────────

wifi_mgr = wifi_mod.WiFiManager(config.WIFI_SSID, config.WIFI_PASSWORD)
data_sender = sender_mod.DataSender(
    config.SUPABASE_URL, config.SUPABASE_KEY, config.MAX_BUFFER
)

print("Connecting to WiFi...")
led.blink_reconnecting()
if wifi_mgr.connect(timeout=config.WIFI_TIMEOUT):
    print("WiFi connected")
else:
    print("WiFi connect failed — will retry in main loop")

# ── Main loop ─────────────────────────────────────────────────────────────────

while True:
    loop_start = time.time()

    # Ensure WiFi is up
    if not wifi_mgr.is_connected():
        print("WiFi lost — reconnecting...")
        led.blink_reconnecting()
        wifi_mgr.reconnect()

    # Periodic NTP re-sync
    if wifi_mgr.is_connected() and wifi_mgr.needs_ntp_resync(config.NTP_SYNC_INTERVAL):
        wifi_mgr.sync_ntp()

    # Wait for sensor data ready
    try:
        if not sensor.is_data_ready():
            time.sleep(1)
            continue
    except Exception as e:
        print("Sensor ready check error:", e)
        led.blink_error()
        time.sleep(5)
        continue

    # Read sensor
    try:
        co2, temp, humidity = sensor.read_measurement()
    except Exception as e:
        print("Sensor read error:", e)
        led.blink_error()
        time.sleep(5)
        continue

    # Build reading payload
    reading = {
        "channel_id": config.CHANNEL_ID,
        "co2_ppm": round(co2, 1),
        "temp_c": round(temp, 1),
        "humidity_rh": round(humidity, 1),
        "recorded_at": wifi_mgr.get_iso_timestamp(),
    }

    print("Reading:", reading)

    # Send (with local buffer fallback)
    success = data_sender.send(reading)

    if success and data_sender.buffer_count == 0:
        led.solid_on(500)
    else:
        led.blink_buffered()
        if not success:
            print("Buffered. Queue size:", data_sender.buffer_count)

    # Sleep until next measurement interval
    elapsed = time.time() - loop_start
    sleep_secs = max(0, config.MEASUREMENT_INTERVAL - elapsed)
    time.sleep(sleep_secs)
