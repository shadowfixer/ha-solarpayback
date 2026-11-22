// HA SolarPayBack — Live View (polling-based, no WebSocket)

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { api } from '../api.js';

export class LiveView {
  constructor(app) {
    this.app = app;
    this.pollInterval = null;
    this.diagramInterval = null;
    this.batCharge = 0;
    this.batDischarge = 0;
    
    // Entity IDs to poll (configurable via settings later)
    this.entityIds = [
      'sensor.garage_foxess_pv_power',
      'sensor.garage_foxess_solar_power',
      'sensor.garage_foxess_feedin_power',
      'sensor.garage_foxess_grid_consumption_power',
      'sensor.garage_foxess_bat_charge_power',
      'sensor.garage_foxess_bat_discharge_power',
      'sensor.garage_foxess_load_power',
      'sensor.garage_foxess_bat_soc',
      'sensor.garage_foxess_inverter'
    ];
  }

  async render() {
    await this.loadInitial();
    this.startPolling();
    this.diagramInterval = setInterval(() => this.renderDiagram(), 5000);
  }

  async loadInitial() {
    try {
      const states = await api.haGetStates();
      this.updateDisplayFromStates(states);
    } catch (e) {
      console.error('Failed to load live data:', e);
    }
  }

  startPolling() {
    // Poll every 20 seconds for live updates
    this.pollInterval = setInterval(async () => {
      try {
        const states = await api.haGetStates();
        this.updateDisplayFromStates(states);
      } catch (e) {
        console.error('Polling failed:', e);
      }
    }, 20000);
  }

  updateDisplayFromStates(states) {
    if (!Array.isArray(states)) return;
    
    states.forEach(state => {
      const id = state?.entity_id;
      const val = parseFloat(state?.state) || 0;
      
      if (!id) return;
      
      if (id.includes('pv_power') || id.includes('solar_power')) {
        this.updateValue('livePV', { state: val });
      } else if (id.includes('feedin_power')) {
        this.updateValue('liveGrid', { state: val }, 'export');
      } else if (id.includes('grid_consumption_power')) {
        this.updateValue('liveGrid', { state: val }, 'import');
      } else if (id.includes('bat_charge_power')) {
        this.batCharge = val;
        this.updateBatteryDisplay();
      } else if (id.includes('bat_discharge_power')) {
        this.batDischarge = val;
        this.updateBatteryDisplay();
      } else if (id.includes('load_power')) {
        this.updateValue('liveLoad', { state: val });
      } else if (id.includes('bat_soc')) {
        this.updateValue('liveSoc', { state: val }, 'soc');
      }
    });
    
    this.renderDiagram();
    this.updateSavingNow();
  }

  updateValue(elementId, state, type = 'power') {
    const el = document.getElementById(elementId);
    if (!el) return;

    const val = parseFloat(state?.state) || 0;
    if (type === 'soc') {
      el.textContent = Utils.fmtPct(val);
    } else if (type === 'power') {
      el.textContent = Utils.fmtPower(val * 1000); // HA gives kW
    }
  }

  updateBatteryDisplay() {
    const net = (this.batDischarge || 0) - (this.batCharge || 0); // positive = discharging
    const el = document.getElementById('liveBat');
    if (el) el.textContent = Utils.fmtPower(net * 1000);
  }

  async updateSavingNow() {
    // Calculate current saving rate using current tariff and live power values
    // Get current tariff from storage
    try {
      const tariff = await this.loadCurrentTariff();
      if (!tariff) {
        const el = document.getElementById('liveSaving');
        if (el) el.textContent = '£—/h (no tariff)';
        return;
      }

      const dayRate = tariff.day / 100;      // £/kWh
      const nightRate = tariff.night / 100;  // £/kWh
      const exportRate = tariff.export / 100; // £/kWh

      // Get live power values in kW
      const pv = this.getPowerValue('livePV');       // kW
      const grid = this.getPowerValue('liveGrid');   // kW (positive = import, negative = export)
      const load = this.getPowerValue('liveLoad');   // kW

      // Estimate hourly saving:
      // - Self-consumed PV: min(PV, load) * dayRate (avoids buying at day rate)
      // - Export: max(0, -grid) * exportRate (income from export)
      const selfUsed = Math.min(pv, load);  // kW
      const exportPower = Math.max(0, -grid); // kW (grid negative = export)

      const savingPerHour = (selfUsed * dayRate) + (exportPower * exportRate);

      const el = document.getElementById('liveSaving');
      if (el) {
        if (savingPerHour > 0) {
          el.textContent = '£' + savingPerHour.toFixed(2) + '/h';
          el.classList.add('positive');
          el.classList.remove('negative');
        } else {
          el.textContent = '£' + savingPerHour.toFixed(2) + '/h';
          el.classList.add('negative');
          el.classList.remove('positive');
        }
      }
    } catch (e) {
      const el = document.getElementById('liveSaving');
      if (el) el.textContent = '£—/h (error)';
    }
  }

