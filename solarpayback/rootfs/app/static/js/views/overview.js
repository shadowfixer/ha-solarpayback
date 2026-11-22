// HA SolarPayBack — Overview View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';
import { api } from '../api.js';

export class OverviewView {
  constructor(app) {
    this.app = app;
    this.monthlyData = [];
  }

  async render() {
    await this.loadData();
    this.renderPaybackSummary();
    this.renderPanelsGrid();
    this.renderMonthlyTable();
    this.renderQuickStats();
  }

  async loadData() {
    const settings = await storage.getAllSettings();
    this.systemCost = parseFloat(settings.systemCost) || 0;
    this.mcsAnnual = parseFloat(settings.mcsAnnual) || 0;
    this.installDate = settings.installDate || '';

    this.monthlyData = await Calc.recalculateAll(this.systemCost, this.mcsAnnual, this.installDate);
  }

  renderPaybackSummary() {
    const last = this.monthlyData[this.monthlyData.length - 1];
    const paidBack = last ? last.cumulative : 0;
    const pct = this.systemCost > 0 ? (paidBack / this.systemCost) * 100 : 0;

    // Payback date
    const paybackDate = Calc.estimatePaybackDate(this.monthlyData, this.systemCost, this.installDate);
    const dateStr = paybackDate ? paybackDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—';

    document.getElementById('paidBackTotal').textContent = Utils.fmtCurrency(paidBack);
    document.getElementById('paidBackPct').textContent = Utils.fmtPct(pct, 1);
    document.getElementById('paybackDate').textContent = dateStr;

    // Color coding
    const pctEl = document.getElementById('paidBackPct');
    pctEl.className = 'value num ' + (pct >= 100 ? 'positive' : '');
  }

  renderPanelsGrid() {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;

    const last = this.monthlyData[this.monthlyData.length - 1];
    const pct = last ? Math.min(100, Math.max(0, last.pct)) : 0;
    const filled = Math.round(pct);

    grid.innerHTML = '';
    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('i');
      if (i < filled) cell.classList.add('filled');
      grid.appendChild(cell);
    }

    // Animate on first load
    if (!this.animated) {
      this.animateGrid(filled);
      this.animated = true;
    }
  }

  animateGrid(target) {
    const cells = document.querySelectorAll('#panelsGrid i');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    let current = 0;
    const timer = setInterval(() => {
      current++;
      cells.forEach((c, i) => {
        if (i < current) c.classList.add('filled');
      });
      if (current >= target) clearInterval(timer);
    }, 45);
  }

  renderMonthlyTable() {
    const tbody = document.getElementById('monthlyBody');
    if (!tbody) return;

    tbody.innerHTML = this.monthlyData.map(m => `
      <tr data-month="${m.month}" style="cursor:pointer;">
        <td>${Utils.formatMonth(m.month)}</td>
        <td class="num">${Utils.fmtKwh(m.generated)}</td>
        <td class="num">${Utils.fmtKwh(m.exported)}</td>
        <td class="num">${Utils.fmtKwh(m.solarUsed)}</td>
        <td class="num positive">${Utils.fmtCurrency(m.totalSaved)}</td>
        <td class="num">${Utils.fmtCurrency(m.gridEventIncome)}</td>
        <td class="num ${m.vsEstimate >= 0 ? 'positive' : 'negative'}">
          ${m.vsEstimate >= 0 ? '+' : ''}${Utils.fmtKwh(m.vsEstimate, 0)} (${Utils.fmtPct(m.vsEstimatePct, 0)})
        </td>
      </tr>
    `).join('');

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
    document.getElementById('statSaved').textContent = Utils.fmtCurrency(last.totalSaved);
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