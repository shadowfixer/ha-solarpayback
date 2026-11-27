// HA SolarPayBack — Overview View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';
import { api } from '../api.js';
import { RunwayView } from './runway.js?v=1.4.1';

export class OverviewView {
  constructor(app) {
    this.app = app;
    this.monthlyData = [];
    this.runway = new RunwayView(app);
    // Hourly background refresh of the Dashboard so the 30-min server-side
    // updates (Agile rate, current-month figures) appear without a manual reload.
    // Every 60s over a 25-year window is overkill; hourly keeps it light.
    this._refreshTimer = setInterval(() => {
      if (this.app.currentView !== 'overview') return; // only while visible
      this.render().catch(e => console.error('Hourly dashboard refresh error:', e));
    }, 60 * 60 * 1000);
  }

  destroy() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  async render() {
    await this.loadData();
    this.renderExportRateTag();
    this.renderPaybackSummary();
    this.renderRunway();
    this.renderMonthlyTable();
    this.renderQuickStats();
  }

  async renderExportRateTag() {
    const el = document.getElementById('exportRateTag');
    if (!el) return;
    try {
      const settings = await storage.getAllSettings();
      const source = settings.exportRateSource || 'fixed';
      if (source === 'agile') {
        const rate = settings.exportRateP != null ? parseFloat(settings.exportRateP) : null;
        el.textContent = rate != null && !isNaN(rate) ? `${rate.toFixed(2)}p` : 'Agile · —';
        el.title = 'Live Agile export rate';
      } else {
        const t = await Calc.getTariffForMonth((this.monthlyData[this.monthlyData.length - 1] || {}).month || '');
        el.textContent = t && t.export != null ? `${parseFloat(t.export).toFixed(2)}p` : '—';
        el.title = 'Export rate (tariff)';
      }
    } catch (e) {
      el.textContent = '—';
    }
  }

  async loadData() {
      const settings = await storage.getAllSettings();
      this.systemCost = parseFloat(settings.systemCost) || 0;
      this.mcsAnnual = parseFloat(settings.mcsAnnual) || 0;
      this.installDate = settings.installDate || '';
      this.exportStartDate = settings.exportStartDate || null;
      this.priceRise = parseFloat(settings.priceRise) || 0;
      this.wear = parseFloat(settings.wear) || 0;

      this.monthlyData = await Calc.recalculateAll(this.systemCost, this.mcsAnnual, this.installDate, this.exportStartDate);
    }

  renderPaybackSummary() {
    const last = this.monthlyData[this.monthlyData.length - 1];
    const paidBack = last ? last.cumulative : 0;
    const pct = this.systemCost > 0 ? (paidBack / this.systemCost) * 100 : 0;

    // Payback date
    const paybackDate = Calc.estimatePaybackDate(this.monthlyData, this.systemCost, this.installDate, this.priceRise, this.wear);
    const dateStr = paybackDate ? paybackDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—';

    document.getElementById('paidBackTotal').textContent = Utils.fmtCurrency(paidBack);
    document.getElementById('paidBackPct').textContent = Utils.fmtPct(pct, 1);
    document.getElementById('paybackDate').textContent = dateStr;

    // Color coding
    const pctEl = document.getElementById('paidBackPct');
    pctEl.className = 'value num ' + (pct >= 100 ? 'positive' : '');
  }

  renderRunway() {
      const date = Calc.estimatePaybackDate(this.monthlyData, this.systemCost, this.installDate, this.priceRise, this.wear);
      this.runway.render('runway', {
        monthlyData: this.monthlyData,
        systemCost: this.systemCost,
        installDate: this.installDate,
        priceRise: this.priceRise,
        wear: this.wear,
        paybackDate: date
      });
    }