  async loadCurrentTariff() {
    const tariffs = await storage.getAllTariffs();
    if (tariffs.length > 0) {
      return tariffs[tariffs.length - 1];
    }
    // Default fallback matching Octopus Agile/Tracker
    return {
      day: 29.82,
      night: 7.62,
      export: 0
    };
  }

  renderDiagram() {
    const svg = document.getElementById('liveDiagram');
    if (!svg) return;

    const pv = this.getPowerValue('livePV');
    const grid = this.getPowerValue('liveGrid');
    const load = this.getPowerValue('liveLoad');
    const bat = this.getPowerValue('liveBat');
    const soc = parseFloat(document.getElementById('liveSoc')?.textContent) || 0;

    // Simple flow diagram
    const w = 600, h = 300;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L9,3 z" fill="var(--ink)"/>
        </marker>
      </defs>

      <!-- PV Panel -->
      <g transform="translate(40, 40)">
        <rect x="0" y="0" width="120" height="80" rx="8" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
        <text x="60" y="35" text-anchor="middle" fill="var(--sun)" font-weight="700" font-size="14">☀ PV</text>
        <text x="60" y="55" text-anchor="middle" fill="var(--ink)" font-weight="700" font-size="20">${pv >= 0 ? '+' : ''}${Utils.fmtPower(pv * 1000)}</text>
        <text x="60" y="75" text-anchor="middle" fill="var(--muted)" font-size="12">Generation</text>
      </g>

      <!-- Battery -->
      <g transform="translate(240, 40)">
        <rect x="0" y="0" width="120" height="80" rx="8" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
        <text x="60" y="25" text-anchor="middle" fill="var(--sun)" font-weight="700" font-size="14">🔋 Battery</text>
        <text x="60" y="50" text-anchor="middle" fill="var(--ink)" font-weight="700" font-size="18">${bat >= 0 ? '+' : ''}${Utils.fmtPower(bat * 1000)}</text>
        <text x="60" y="70" text-anchor="middle" fill="var(--muted)" font-size="12">SoC: ${soc.toFixed(0)}%</text>
        <!-- Battery visual -->
        <rect x="80" y="15" width="30" height="50" rx="2" fill="none" stroke="var(--ink)" stroke-width="2"/>
        <rect x="82" y="17" width="26" height="${Math.max(2, soc * 0.46)}" rx="1" fill="${soc > 50 ? 'var(--good)' : soc > 20 ? 'var(--sun)' : 'var(--bad)'}"/>
      </g>

      <!-- Grid -->
      <g transform="translate(440, 40)">
        <rect x="0" y="0" width="120" height="80" rx="8" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
        <text x="60" y="35" text-anchor="middle" fill="var(--export)" font-weight="700" font-size="14">⚡ Grid</text>
        <text x="60" y="55" text-anchor="middle" fill="var(--ink)" font-weight="700" font-size="20">${grid >= 0 ? '+' : ''}${Utils.fmtPower(grid * 1000)}</text>
        <text x="60" y="75" text-anchor="middle" fill="var(--muted)" font-size="12">${grid > 0 ? 'Import' : 'Export'}</text>
      </g>

      <!-- House Load -->
      <g transform="translate(240, 160)">
        <rect x="0" y="0" width="120" height="80" rx="8" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
        <text x="60" y="35" text-anchor="middle" fill="var(--bad)" font-weight="700" font-size="14">🏠 House</text>
        <text x="60" y="55" text-anchor="middle" fill="var(--ink)" font-weight="700" font-size="20">${Utils.fmtPower(load * 1000)}</text>
        <text x="60" y="75" text-anchor="middle" fill="var(--muted)" font-size="12">Load</text>
      </g>

      <!-- Flow arrows -->
      <g stroke="var(--ink)" stroke-width="3" fill="none" marker-end="url(#arrow)">
        <!-- PV -> Battery -->
        <path d="M160 80 Q200 80 240 80" opacity="${this.batCharge > 0 ? 1 : 0.3}"/>
        <!-- PV -> Grid (export) -->
        <path d="M160 80 Q300 80 440 80" opacity="${pv > load + (this.batCharge||0) ? 1 : 0.3}"/>
        <!-- Grid -> House -->
        <path d="M500 80 Q500 120 300 200" opacity="${grid > 0 ? 1 : 0.3}"/>
        <!-- Battery -> House -->
        <path d="M300 120 Q300 140 300 160" opacity="${this.batDischarge > 0 ? 1 : 0.3}"/>
        <!-- PV -> House -->
        <path d="M100 120 Q100 140 300 200" opacity="${pv > 0 ? 1 : 0.3}"/>
      </g>
    `;
  }

  getPowerValue(elementId) {
    const text = document.getElementById(elementId)?.textContent || '0 W';
    const match = text.match(/([+-]?\d+\.?\d*)\s*(W|kW)/);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    return match[2] === 'kW' ? val : val / 1000;
  }

  destroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.diagramInterval) clearInterval(this.diagramInterval);
  }
}