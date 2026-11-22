// HA SolarPayBack — Payback Calculations (pure functions)

import { Utils } from './utils.js';
import { storage } from './storage.js';

export const Calc = {
  // Default battery round-trip efficiency
  BATTERY_EFFICIENCY: 0.9,

  // Calculate monthly savings breakdown
    calculateMonthly(monthData, tariff, systemCost, mcsAnnual, installDate, exportStartDate = null) {
      const {
        generated = 0,
        exported = 0,
        gridImport = 0,
        batCharge = 0,
        batDischarge = 0,
        load = 0,
        gridEvents = 0
      } = monthData;

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

      // Solar used = Generated - Exported
      const solarUsed = Math.max(0, generated - exported);

      // 1. Solar used value (at day rate) - self-consumption avoids buying at day rate
      const solarUsedValue = solarUsed * dayRate;

      // 2. Export income (0 until an export contract starts)
      const exportIncome = exported * effectiveExportRate;

    // 3. Battery savings (conservative)
    // Only the portion of battery discharge that plausibly offsets peak (day) rate counts.
    // Cap by min(charge, discharge) since you can't discharge more than you charged.
    // Apply round-trip efficiency (90%): usable discharge = charge * efficiency.
    // Saving per kWh discharged = dayRate - nightRate (buy cheap at night, avoid expensive day).
    // We only count savings on the amount that was actually charged at night rate.
    // Conservative approach: usable kWh = min(batCharge * efficiency, batDischarge)
    // But we don't know what % of batCharge was at night rate vs solar.
    // Assume ALL battery charge could be from night rate (upper bound).
    // Real savings = min(batCharge * BATTERY_EFFICIENCY, batDischarge) * (dayRate - nightRate)
    // This is the arbitrage: buy at nightRate, sell/avoid at dayRate.
    const usableDischarge = Math.min(batCharge * Calc.BATTERY_EFFICIENCY, batDischarge);
    const batterySavingPerKwh = Math.max(0, dayRate - nightRate); // only the spread
    const batterySaving = usableDischarge * batterySavingPerKwh;

    // 4. Grid events (manual entries)
    const gridEventIncome = gridEvents;

    // Total saved this month
    const totalSaved = solarUsedValue + exportIncome + batterySaving + gridEventIncome;

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
      solarUsed,
      gridImport,
      batCharge,
      batDischarge,
      load,
      gridEvents,
      solarUsedValue,
      exportIncome,
      batterySaving,
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

  // Estimate payback date using seasonal projection
  estimatePaybackDate(months, systemCost, installDate) {
    const paybackMonths = Calc.calculatePayback(months, systemCost);
    const last = paybackMonths[paybackMonths.length - 1];
    if (!last || last.cumulative >= systemCost) {
      // Already paid back or will be this month
      const paidBackMonth = paybackMonths.find(m => m.cumulative >= systemCost);
      if (paidBackMonth) return Utils.parseMonthKey(paidBackMonth.month);
      return new Date(); // already paid back
    }

    // Project forward using seasonal-weighted average monthly saving
    // Get monthly totalSaved values in chronological order
    const monthlySaved = paybackMonths.map(m => m.totalSaved);

    // Project annual saving using seasonal weights
    const projectedAnnualSaving = Utils.projectAnnual(monthlySaved, installDate);

    if (projectedAnnualSaving <= 0) return null;

    const remaining = systemCost - last.cumulative;
    const monthsNeeded = remaining / (projectedAnnualSaving / 12);
    const lastMonth = Utils.parseMonthKey(last.month);
    const projected = new Date(lastMonth);
    projected.setMonth(projected.getMonth() + Math.ceil(monthsNeeded));
    return projected;
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
    return applicable || {
      day: 29.82,
      night: 7.62,
      export: 0
    };
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