import urequests
import json


class DataSender:
    def __init__(self, supabase_url, supabase_key, max_buffer=100):
        self._url = supabase_url.rstrip('/') + '/rest/v1/readings'
        self._headers = {
            'apikey': supabase_key,
            'Authorization': 'Bearer ' + supabase_key,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        }
        self._max_buffer = max_buffer
        self._buffer = []

    @property
    def buffer_count(self):
        return len(self._buffer)

    def send(self, reading):
        resp = None
        try:
            resp = urequests.post(
                self._url,
                data=json.dumps(reading),
                headers=self._headers,
                timeout=10,
            )
            status = resp.status_code
            if status == 201:
                self._drain_buffer()
                return True
            else:
                self._add_to_buffer(reading)
                return False
        except Exception:
            self._add_to_buffer(reading)
            return False
        finally:
            if resp is not None:
                resp.close()

    def _add_to_buffer(self, reading):
        self._buffer.append(reading)
        if len(self._buffer) > self._max_buffer:
            self._buffer.pop(0)  # drop oldest

    def _drain_buffer(self, max_per_call=5):
        # Drain at most max_per_call items per send() cycle so the main loop
        # isn't blocked for minutes after a long WiFi outage.
        drained = 0
        while self._buffer and drained < max_per_call:
            oldest = self._buffer[0]
            resp = None
            try:
                resp = urequests.post(
                    self._url,
                    data=json.dumps(oldest),
                    headers=self._headers,
                    timeout=10,
                )
                status = resp.status_code
                if status == 201:
                    self._buffer.pop(0)
                    drained += 1
                else:
                    break  # stop draining on failure
            except Exception:
                break  # stop draining on network error
            finally:
                if resp is not None:
                    resp.close()
