# CO2 Monitor - Configuration
# Edit these values before uploading to your Pico WH

# WiFi credentials
WIFI_SSID = "YOUR_SSID"
WIFI_PASSWORD = "YOUR_PASSWORD"

# Supabase project credentials
# Get these from: Supabase Dashboard > Settings > API
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
SUPABASE_KEY = "YOUR_ANON_KEY"

# Device identity - must be unique per Pico device
# Use: pico-ch-01, pico-ch-02, ... pico-ch-05
CHANNEL_ID = "pico-ch-01"

# SCD-30 temperature self-heating compensation (degrees C)
# The SCD-30 runs ~2-3C hotter than ambient due to its internal heater
# Increase this value if temperature reads too high
TEMP_OFFSET = 2.0

# Sensor measurement interval in seconds (minimum 2, recommended 30)
MEASUREMENT_INTERVAL = 30

# Maximum number of readings to buffer locally when WiFi is unavailable
# Each reading ~200 bytes; 100 readings = ~50 minutes of buffering
MAX_BUFFER = 100

# HTTP request timeout in seconds
SEND_TIMEOUT = 10

# WiFi connection timeout in seconds
WIFI_TIMEOUT = 10

# NTP re-sync interval in seconds (default: 6 hours)
NTP_SYNC_INTERVAL = 21600
