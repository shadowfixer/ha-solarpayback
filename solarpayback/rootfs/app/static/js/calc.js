// HA SolarPayBack — Payback Calculations (pure functions)

import { Utils } from './utils.js';
import { storage } from './storage.js';

export const Calc = {
  // Default battery round-trip efficiency
  BATTERY_EFFICIENCY: 0.9,

  // Calculate monthly savings breakdown
    calculateMonthly(monthData, tariff, systemCost, mcsAnnual, installDate, exportStartDate = null) {
      // Normalise snake_case (server API) -> camelCase (used in calc). Any key that's
    // already camelCase is left untouched.
    const norm = (v) => (v == null ? null : v);
    const m = {
      ...monthData,
      gridImport: (monthData.gridImport ?? monthData.grid_import) ?? 0,
      batCharge: (monthData.batCharge ?? monthData.bat_charge) ?? 0,
      batDischarge: (monthData.batDischarge ?? monthData.bat_discharge) ?? 0,
      gridEvents: (monthData.gridEvents ?? monthData.grid_events) ?? 0,
      exportIncome: monthData.exportIncome ?? monthData.export_income ?? null,
      solarExport: (monthData.solarExport ?? monthData.solar_export) ?? null,
      batteryExport: (monthData.batteryExport ?? monthData.battery_export) ?? null,
      batterySelfUse: (monthData.batterySelfUse ?? monthData.battery_selfuse) ?? null,
      solarExportIncome: (monthData.solarExportIncome ?? monthData.solar_export_income) ?? null,
      batteryExportIncome: (monthData.batteryExportIncome ?? monthData.battery_export_income) ?? null,
      batterySelfUseValue: (monthData.batterySelfUseValue ?? monthData.battery_selfuse_value) ?? null,
    };

    const {
      generated = 0,
      exported = 0,
      gridImport = 0,
      batCharge = 0,
      batDischarge = 0,
      load = 0,
      gridEvents = 0,
      exportIncome: serverExportIncome = null,
      solarExport: serverSolarExport = null,
      batteryExport: serverBatteryExport = null,
      batterySelfUse: serverBatterySelfUse = null,
      solarExportIncome: serverSolarExportIncome = null,
      batteryExportIncome: serverBatteryExportIncome = null,
      batterySelfUseValue: serverBatterySelfUseValue = null
    } = m;

    const dayRate = tariff.day / 100;      // £/kWh
    const nightRate = tariff.night / 100;  // £/kWh
    const exportRate = tariff.export / 100; // £/kWh

    // Export income only counts once the user has an export contract.
    // Until exportStartDate, any power generated-and-exported does NOT earn money,
    // so we treat the export rate as 0 for those months. Grid events (e.g. axle)
    // still count separately below — those are their own payments.
    const exportStartMonth = exportStartDate ? exportStartDate.slice(0, 7) : null; // "YYYY-MM"
    const monthKey = monthData.month; // "YYYY-MM"
    const exporting = exportStartMonth ? monthKey >= exportStartMonth : false;
    const effectiveExportRate = exporting ? exportRate : 0;

    // v1.4.0: the server provides the SOLAR / BATTERY split of export energy and its
    // income, plus battery discharge that is consumed at home (its value = the Agile
    // import rate it avoided). When present (Agile months rebuilt after this version),
    // we use those authoritative numbers instead of estimating anything. Fall back to
    // the old simple split for older/fixed-tariff months.
    const hasBreakdown = serverSolarExport != null && serverBatteryExport != null;
  // Battery CHARGE origin from Predbat: grid kWh is import_energy_battery; the rest
  // of the battery's charge must have come from solar. Used to stop double-counting —
  // solar that went INTO the battery is not "solar used at home" (it resurfaces as
  // battery discharge), so we exclude charging_from_solar from solar_used.
  const batteryChargeFromGrid = (m.batteryChargeFromGrid ?? (monthData.battery_charge_from_grid ?? 0)) || 0;
  const batteryChargeFromSolar = (m.batteryChargeFromSolar ?? (monthData.battery_charge_from_solar ?? 0)) || 0;
  const solarExport = hasBreakdown ? Number(serverSolarExport) : Math.max(0, exported);
  const batteryExport = hasBreakdown ? Number(serverBatteryExport) : 0;
  const batterySelfUse = hasBreakdown ? (Number(serverBatterySelfUse) || 0) : 0;

  // 1. Solar used at home = Generated − solar sent to grid − solar absorbed by battery.
  //    (Excluding battery-charged-from-solar prevents the solar→battery→discharge
  //    double count: that energy is valued once, on discharge, not twice.)
  const solarUsed = Math.max(0, generated - solarExport - batteryChargeFromSolar);

    // 2. Solar used value (at day rate) - self-consumed solar avoids buying at day rate
    const solarUsedValue = solarUsed * dayRate;

    // 3. Export income (0 until an export contract starts)
    // Prefer the server's slot-accurate figure (per half-hour rate, £0 before the
    // export contract). When the server also broke it into solar/battery, use that;
    // otherwise fall back to exported × single rate.
    let exportIncome, solarExportIncome, batteryExportIncome;
    if (serverExportIncome != null) {
      exportIncome = Number(serverExportIncome);
      // Sum of the split, falling back to the total when a part is missing.
      const s = (v) => (v == null ? 0 : Number(v));
      const splitSum = s(serverSolarExportIncome) + s(serverBatteryExportIncome);
      if (hasBreakdown && splitSum > 0) {
        solarExportIncome = s(serverSolarExportIncome);
        batteryExportIncome = s(serverBatteryExportIncome);
      } else {
        // No per-source split available — attribute all exported income to solar and
        // separately credit the measured battery export at the same rate.
        const rateP = exported > 0 ? (exportIncome / exported) * 100 : effectiveExportRate * 100;
        solarExportIncome = solarExport * rateP / 100;
        batteryExportIncome = batteryExport * rateP / 100;
      }
    } else {
      exportIncome = exported * effectiveExportRate;
      const rateP = effectiveExportRate * 100;
      solarExportIncome = solarExport * rateP / 100;
      batteryExportIncome = batteryExport * rateP / 100;
    }

    // 4. Battery: the export it did (already counted in exportIncome via
    //    batteryExportIncome) PLUS the value of battery energy used at home.
    //    Battery discharge that stayed in the house avoided paying the Agile import
    //    rate — the server prices that per slot (batterySelfUseValue).
    const batterySelfUseValue = (serverBatterySelfUseValue != null)
      ? Number(serverBatterySelfUseValue)
      : batterySelfUse * Math.max(0, dayRate); // fallback: value at day rate

    // 5. Grid events (manual entries, e.g. Axle)
    const gridEventIncome = gridEvents;

    // Total saved this month: solar used + export income (solar + battery) +
    // battery self-use value + grid events. No separate "battery arbitrage" estimate —
    // Predbat's export arbitrage already shows up inside export income, priced per slot.
    const totalSaved = solarUsedValue + exportIncome + batterySelfUseValue + gridEventIncome;

    // MCS estimate for this month
    const monthIdx = new Date(monthData.month + '-01').getMonth();
    const seasonalWeight = Utils.UK_SEASONAL_WEIGHTS[monthIdx] || (1/12);
    const mcsEstimate = mcsAnnual * seasonalWeight;

    // vs estimate
    const vsEstimate = generated - mcsEstimate;
    const vsEstimatePct = mcsEstimate > 0 ? (generated / mcsEstimate) * 100 : 0;

    return {
      month: monthData.month,
      generated,
      exported,
      solarExport,
      batteryExport,
      solarUsed,
      batterySelfUse,
      gridImport,
      batCharge,
      batDischarge,
      load,
      gridEvents,
      solarUsedValue,
      exportIncome,
      solarExportIncome,
      batteryExportIncome,
      batterySelfUseValue,
      gridEventIncome,
      totalSaved,
      mcsEstimate,
      vsEstimate,
      vsEstimatePct,
      dayRate: tariff.day,
      nightRate: tariff.night,
      exportRate: tariff.export
    };
          },

  // Calculate cumulative payback
  calculatePayback(months, systemCost) {
    let cumulative = 0;
    const results = [];

    for (const month of months) {
      cumulative += month.totalSaved;
      const pct = systemCost > 0 ? (cumulative / systemCost) * 100 : 0;
      results.push({ ...month, cumulative, pct });
    }

    return results;
  },

  // Estimate payback date using seasonal projection.
    // priceRisePct (%/yr) and wearPct (%/yr) compound annually from installDate,
    // applied ONLY to the forward projection — historical savings stay as-is.
    estimatePaybackDate(months, systemCost, installDate, priceRisePct = 0, wearPct = 0) {
      const paybackMonths = Calc.calculatePayback(months, systemCost);
      const last = paybackMonths[paybackMonths.length - 1];
      if (!last || last.cumulative >= systemCost) {
        // Already paid back or will be this month
        const paidBackMonth = paybackMonths.find(m => m.cumulative >= systemCost);
        if (paidBackMonth) return Utils.parseMonthKey(paidBackMonth.month);
        return new Date(); // already paid back
      }

      // Projected base monthly saving (seasonal-weighted) at current rates/output.
      const monthlySaved = paybackMonths.map(m => m.totalSaved);
      const projectedAnnualSaving = Utils.projectAnnual(monthlySaved, installDate);
      if (projectedAnnualSaving <= 0) return null;
      const baseMonthly = projectedAnnualSaving / 12;

      const priceFactor = 1 + (parseFloat(priceRisePct) || 0) / 100;
      const wearFactor = 1 - (parseFloat(wearPct) || 0) / 100;

      const start = Utils.parseMonthKey(last.month);
      const install = new Date(installDate);

      // Walk months forward from the last observed month until paid back.
      let cum = last.cumulative;
      const cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1); // next month
      let guard = 0;
      while (cum < systemCost && guard < 1200) { // never project more than 100 years
        // Years elapsed since install (can be fractional) -> compounding applied.
        const years = (cursor.getFullYear() - install.getFullYear()) +
                      (cursor.getMonth() - install.getMonth()) / 12;
        const factor = Math.pow(priceFactor, years) * Math.pow(wearFactor, years);
        cum += baseMonthly * factor;
        cursor.setMonth(cursor.getMonth() + 1);
        guard++;
      }
      if (cum < systemCost) return null; // wear may mean it never pays back
      return new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    },

  // Get applicable tariff for a month
  async getTariffForMonth(monthKey) {
    const tariffs = await storage.getAllTariffs();
    const target = new Date(monthKey + '-01');

    let applicable = null;
    for (const t of tariffs) {
      const tDate = new Date(t.month + '-01');
      if (tDate <= target) {
        applicable = t;
      } else {
        break;
      }
    }

    // Default fallback
    const result = applicable || {
      day: 29.82,
      night: 7.62,
      export: 0
    };

    // If the export rate source is Agile, use the live captured export rate (p/kWh)
    // as the export price for this month instead of the manual tariff value.
    try {
      const settings = await storage.getAllSettings();
      if (settings.exportRateSource === 'agile' && settings.exportRateP != null) {
        const agileP = parseFloat(settings.exportRateP);
        if (!isNaN(agileP)) {
          result.export = agileP;
        }
      }
    } catch (e) {
      // Fall back to the manual tariff value if settings can't be read.
    }

    return result;
  },

  // Recalculate all months with current tariffs
  async recalculateAll(systemCost, mcsAnnual, installDate, exportStartDate = null) {
      const months = await storage.getAllMonths();
      const results = [];

      for (const month of months.sort((a, b) => a.month.localeCompare(b.month))) {
        const tariff = await Calc.getTariffForMonth(month.month);
        // Fetch grid events for this month and add to month data
        const gridEventIncome = await Calc.getGridEventsForMonth(month.month);
        const monthWithGridEvents = { ...month, gridEvents: gridEventIncome };
        const calculated = Calc.calculateMonthly(monthWithGridEvents, tariff, systemCost, mcsAnnual, installDate, exportStartDate);
        results.push(calculated);
      }

    const withCumulative = Calc.calculatePayback(results, systemCost);
    return withCumulative;
  },

  // Get grid events total for a month
  async getGridEventsForMonth(monthKey) {
    const events = await storage.getGridEventsForMonth(monthKey);
    return events.reduce((sum, e) => sum + (e.amount || 0), 0);
  },

  // Build month data from HA entities
  buildMonthFromHA(haData, monthKey) {
    // haData contains entity states for the month
    // We need to compute deltas for cumulative sensors
    return {
      month: monthKey,
      generated: haData.generated || 0,
      exported: haData.exported || 0,
      gridImport: haData.gridImport || 0,
      batCharge: haData.batCharge || 0,
      batDischarge: haData.batDischarge || 0,
      load: haData.load || 0,
      gridEvents: 0 // added manually
    };
  }
};

window.HASolarPayBackCalc = Calc;