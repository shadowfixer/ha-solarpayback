// HA SolarPayBack — History View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';

export class HistoryView {
  constructor(app) {
    this.app = app;
  }

  async render() {
    await this.loadData();
    this.renderYearlyCharts();
    this.renderHistoryTable();
  }

  async loadData() {
    const settings = await storage.getAllSettings();
    this.systemCost = parseFloat(settings.systemCost) || 0;
    this.mcsAnnual = parseFloat(settings.mcsAnnual) || 0;
    this.installDate = settings.installDate || '';

    this.monthlyData = await Calc.recalculateAll(this.systemCost, this.mcsAnnual, this.installDate);
  }

  renderYearlyCharts() {
    const container = document.getElementById('yearlyCharts');
    if (!container) return;

    // Group by year
    const byYear = {};
    this.monthlyData.forEach(m => {
      const year = parseInt(m.month.split('-')[0], 10);
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(m);
    });

    container.innerHTML = Object.entries(byYear)
      .sort(([a], [b]) => b - a) // newest first
      .map(([year, months]) => this.renderYearChart(year, months))
      .join('');
  }

  renderYearChart(year, months) {
    const totalGen = months.reduce((s, m) => s + m.generated, 0);
    const totalExp = months.reduce((s, m) => s + m.exported, 0);
    const totalSaved = months.reduce((s, m) => s + m.totalSaved, 0);
    const avgVsEst = months.reduce((s, m) => s + m.vsEstimatePct, 0) / months.length;

    // Simple SVG bar chart
    const maxGen = Math.max(...months.map(m => m.generated), 1);
    const barHeight = 30;
    const chartWidth = 400;

    return `
      <details class="year-card" open>
        <summary>
          <strong>${year}</strong>
          <span class="muted">${months.length} months</span>
          <span class="num">${Utils.fmtKwh(totalGen)} generated</span>
          <span class="num positive">${Utils.fmtCurrency(totalSaved)} saved</span>
          <span class="${avgVsEst >= 100 ? 'positive' : 'negative'}">${Utils.fmtPct(avgVsEst, 0)} vs est.</span>
        </summary>
        <div class="year-chart" style="margin-top:12px;">
          ${months.map(m => `
            <div class="chart-row" style="display:flex; align-items:center; gap:8px; margin:4px 0;">
              <span style="width:50px; font-size:0.8rem; color:var(--muted);">${Utils.formatMonth(m.month)}</span>
              <div style="flex:1; height:${barHeight}px; background:var(--line); border-radius:4px; overflow:hidden; position:relative;">
                <div style="width:${(m.generated/maxGen)*100}%; height:100%; background:var(--sun); border-radius:4px; transition:width 0.3s;"></div>
                <div style="position:absolute; left:${(m.mcsEstimate/maxGen)*100}%; top:0; bottom:0; width:2px; background:var(--ink); opacity:0.6;" title="MCS Estimate"></div>
              </div>
              <span class="num" style="width:60px; text-align:right; font-size:0.8rem;">${Utils.fmtKwh(m.generated)}</span>
            </div>
          `).join('')}
        </div>
      </details>
    `;
  }

  renderHistoryTable() {
    const tbody = document.getElementById('historyBody');
    if (!tbody) return;

    tbody.innerHTML = this.monthlyData.map(m => `
      <tr>
        <td>${Utils.formatMonth(m.month)}</td>
        <td class="num">${Utils.fmtKwh(m.generated)}</td>
        <td class="num">${Utils.fmtKwh(m.exported)}</td>
        <td class="num">${Utils.fmtKwh(m.solarUsed)}</td>
        <td class="num">${Utils.fmtKwh(m.gridImport)}</td>
        <td class="num">${Utils.fmtKwh(m.batCharge)}</td>
        <td class="num">${Utils.fmtKwh(m.batDischarge)}</td>
        <td class="num positive">${Utils.fmtCurrency(m.totalSaved)}</td>
        <td class="num ${m.vsEstimate >= 0 ? 'positive' : 'negative'}">
          ${m.vsEstimate >= 0 ? '+' : ''}${Utils.fmtKwh(m.vsEstimate, 0)}
        </td>
      </tr>
    `).join('');
  }

  async refreshFromHA() {
    // Could implement historical data fetch from HA
    // For now, just re-render
    await this.render();
  }
}