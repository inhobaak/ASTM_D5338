# CO2 Sensor Monitor (CircuitPython)

Single-channel CO2, temperature, and humidity monitoring using an SCD-30 sensor on a **Raspberry Pi Pico W** running **CircuitPython 10**. Readings are sent over WiFi to Supabase and displayed on a live web dashboard — 100% free.

---

## What you need

| Part | Notes |
|------|-------|
| Raspberry Pi Pico W | CircuitPython 10 already flashed |
| Sensirion SCD-30 | CO2 + temperature + humidity, I2C |
| USB cable | Data cable (not charge-only) |

---

## Wiring

```
SCD-30   →   Pico W
VIN      →   3V3  (pin 36)
GND      →   GND  (pin 38)
SDA      →   GP0  (pin 1)
SCL      →   GP1  (pin 2)
```

Most SCD-30 breakout boards (Adafruit, SparkFun) include I2C pull-up resistors. If using a bare module, add 10 kΩ pull-ups from SDA and SCL to 3V3.

---

## Step-by-step setup

### Step 1 — Supabase (5 min)

1. Go to [supabase.com](https://supabase.com) → create a free account → **New project**
2. Open **SQL Editor** → paste and run `database/schema.sql`
3. Run `database/seed.sql`
4. Go to **Settings → API** → copy:
   - **Project URL** (looks like `https://abcdef.supabase.co`)
   - **anon / public key** (long string starting with `eyJ`)

### Step 2 — Fill in settings.toml

Open `D:\settings.toml` (the CIRCUITPY drive) in any text editor and replace the placeholder values:

```toml
CIRCUITPY_WIFI_SSID = "YourWiFiName"
CIRCUITPY_WIFI_PASSWORD = "YourWiFiPassword"
SUPABASE_URL = "https://abcdef.supabase.co"
SUPABASE_KEY = "eyJ..."
CHANNEL_ID = "pico-ch-01"
TEMP_OFFSET = "2.0"
MEASUREMENT_INTERVAL = "30"
```

> **WiFi must be WPA2-PSK** (standard home/lab network).
> WPA2-Enterprise (eduroam) is not supported by the Pico W.

Save the file. The Pico W **automatically reboots** and starts running — no Thonny needed.

### Step 3 — Deploy the dashboard

1. Edit `dashboard/config.js` — add the same Supabase URL and anon key
2. Push the `co2-monitor` folder to a GitHub repository
3. Go to **Settings → Pages** → source: branch `main`, folder `/dashboard`
4. GitHub gives you a URL like `https://yourusername.github.io/co2-monitor`

### Step 4 — Verify

1. Wire up the SCD-30 (see wiring table above)
2. Plug the Pico W into USB power (any USB charger works once programmed)
3. Watch the LED — it should blink 3 times slowly (connecting to WiFi), then give one solid flash every 30 seconds (reading sent)
4. Open your GitHub Pages URL — the channel card should appear as **online** within a minute

---

## LED status

| Pattern | Meaning |
|---------|---------|
| 3 slow blinks at startup | Connecting to WiFi |
| 1 solid flash (every 30 s) | Reading sent successfully ✓ |
| 2 fast blinks | WiFi down — data buffered locally |
| 10 rapid blinks | SCD-30 read error — check wiring |

The Pico W buffers up to 100 readings (~50 min) in RAM if WiFi drops. They are automatically sent when connectivity returns.

---

## Adjusting temperature offset

The SCD-30's internal heater causes the temperature reading to be ~2–3 °C above the true ambient. `TEMP_OFFSET = "2.0"` compensates for this. If your temperature reads too high or too low compared to a reference thermometer, adjust this value in `settings.toml`.

---

## Expanding to multiple channels (later)

When you're ready to add more sensors, you have two options:

**Option A — Additional Pico W per sensor** (simplest):
- Flash another Pico W with the same code
- Change `CHANNEL_ID = "pico-ch-02"` in its `settings.toml`
- The dashboard auto-discovers new channels

**Option B — TCA9548A I2C multiplexer on one Pico W** (saves hardware):
- Connect all SCD-30 sensors to the TCA9548A multiplexer
- Replace `code.py` on the device with a multichannel version that iterates over TCA9548A ports

---

## Data retention

Readings are kept for 90 days in Supabase. To manually free space, run this in the Supabase SQL Editor:

```sql
SELECT prune_old_readings();
```

---

## Free tier limits

| Service | Limit | Usage (1 channel) |
|---------|-------|-------------------|
| Supabase DB | 500 MB | ~26 MB at 90 days |
| Supabase API | Unlimited | ~2,880 inserts/day |
| GitHub Pages | 100 GB/month | < 1 GB |

No credit card required.

---

## Troubleshooting

**Pico reboots repeatedly / code error:**
Connect via USB and open a serial terminal (Thonny, PuTTY, or `screen /dev/ttyACM0 115200`) to see the error output.

**LED stays off after startup:**
Check `settings.toml` — if WiFi credentials are wrong the code may crash silently. Verify the file saved correctly.

**Dashboard shows channel as offline:**
No reading in 10+ minutes. Check the Pico LED pattern. Also check your Supabase project hasn't paused (it pauses after 1 week of inactivity — visit supabase.com to unpause).

**Temperature reads 2–3 °C too high:**
Increase `TEMP_OFFSET` in `settings.toml` (e.g., try `"3.0"`).