  renderMonthlyTable() {
    const tbody = document.getElementById('monthlyBody');
    if (!tbody) return;

    tbody.innerHTML = this.monthlyData.map(m => {
      // Show the solar/battery split under Exported when available, else just total.
      const expCell = (m.solarExport != null && m.batteryExport != null)
        ? `${Utils.fmtKwh(m.exported)} <span class="split-inline">(${Utils.fmtKwh(m.solarExport)}☀ · ${Utils.fmtKwh(m.batteryExport)}🔋)</span>`
        : Utils.fmtKwh(m.exported);
      return `
      <tr data-month="${m.month}" style="cursor:pointer;">
        <td>${Utils.formatMonth(m.month)}</td>
        <td class="num">${Utils.fmtKwh(m.generated)}</td>
        <td class="num">${expCell}</td>
        <td class="num">${Utils.fmtKwh(m.solarUsed)}</td>
        <td class="num positive">${Utils.fmtCurrency(m.totalSaved)}</td>
        <td class="num">${Utils.fmtCurrency(m.gridEventIncome)}</td>
        <td class="num ${m.vsEstimate >= 0 ? 'positive' : 'negative'}">
          ${m.vsEstimate >= 0 ? '+' : ''}${Utils.fmtKwh(m.vsEstimate, 0)} (${Utils.fmtPct(m.vsEstimatePct, 0)})
        </td>
      </tr>
    `;
    }).join('');

    // Click to edit
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => this.app.openEditMonth(tr.dataset.month));
    });
  }

  renderQuickStats() {
    const last = this.monthlyData[this.monthlyData.length - 1];
    if (!last) return;

    document.getElementById('statGen').textContent = Utils.fmtKwh(last.generated);
    document.getElementById('statExp').textContent = Utils.fmtKwh(last.exported);
    document.getElementById('statUsed').textContent = Utils.fmtKwh(last.solarUsed);
    document.getElementById('statExportIncome').textContent = Utils.fmtCurrency(last.exportIncome);
    document.getElementById('statSolarUsedValue').textContent = Utils.fmtCurrency(last.solarUsedValue);

    // v1.4.0 solar/battery breakdown tiles.
    const solarExpEl = document.getElementById('statSolarExport');
    const battExpEl = document.getElementById('statBatteryExport');
    const selfUseEl = document.getElementById('statBatterySelfUseValue');
    const gridEventsEl = document.getElementById('statGridEvents');
    const totalEl = document.getElementById('statTotalSaved');
    if (solarExpEl) {
      solarExpEl.textContent = last.solarExport != null ? Utils.fmtKwh(last.solarExport) : '—';
    }
    if (battExpEl) {
      battExpEl.textContent = last.batteryExport != null ? Utils.fmtKwh(last.batteryExport) : '—';
    }
    if (selfUseEl) {
      selfUseEl.textContent = Utils.fmtCurrency(last.batterySelfUseValue || 0);
    }
    if (gridEventsEl) {
      gridEventsEl.textContent = Utils.fmtCurrency(last.gridEventIncome || 0);
    }
    if (totalEl) {
      totalEl.textContent = Utils.fmtCurrency(last.totalSaved);
    }
  }

  async refreshFromHA() {
    // Fetch historical HA data for all months from install date to now
    // and populate monthly data via the new /api/ha/monthly endpoint (daily-max)
    const settings = await storage.getAllSettings();
    const installDate = settings.installDate || '';
    const install = new Date(installDate);
    const now = new Date();

    // Entity IDs for energy sensors (total_increasing cumulative)
    const energyEntityIds = [
      'sensor.garage_foxess_energy_generated',
      'sensor.garage_foxess_feedin',
      'sensor.garage_foxess_grid_consumption',
      'sensor.garage_foxess_bat_charge',
      'sensor.garage_foxess_bat_discharge',
      'sensor.garage_foxess_load'
    ];

    try {
      // Call backend to compute monthly sums from HA history (daily-max method)
      const monthlySums = await api.haGetMonthly(energyEntityIds, install.toISOString(), now.toISOString());

      // monthlySums is { entityId: { 'YYYY-MM': sum, ... }, ... }
      // Build month data objects by combining across entities
      const monthsMap = new Map();

      // Determine all month keys present
      const allMonthKeys = new Set();
      Object.values(monthlySums).forEach(entityMap => {
        Object.keys(entityMap).forEach(key => allMonthKeys.add(key));
      });

      // For each month, build the data object
      for (const monthKey of allMonthKeys) {
        const existing = await storage.getMonth(monthKey);
        const gridEvents = existing?.gridEvents || 0;

        const getSum = (entityId) => monthlySums[entityId]?.[monthKey] || 0;

        const haData = {
          month: monthKey,
          generated: getSum('sensor.garage_foxess_energy_generated'),
          exported: getSum('sensor.garage_foxess_feedin'),
          gridImport: getSum('sensor.garage_foxess_grid_consumption'),
          batCharge: getSum('sensor.garage_foxess_bat_charge'),
          batDischarge: getSum('sensor.garage_foxess_bat_discharge'),
          load: getSum('sensor.garage_foxess_load'),
          gridEvents
        };

        await storage.saveMonth(monthKey, haData);
      }

      await this.render();
      this.app.showToast(`Synced ${allMonthKeys.size} months from HA history`);
    } catch (e) {
      console.error('Failed to refresh from HA:', e);
      this.app.showToast('HA sync failed: ' + e.message, true);
    }
  }
}