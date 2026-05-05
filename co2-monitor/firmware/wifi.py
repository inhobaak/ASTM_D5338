import network
import ntptime
import time


class WiFiManager:
    def __init__(self, ssid, password):
        self._ssid = ssid
        self._password = password
        self._wlan = network.WLAN(network.STA_IF)
        self._last_ntp_sync = 0

    def connect(self, timeout=10):
        self._wlan.active(True)
        if not self._wlan.isconnected():
            self._wlan.connect(self._ssid, self._password)
            deadline = time.time() + timeout
            while not self._wlan.isconnected():
                if time.time() > deadline:
                    return False
                time.sleep(0.5)
        self.sync_ntp()
        return True

    def reconnect(self):
        try:
            self._wlan.disconnect()
        except Exception:
            pass
        self._wlan.active(False)
        time.sleep(1)
        self._wlan.active(True)
        return self.connect()

    def is_connected(self):
        return self._wlan.isconnected()

    def sync_ntp(self):
        try:
            ntptime.settime()
        except Exception:
            pass  # NTP can fail transiently; timestamps will be off but system continues
        finally:
            # Always record attempt time to prevent tight retry loop on persistent failure
            self._last_ntp_sync = time.time()

    def needs_ntp_resync(self, interval_s):
        return (time.time() - self._last_ntp_sync) >= interval_s

    def get_iso_timestamp(self):
        t = time.gmtime()
        return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
            t[0], t[1], t[2], t[3], t[4], t[5]
        )
