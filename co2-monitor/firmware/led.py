from machine import Pin
import time

_led = Pin("LED", Pin.OUT)


def solid_on(duration_ms=1000):
    _led.on()
    time.sleep_ms(duration_ms)
    _led.off()


def solid_off():
    _led.off()


def blink_buffered():
    """2 fast blinks: data was buffered locally (WiFi issue)."""
    for _ in range(2):
        _led.on()
        time.sleep_ms(100)
        _led.off()
        time.sleep_ms(100)


def blink_reconnecting():
    """3 slow blinks: WiFi reconnect in progress."""
    for _ in range(3):
        _led.on()
        time.sleep_ms(500)
        _led.off()
        time.sleep_ms(500)


def blink_error(duration_ms=2000):
    """Fast continuous blink: I2C or sensor error."""
    end = time.ticks_add(time.ticks_ms(), duration_ms)
    while time.ticks_diff(end, time.ticks_ms()) > 0:
        _led.on()
        time.sleep_ms(50)
        _led.off()
        time.sleep_ms(50)
