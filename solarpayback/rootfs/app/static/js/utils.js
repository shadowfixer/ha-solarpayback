// HA SolarPayBack — Utility functions

export const Utils = {
  // Format number with commas, fixed decimals
  fmtNum(n, decimals = 0) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },

  // Format currency
  fmtCurrency(n, decimals = 0) {
    if (n === null || n === undefined || isNaN(n)) return '£—';
    return '£' + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },

  // Format kWh
  fmtKwh(n, decimals = 1) {
    if (n === null || n === undefined || isNaN(n)) return '— kWh';
    return Utils.fmtNum(n, decimals) + ' kWh';
  },

  // Format power (W/kW)
  fmtPower(w) {
    if (w === null || w === undefined || isNaN(w)) return '— W';
    if (Math.abs(w) >= 1000) return (w / 1000).toFixed(2) + ' kW';
    return Math.round(w) + ' W';
  },

  // Format percent
  fmtPct(n, decimals = 0) {
    if (n === null || n === undefined || isNaN(n)) return '—%';
    return Number(n).toFixed(decimals) + '%';
  },

  // Date helpers
  monthKey(date) { // "YYYY-MM"
    const d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  },

  parseMonthKey(key) { // "YYYY-MM" -> Date (first of month)
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1);
  },

  formatMonth(key) { // "YYYY-MM" -> "MMM YYYY"
    const d = Utils.parseMonthKey(key);
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  },

  monthsBetween(start, end) { // inclusive count
    const s = start instanceof Date ? start : new Date(start);
    const e = end instanceof Date ? end : new Date(end);
    return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
  },

  // UK seasonal profile (monthly weights, sum = 1)
  // Based on typical UK solar generation distribution
  UK_SEASONAL_WEIGHTS: [
    0.025, // Jan
    0.035, // Feb
    0.055, // Mar
    0.085, // Apr
    0.115, // May
    0.125, // Jun
    0.120, // Jul
    0.105, // Aug
    0.080, // Sep
    0.055, // Oct
    0.030, // Nov
    0.020  // Dec
  ],

  // Get seasonal weight for a month (0-11)
  seasonalWeight(monthIndex) {
    return Utils.UK_SEASONAL_WEIGHTS[monthIndex] || 0;
  },

  // Project annual from partial months using seasonal profile
  // monthlyData: array of monthly generation values (kWh) in chronological order from install month
  // installDate: installation date string
  // Returns projected annual generation (kWh)
  projectAnnual(monthlyData, installDate) {
    const install = new Date(installDate);
    const installMonth = install.getMonth();

    let totalWeight = 0;
    let weightedSum = 0;

    monthlyData.forEach((val, idx) => {
      const monthIdx = (installMonth + idx) % 12;
      const weight = Utils.seasonalWeight(monthIdx);
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += val;
      }
    });

    if (totalWeight === 0) return 0;
    // Weighted average of observed months, scaled to full year (sum of weights = 1)
    const avgWeighted = weightedSum / totalWeight;
    return avgWeighted;
  },

  // Debounce
  debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  // Generate UUID
  uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  // Safe parse float
  parseFloatSafe(val) {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  },

  // Clamp
  clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }
};

// Global access for non-module scripts
window.HASolarPayBackUtils = Utils;