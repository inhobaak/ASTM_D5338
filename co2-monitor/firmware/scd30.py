import struct
import time


class SCD30:
    I2C_ADDR = 0x61

    CMD_START_MEASUREMENT = b'\x00\x10'
    CMD_STOP_MEASUREMENT  = b'\x01\x04'
    CMD_SET_INTERVAL      = b'\x46\x00'
    CMD_GET_DATA_READY    = b'\x02\x02'
    CMD_READ_MEASUREMENT  = b'\x03\x00'
    CMD_SET_TEMP_OFFSET   = b'\x54\x03'

    def __init__(self, i2c):
        self._i2c = i2c

    def _crc8(self, data):
        crc = 0xFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                crc = (crc << 1) ^ 0x31 if crc & 0x80 else crc << 1
                crc &= 0xFF
        return crc

    def _write_command(self, cmd, arg=None):
        if arg is None:
            self._i2c.writeto(self.I2C_ADDR, cmd)
        else:
            # arg is 2-byte big-endian value; append CRC
            crc = self._crc8(arg)
            self._i2c.writeto(self.I2C_ADDR, cmd + arg + bytes([crc]))

    def _read_register(self, cmd, num_bytes):
        self._i2c.writeto(self.I2C_ADDR, cmd)
        time.sleep_ms(3)
        return self._i2c.readfrom(self.I2C_ADDR, num_bytes)

    def _validate_and_parse_word(self, data, offset):
        word_bytes = data[offset:offset+2]
        crc = data[offset+2]
        if self._crc8(word_bytes) != crc:
            raise ValueError(f"CRC mismatch at offset {offset}")
        return word_bytes

    def start_continuous_measurement(self, pressure_mbar=0):
        arg = struct.pack('>H', pressure_mbar)
        self._write_command(self.CMD_START_MEASUREMENT, arg)

    def stop_measurement(self):
        self._write_command(self.CMD_STOP_MEASUREMENT)

    def set_measurement_interval(self, seconds):
        if not 2 <= seconds <= 1800:
            raise ValueError("Interval must be 2-1800 seconds")
        arg = struct.pack('>H', seconds)
        self._write_command(self.CMD_SET_INTERVAL, arg)

    def set_temperature_offset(self, offset_c):
        if not 0 <= offset_c <= 20:
            raise ValueError("Temperature offset must be 0-20 degrees C")
        val = int(offset_c * 100)
        arg = struct.pack('>H', val)
        self._write_command(self.CMD_SET_TEMP_OFFSET, arg)

    def is_data_ready(self):
        data = self._read_register(self.CMD_GET_DATA_READY, 3)
        word = self._validate_and_parse_word(data, 0)
        return struct.unpack('>H', word)[0] == 1

    def read_measurement(self):
        data = self._read_register(self.CMD_READ_MEASUREMENT, 18)
        results = []
        for i in range(3):
            base = i * 6
            word0 = self._validate_and_parse_word(data, base)
            word1 = self._validate_and_parse_word(data, base + 3)
            value = struct.unpack('>f', word0 + word1)[0]
            results.append(value)
        return tuple(results)  # (co2_ppm, temp_c, humidity_rh)
