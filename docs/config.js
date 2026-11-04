// Web app URL of the Apps Script in co2-monitor/sheets/Code.gs (ends in /exec).
// It only allows reading here; uploads need the token kept on the Pico.
const SHEETS_URL = "";

// How often the page asks for new rows. The Pico uploads every 2 minutes.
const REFRESH_SECONDS = 60;
