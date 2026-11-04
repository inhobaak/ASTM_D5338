// Web app URL of the Apps Script in co2-monitor/sheets/Code.gs (ends in /exec).
// It only allows reading here; uploads need the token kept on the Pico.
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyZ4nluHTgFrKw4tZzZJwN3rBjiMWDRkG3MltI8veDvDN_7V9YzldyUInIpVawcHypJ/exec";

// How often the page asks for new rows. The Pico uploads every 30 s.
const REFRESH_SECONDS = 30;

// Sensor-to-sensor offsets (ppm) added to each SCD-30 before the blank is
// subtracted. Measure them with all three sensors in the same air (no
// compost, same inlet) and enter (blank reading - this sensor's reading).
const CO2_OFFSET_PPM = { blank: 0, control: 0, sample: 0 };

// CO2 evolution and biodegradation. The start time is the TEST_START script
// property in the Apps Script. Set the needle valves so every vessel gets the
// same air flow, measure it, and enter it here: the blank is subtracted as the
// baseline, which assumes equal flows.
const EVOLUTION = {
    air_flow_ml_min: null,   // measured air flow through each vessel (mL/min)
    gas_temp_c: 20,          // temperature where the flow is measured
    pressure_kpa: 98.3,      // about 250 m elevation
    materials: {
        // ThCO2 = mass_g x carbon_fraction x 44.01/12.011
        control: { mass_g: 10, carbon_fraction: 0.444 },   // microcrystalline cellulose (C6H10O5)n
        sample:  { mass_g: 10, carbon_fraction: null },    // from elemental analysis (CHNS)
    },
};
