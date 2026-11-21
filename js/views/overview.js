// HA SunBack — Overview View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';
import { haApi } from '../ha-api.js';

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
    this.systemCost = parseFloat(settings.systemCost) || 9150;
    this.mcsAnnual = parseFloat(settings.mcsAnnual) || 6390;
    this.installDate = settings.installDate || '2026-11-13';

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
    // Fetch latest HA data and update current month
    const now = new Date();
    const monthKey = Utils.monthKey(now);

    try {
      const states = await haApi.getStates([
        'sensor.garage_foxess_energy_generated',
        'sensor.garage_foxess_feedin',
        'sensor.garage_foxess_grid_consumption',
        'sensor.garage_foxess_bat_charge',
        'sensor.garage_foxess_bat_discharge',
        'sensor.garage_foxess_load'
      ]);

      const haData = {};
      states.forEach((state, id) => {
        const val = parseFloat(state?.state) || 0;
        if (id.includes('energy_generated')) haData.generated = val;
        else if (id.includes('feedin')) haData.exported = val;
        else if (id.includes('grid_consumption')) haData.gridImport = val;
        else if (id.includes('bat_charge') && !id.includes('power')) haData.batCharge = val;
        else if (id.includes('bat_discharge') && !id.includes('power')) haData.batDischarge = val;
        else if (id.includes('load') && !id.includes('power')) haData.load = val;
      });

      // Merge with existing grid events
      const existing = await storage.getMonth(monthKey);
      const gridEvents = existing?.gridEvents || 0;

      await storage.saveMonth(monthKey, { ...haData, gridEvents });
      await this.render();
    } catch (e) {
      console.error('Failed to refresh from HA:', e);
    }
  }
}