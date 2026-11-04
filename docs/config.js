// Web app URL of the Apps Script in co2-monitor/sheets/Code.gs (ends in /exec).
// It only allows reading here; uploads need the token kept on the Pico.
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyZ4nluHTgFrKw4tZzZJwN3rBjiMWDRkG3MltI8veDvDN_7V9YzldyUInIpVawcHypJ/exec";

// How often the page asks for new rows. The Pico uploads every 2 minutes.
const REFRESH_SECONDS = 60;
