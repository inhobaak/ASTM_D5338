// Web app URL of the Apps Script in co2-monitor/sheets/Code.gs (ends in /exec).
// It only allows reading here; uploads need the token kept on the Pico.
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyZ4nluHTgFrKw4tZzZJwN3rBjiMWDRkG3MltI8veDvDN_7V9YzldyUInIpVawcHypJ/exec";

// How often the page asks for new rows. The Pico uploads every 30 s.
const REFRESH_SECONDS = 30;

// Sensor-to-sensor offsets (ppm) added to each SCD-30 before the blank is
// subtracted. Measure them with all three sensors in the same air (no
// compost, same inlet) and enter (blank reading - this sensor's reading).
const CO2_OFFSET_PPM = { blank: 0, control: 0, sample: 0 };
