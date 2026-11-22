// HA SolarPayBack — Settings View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { haApi } from '../ha-api.js';
import { Calc } from '../calc.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.entityMap = {};
    this._bound = false;
  }

  async render() {
    await this.loadSettings();
    this.renderSystemForm();
    this.renderTariffList();
    this.renderGridEvents();
    this.renderHAForm();
    this.renderEntityMapping();
    this.bindEvents();
  }

  async loadSettings() {
    const settings = await storage.getAllSettings();
    this.settings = settings;
  }

  renderSystemForm() {
    document.getElementById('sysCost').value = this.settings.systemCost || '9150';
    document.getElementById('sysInstall').value = this.settings.installDate || '2026-11-13';
    document.getElementById('sysMcs').value = this.settings.mcsAnnual || '6390';
    document.getElementById('sysCapacity').value = this.settings.capacity || '7.35';
  }

  async renderTariffList() {
    const container = document.getElementById('tariffList');
    const tariffs = await storage.getAllTariffs();

    if (!tariffs.length) {
      container.innerHTML = '<p class="muted">No tariff changes added. Add your first rate above.</p>';
      return;
    }

    container.innerHTML = tariffs.map(t => `
      <div class="tariff-item" data-id="${t.id}">
        <div class="tariff-info">
          <span><strong>${Utils.formatMonth(t.month)}</strong></span>
          <span>Day: ${t.day}p</span>
          <span>Night: ${t.night || '—'}p</span>
          <span>Export: ${t.export || '—'}p</span>
        </div>
        <div class="tariff-actions">
          <button class="btn-secondary btn-sm" data-action="edit-tariff">Edit</button>
          <button class="btn-danger btn-sm" data-action="delete-tariff">Delete</button>
        </div>
      </div>
    `).join('');
  }

  async renderGridEvents() {
    const container = document.getElementById('gridEventList');
    const events = await storage.getAllGridEvents();

    // Compute totals
    const now = new Date();
    const currentMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const thisMonthTotal = events
      .filter(e => e.date.startsWith(currentMonthKey))
      .reduce((sum, e) => sum + (e.amount || 0), 0);
    const allTimeTotal = events.reduce((sum, e) => sum + (e.amount || 0), 0);

    if (!events.length) {
      container.innerHTML = '<p class="muted">No grid events recorded.</p>';
      return;
    }

    // Totals row + list
    container.innerHTML = `
      <div class="ge-totals" style="display:flex; gap:24px; margin-bottom:12px; flex-wrap:wrap; font-size:0.9rem;">
        <div class="muted">This month (<strong>${Utils.formatMonth(currentMonthKey)}</strong>):</div>
        <div class="positive num">${Utils.fmtCurrency(thisMonthTotal, 2)}</div>
        <div class="muted">All time:</div>
        <div class="positive num">${Utils.fmtCurrency(allTimeTotal, 2)}</div>
      </div>
      ${events.map(e => `
        <div class="ge-item" data-id="${e.id}">
          <div class="ge-info">
            <span><strong>${e.date}</strong></span>
            <span class="positive">${Utils.fmtCurrency(e.amount, 2)}</span>
            ${e.notes ? `<span class="muted">${e.notes}</span>` : ''}
          </div>
          <div class="ge-actions">
            <button class="btn-danger btn-sm" data-action="delete-grid-event">Delete</button>
          </div>
        </div>
      `).join('')}
    `;
  }

  renderHAForm() {
    document.getElementById('haUrl').value = this.settings.haUrl || 'http://homeassistant.local:8123';
    document.getElementById('haToken').value = this.settings.haToken || '';
  }

  async renderEntityMapping() {
    const container = document.getElementById('entityMapping');
    const defaultMap = {
      'pv_power': 'sensor.garage_foxess_pv_power',
      'solar_power': 'sensor.garage_foxess_solar_power',
      'generation_power': 'sensor.garage_foxess_generation_power',
      'energy_generated': 'sensor.garage_foxess_energy_generated',
      'energy_generated_cumulative': 'sensor.garage_foxess_energy_generated_cumulative',
      'feedin': 'sensor.garage_foxess_feedin',
      'feedin_power': 'sensor.garage_foxess_feedin_power',
      'grid_consumption': 'sensor.garage_foxess_grid_consumption',
      'grid_consumption_power': 'sensor.garage_foxess_grid_consumption_power',
      'bat_charge': 'sensor.garage_foxess_bat_charge',
      'bat_discharge': 'sensor.garage_foxess_bat_discharge',
      'bat_charge_power': 'sensor.garage_foxess_bat_charge_power',
      'bat_discharge_power': 'sensor.garage_foxess_bat_discharge_power',
      'bat_soc': 'sensor.garage_foxess_bat_soc',
      'load': 'sensor.garage_foxess_load',
      'load_power': 'sensor.garage_foxess_load_power',
      'inverter': 'sensor.garage_foxess_inverter',
      'pvenergytotal': 'sensor.garage_foxess_pvenergytotal'
    };

    this.entityMap = { ...defaultMap, ...(this.settings.entityMap || {}) };

    container.innerHTML = Object.entries(this.entityMap).map(([key, entityId]) => `
      <div class="entity-row">
        <span class="entity-label">${key}</span>
        <input type="text" class="entity-input" data-key="${key}" value="${entityId}" placeholder="Auto-detected">
      </div>
    `).join('');
  }

  bindEvents() {
    if (this._bound) return; // Bind once per view instance — re-rendering re-calls this and would stack duplicate listeners (each click then fires the submit handler N times, saving N duplicate grid events)
    this._bound = true;

    // System form
    document.getElementById('formSystem').addEventListener('submit', async (e) => {
      e.preventDefault();
      await storage.setSetting('systemCost', document.getElementById('sysCost').value);
      await storage.setSetting('installDate', document.getElementById('sysInstall').value);
      await storage.setSetting('mcsAnnual', document.getElementById('sysMcs').value);
      await storage.setSetting('capacity', document.getElementById('sysCapacity').value);
      this.app.showToast('System config saved');
      this.app.refreshAllViews();
    });

    // Tariff form
    document.getElementById('formTariff').addEventListener('submit', async (e) => {
      e.preventDefault();
      const tariff = {
        month: document.getElementById('tariffMonth').value,
        day: parseFloat(document.getElementById('tariffDay').value),
        night: parseFloat(document.getElementById('tariffNight').value) || 0,
        export: parseFloat(document.getElementById('tariffExport').value) || 0
      };
      await storage.saveTariff(tariff);
      this.renderTariffList();
      this.app.refreshAllViews();
      this.app.showToast('Tariff added');
    });

    // Grid event form
    document.getElementById('formGridEvent').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newEvent = {
        date: document.getElementById('geDate').value,
        amount: parseFloat(document.getElementById('geAmount').value),
        notes: document.getElementById('geNotes').value.trim()
      };

      // REQ 2: Duplicate-entry guard — check for existing event with same date + amount (+ notes)
      const existingEvents = await storage.getAllGridEvents();
      const isDuplicate = existingEvents.some(existing =>
        existing.date === newEvent.date &&
        existing.amount === newEvent.amount &&
        (existing.notes || '').trim().toLowerCase() === newEvent.notes.toLowerCase()
      );

      if (isDuplicate) {
        this.app.showToast('Duplicate grid event - not added', true);
        return; // Keep form populated so user can adjust
      }

      await storage.saveGridEvent(newEvent);
      this.renderGridEvents();            // Visibly update the list immediately
      this.app.refreshAllViews();         // Refresh other views (overview, etc.)
      this.app.showToast('Grid event added'); // REQ 1: Clear save confirmation via toast
    });

    // HA form
    document.getElementById('formHA').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('haUrl').value;
      const token = document.getElementById('haToken').value;

      try {
        await haApi.saveConfig(url, token);
        const ok = await haApi.testConnection();
        if (ok) {
          this.app.showToast('HA connection successful');
          await this.app.initializeHA();
        }
      } catch (err) {
        this.app.showToast('Connection failed: ' + err.message, true);
      }
    });

    // Entity mapping
    const container = document.getElementById('entityMapping');
    container.addEventListener('change', async (e) => {
      if (e.target.matches('.entity-input')) {
        this.entityMap[e.target.dataset.key] = e.target.value;
        await storage.setSetting('entityMap', this.entityMap);
        this.app.showToast('Entity mapping saved');
      }
    });

    // Export buttons
    document.getElementById('btnExportPDF').addEventListener('click', () => this.exportPDF());
    document.getElementById('btnExportExcel').addEventListener('click', () => this.exportExcel());
    document.getElementById('btnExportCSV').addEventListener('click', () => this.exportCSV());

    // Danger zone
    document.getElementById('btnClearAll').addEventListener('click', async () => {
      if (confirm('Delete ALL local data? This cannot be undone.')) {
        await storage.clearAll();
        this.app.showToast('All data cleared');
        this.app.refreshAllViews();
      }
    });

    // Delegated events for tariff/grid event actions
    document.getElementById('tariffList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const item = btn.closest('.tariff-item');
      const id = item.dataset.id;

      if (btn.dataset.action === 'delete-tariff') {
        if (confirm('Delete this tariff?')) {
          await storage.deleteTariff(id);
          this.renderTariffList();
          this.app.refreshAllViews();
        }
      }
    });

    document.getElementById('gridEventList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const item = btn.closest('.ge-item');
      const id = item.dataset.id;

      if (btn.dataset.action === 'delete-grid-event') {
        if (confirm('Delete this grid event?')) {
          await storage.deleteGridEvent(id);
          this.renderGridEvents();
          this.app.refreshAllViews();
        }
      }
    });
  }

  // Export functions
  async exportPDF() {
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    const doc = new jsPDF();

    const settings = await storage.getAllSettings();
    const monthlyData = await Calc.recalculateAll(
      parseFloat(settings.systemCost) || 9150,
      parseFloat(settings.mcsAnnual) || 6390,
      settings.installDate || '2026-11-13'
    );

    let y = 20;
    doc.setFontSize(20);
    doc.text('HA SolarPayBack — Payback Report', 20, y);
    y += 10;
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 20, y);
    y += 6;
    doc.text(`System: £${settings.systemCost}, Installed: ${settings.installDate}, MCS: ${settings.mcsAnnual} kWh/yr`, 20, y);
    y += 12;

    // Summary
    const last = monthlyData[monthlyData.length - 1];
    doc.setFontSize(12);
    doc.text(`Paid back: ${Utils.fmtCurrency(last?.cumulative || 0)} (${Utils.fmtPct(last?.pct || 0, 1)})`, 20, y);
    y += 8;

    // Table
    doc.autoTable({
      startY: y,
      head: [['Month', 'Gen (kWh)', 'Exp (kWh)', 'Used (kWh)', 'Saved (£)', 'vs Est.']],
      body: monthlyData.map(m => [
        Utils.formatMonth(m.month),
        Utils.fmtNum(m.generated, 1),
        Utils.fmtNum(m.exported, 1),
        Utils.fmtNum(m.solarUsed, 1),
        Utils.fmtNum(m.totalSaved, 2),
        Utils.fmtPct(m.vsEstimatePct, 0)
      ]),
      theme: 'striped'
    });

    doc.save('ha-solarpayback-report.pdf');
  }

  async exportExcel() {
    const { utils, write } = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.core.min.js');

    const settings = await storage.getAllSettings();
    const monthlyData = await Calc.recalculateAll(
      parseFloat(settings.systemCost) || 9150,
      parseFloat(settings.mcsAnnual) || 6390,
      settings.installDate || '2026-11-13'
    );

    const wb = utils.book_new();

    // Summary sheet
    const summary = [
      ['HA SolarPayBack Payback Report'],
      ['Generated', new Date().toLocaleDateString()],
      ['System Cost (£)', settings.systemCost],
      ['Install Date', settings.installDate],
      ['MCS Annual (kWh)', settings.mcsAnnual],
      [],
      ['Month', 'Generated', 'Exported', 'Self-Used', 'Grid Import', 'Bat Charge', 'Bat Discharge', 'Saved (£)', 'vs Estimate']
    ];
    monthlyData.forEach(m => {
      summary.push([
        Utils.formatMonth(m.month),
        m.generated, m.exported, m.solarUsed, m.gridImport,
        m.batCharge, m.batDischarge, m.totalSaved, m.vsEstimate
      ]);
    });
    const ws1 = utils.aoa_to_sheet(summary);
    utils.book_append_sheet(wb, ws1, 'Summary');

    // Monthly detail sheet
    const detail = monthlyData.map(m => ({
      Month: m.month,
      Generated: m.generated,
      Exported: m.exported,
      'Self-Used': m.solarUsed,
      'Grid Import': m.gridImport,
      'Bat Charge': m.batCharge,
      'Bat Discharge': m.batDischarge,
      'Grid Events': m.gridEventIncome,
      'Solar Used Value': m.solarUsedValue,
      'Export Income': m.exportIncome,
      'Battery Saving': m.batterySaving,
      'Total Saved': m.totalSaved,
      'MCS Estimate': m.mcsEstimate,
      'vs Estimate': m.vsEstimate,
      'vs Estimate %': m.vsEstimatePct,
      DayRate: m.dayRate,
      NightRate: m.nightRate,
      ExportRate: m.exportRate
    }));
    const ws2 = utils.json_to_sheet(detail);
    utils.book_append_sheet(wb, ws2, 'Monthly Detail');

    // Tariffs
    const tariffs = await storage.getAllTariffs();
    if (tariffs.length) {
      const ws3 = utils.json_to_sheet(tariffs.map(t => ({
        Month: t.month, DayRate: t.day, NightRate: t.night, ExportRate: t.export
      })));
      utils.book_append_sheet(wb, ws3, 'Tariffs');
    }

    // Grid Events
    const gridEvents = await storage.getAllGridEvents();
    if (gridEvents.length) {
      const ws4 = utils.json_to_sheet(gridEvents.map(e => ({
        Date: e.date, Amount: e.amount, Notes: e.notes
      })));
      utils.book_append_sheet(wb, ws4, 'Grid Events');
    }

    write(wb, 'ha-solarpayback.xlsx', { bookType: 'xlsx' });
  }

  async exportCSV() {
    const settings = await storage.getAllSettings();
    const monthlyData = await Calc.recalculateAll(
      parseFloat(settings.systemCost) || 9150,
      parseFloat(settings.mcsAnnual) || 6390,
      settings.installDate || '2026-11-13'
    );

    const headers = ['Month', 'Generated', 'Exported', 'Self-Used', 'Grid Import', 'Bat Charge', 'Bat Discharge', 'Grid Events', 'Total Saved', 'vs Estimate'];
    const rows = monthlyData.map(m => [
      m.month, m.generated, m.exported, m.solarUsed, m.gridImport,
      m.batCharge, m.batDischarge, m.gridEventIncome, m.totalSaved, m.vsEstimate
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ha-solarpayback-monthly.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}