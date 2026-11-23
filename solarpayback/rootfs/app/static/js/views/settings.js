// HA SolarPayBack — Settings View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this._bound = false;
  }

  async render() {
    await this.loadSettings();
    this.renderSystemForm();
    this.renderTariffList();
    this.renderGridEvents();
    this.bindEvents();
  }

  async loadSettings() {
    const settings = await storage.getAllSettings();
    this.settings = settings;
  }

  renderSystemForm() {
      document.getElementById('sysCost').value = this.settings.systemCost || '0';
      document.getElementById('sysInstall').value = this.settings.installDate || '';
      document.getElementById('sysMcs').value = this.settings.mcsAnnual || '0';
      document.getElementById('sysCapacity').value = this.settings.capacity || '7.35';
      document.getElementById('sysExportStart').value = this.settings.exportStartDate || '';
            document.getElementById('sysPriceRise').value = this.settings.priceRise != null ? this.settings.priceRise : '';
            document.getElementById('sysWear').value = this.settings.wear != null ? this.settings.wear : '';
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
            await storage.setSetting('exportStartDate', document.getElementById('sysExportStart').value);
                        await storage.setSetting('priceRise', document.getElementById('sysPriceRise').value || '0');
                                                await storage.setSetting('wear', document.getElementById('sysWear').value || '0');
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

    // Sync from HA button
    document.getElementById('btnSyncHA').addEventListener('click', async () => {
      const statusEl = document.getElementById('syncStatus');
      const btn = document.getElementById('btnSyncHA');
      btn.disabled = true;
      statusEl.textContent = 'Syncing…';
      try {
        // Call overview's refreshFromHA which does the actual HA sync
        await this.app.views.overview.refreshFromHA();
        statusEl.textContent = 'Synced successfully';
        this.app.showToast('Historical data synced from HA');
      } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        this.app.showToast('Sync failed: ' + e.message, true);
      } finally {
        btn.disabled = false;
        setTimeout(() => { statusEl.textContent = ''; }, 5000);
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
      parseFloat(settings.systemCost) || 0,
            parseFloat(settings.mcsAnnual) || 0,
            settings.installDate || '',
            settings.exportStartDate || null
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
      parseFloat(settings.systemCost) || 0,
            parseFloat(settings.mcsAnnual) || 0,
            settings.installDate || '',
            settings.exportStartDate || null
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
      parseFloat(settings.systemCost) || 0,
            parseFloat(settings.mcsAnnual) || 0,
            settings.installDate || '',
            settings.exportStartDate || null
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