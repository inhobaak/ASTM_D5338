# CO2 logger for ASTM D5338 (CircuitPython)

Three SCD-30 sensors (blank, positive control, sample) on one **Raspberry Pi
Pico W** running **CircuitPython 10**, through a TCA9548A I2C multiplexer.

```
SCD-30 x3 ─ TCA9548A ─ Pico W ──► microSD card   (primary record, every row)
                                 └─► Google Sheets (live copy, via Apps Script)
                                        └─► dashboard on GitHub Pages (docs/)
```

- `code.py` — the logger. Copy it to the CIRCUITPY drive.
- `sheets/` — the Apps Script that stores rows in a Google Sheet and serves
  them to the dashboard. Setup steps are in [sheets/README.md](sheets/README.md).
- `../docs/` — the dashboard site.

**On the CIRCUITPY drive** only `code.py`, `settings.toml` and `lib/` are
needed. `lib/` must contain `adafruit_connection_manager`, `adafruit_requests`,
`adafruit_ntp`, `adafruit_tca9548a`, `adafruit_scd30`, `adafruit_bus_device`
and `adafruit_register` (from the CircuitPython 10.x library bundle).

---

## Wiring

**Multiplexer and sensors (I2C)**

| TCA9548A | Pico W |
|---|---|
| VIN | 3V3 (pin 36) |
| GND | GND (pin 38) |
| SDA | GP4 (pin 6) |
| SCL | GP5 (pin 7) |

Each SCD-30 goes on its own TCA9548A port (SD/SC pairs); the ports are set by
`CHANNELS` in `settings.toml`.

**microSD (Adafruit 5V-ready breakout)**

| Breakout | Pico W |
|---|---|
| 5V | VBUS (pin 40) |
| GND | GND (pin 18) |
| CLK | GP10 (pin 14) |
| DI | GP11 (pin 15) |
| DO | GP12 (pin 16) |
| CS | GP13 (pin 17) |

Solder the headers and keep the wires short; loose pins are the usual cause
of an SD card that drops out. `code.py` remounts the card by itself when it
comes back and writes the rows it held in RAM meanwhile (up to 1 h).

---

## settings.toml

```toml
CIRCUITPY_WIFI_SSID = "RedRover"
CIRCUITPY_WIFI_PASSWORD = ""
SHEETS_URL = "https://script.google.com/macros/s/XXXX/exec"
SHEETS_TOKEN = "..."                       # same as the Apps Script TOKEN property
CHANNELS = "blank:0,control:1,sample:2"    # column name : TCA9548A port
MEASUREMENT_INTERVAL = "30"                # s per logged row
UPLOAD_INTERVAL = "120"                    # s between uploads
TEMP_OFFSET = "2.0"
ALTITUDE_M = "250"                         # building elevation (m)
```

**Wi-Fi:** 2.4 GHz, WPA2-Personal or open. eduroam (WPA2-Enterprise) does not
work on the Pico W. On RedRover, register the Pico's MAC address with Cornell
IT first (it is printed in `boot_out.txt`), otherwise it is held at the sign-in
page and cannot reach Google.

---

## Dashboard

GitHub Pages serves `docs/` from `main`. Put the Apps Script `/exec` URL in
`docs/config.js`:

```js
const SHEETS_URL = "https://script.google.com/macros/s/XXXX/exec";
```

The page loads the chosen range (24 h of 30 s rows, or 7 d / 30 d averaged)
and asks for new rows every minute. Channel names, colours and optional
browser alerts are at the top of `docs/app.js`.

---

## LED

| Pattern | Meaning |
|---|---|
| short flash every interval | row logged |
| long flash | upload accepted |
| 2 fast blinks | upload failed (Wi-Fi, URL or token); rows are kept |

## Troubleshooting

Open the serial console (Thonny, PuTTY, or `screen /dev/ttyACM0 115200`):

- `SD card not available` once a minute: no card, or a loose connection.
- `Wi-Fi failed`: wrong SSID, 5 GHz-only network, or (RedRover) MAC not registered.
- `Upload rejected: bad token`: `SHEETS_TOKEN` differs from the script's `TOKEN`.
- Unexpected errors go to `/sd/errors.log`, and `code.py` restarts itself.
