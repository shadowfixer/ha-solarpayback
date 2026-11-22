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
      this.renderDiagram(); // render immediately (not just after the 5s interval)
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

        // Exact entity IDs we care about (not substrings — so bat_soc1/bat_soc2 and
        // the feed-in/grid-consumption pair can't overwrite the real value).
        const SOLAR = ['sensor.garage_foxess_pv_power', 'sensor.garage_foxess_solar_power'];
        const FEEDIN = ['sensor.garage_foxess_feedin_power'];
        const GRIDIMP = ['sensor.garage_foxess_grid_consumption_power'];
        const BAT_CHG = ['sensor.garage_foxess_bat_charge_power'];
        const BAT_DIS = ['sensor.garage_foxess_bat_discharge_power'];
        const LOAD = ['sensor.garage_foxess_load_power'];
        const SOC = ['sensor.garage_foxess_bat_soc'];

        let gridImport = 0;
        let gridExport = 0;

        states.forEach(state => {
          const id = state?.entity_id;
          const val = parseFloat(state?.state) || 0;
          if (!id) return;

          if (SOLAR.includes(id)) {
            this.updateValue('livePV', { state: val });
          } else if (FEEDIN.includes(id)) {
            gridExport = val;           // kW exported to grid
          } else if (GRIDIMP.includes(id)) {
            gridImport = val;           // kW imported from grid
          } else if (BAT_CHG.includes(id)) {
            this.batCharge = val;
            this.updateBatteryDisplay();
          } else if (BAT_DIS.includes(id)) {
            this.batDischarge = val;
            this.updateBatteryDisplay();
          } else if (LOAD.includes(id)) {
            this.updateValue('liveLoad', { state: val });
          } else if (SOC.includes(id)) {
            this.updateValue('liveSoc', { state: val }, 'soc');
          }
        });

        // Net grid: positive = importing, negative = exporting. Passes a signed value.
        const net = gridImport - gridExport;
        this.gridValue = net;
        this.updateValue('liveGrid', { state: net });

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
      const grid = this.gridValue != null ? this.gridValue : this.getPowerValue('liveGrid'); // kW, signed
      const load = this.getPowerValue('liveLoad');
      const bat = this.getPowerValue('liveBat');
      const soc = parseFloat(document.getElementById('liveSoc')?.textContent) || 0;

      // Bottom-up SoC gauge: fill proportional to SoC (0-100), anchored to the bottom.
      const gaugeX = 132, gaugeW = 38, gaugeY = 22, gaugeH = 80;
      const fillH = Math.max(0, Math.min(100, soc)) / 100 * (gaugeH - 4); // 4 = inner padding
      const fillY = gaugeY + (gaugeH - 4) - fillH; // bottom-anchored

      // Simple flow diagram (boxes 180x120; battery shows a bottom-up SoC gauge)
          const w = 660, h = 460;
          svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
          svg.innerHTML = `
            <defs>
              <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--ink)"/>
              </marker>
            </defs>

            <!-- PV Panel -->
            <g transform="translate(20, 40)">
              <rect x="0" y="0" width="180" height="120" rx="10" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
              <text x="90" y="45" text-anchor="middle" fill="var(--sun)" font-weight="700" font-size="17">☀ PV</text>
              <text x="90" y="80" text-anchor="middle" fill="var(--on-panel)" font-weight="700" font-size="26">${pv >= 0 ? '+' : ''}${Utils.fmtPower(pv * 1000)}</text>
              <text x="90" y="105" text-anchor="middle" fill="var(--panel-line)" font-size="14">Generation</text>
            </g>

            <!-- Battery -->
                        <g transform="translate(240, 40)">
                          <rect x="0" y="0" width="180" height="120" rx="10" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
                          <text x="14" y="35" text-anchor="start" fill="var(--sun)" font-weight="700" font-size="17">🔋 Battery</text>
                          <text x="14" y="70" text-anchor="start" fill="var(--on-panel)" font-weight="700" font-size="22">${bat >= 0 ? '+' : ''}${Utils.fmtPower(bat * 1000)}</text>
                          <text x="14" y="98" text-anchor="start" fill="var(--panel-line)" font-size="14">SoC: ${soc.toFixed(0)}%</text>
                          <!-- Battery gauge (bottom-up, proportional) -->
                          <rect x="${gaugeX}" y="${gaugeY}" width="${gaugeW}" height="${gaugeH}" rx="4" fill="none" stroke="var(--panel-line)" stroke-width="2"/>
                          <rect x="${gaugeX + 2}" y="${fillY}" width="${gaugeW - 4}" height="${fillH}" rx="2" fill="${soc > 50 ? 'var(--good)' : soc > 20 ? 'var(--sun)' : 'var(--bad)'}"/>
                        </g>

            <!-- Grid -->
                        <g transform="translate(460, 40)">
                          <rect x="0" y="0" width="180" height="120" rx="10" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
                          <text x="90" y="45" text-anchor="middle" fill="var(--export)" font-weight="700" font-size="17">⚡ Grid</text>
                          <text x="90" y="80" text-anchor="middle" fill="var(--on-panel)" font-weight="700" font-size="26">${Utils.fmtPower(Math.abs(grid) * 1000)}</text>
                          <text x="90" y="105" text-anchor="middle" fill="var(--panel-line)" font-size="14">${grid > 0 ? 'Import' : 'Export'}</text>
                        </g>

            <!-- House Load -->
            <g transform="translate(240, 260)">
              <rect x="0" y="0" width="180" height="120" rx="10" fill="var(--panel)" stroke="var(--panel-line)" stroke-width="2"/>
              <text x="90" y="45" text-anchor="middle" fill="var(--bad)" font-weight="700" font-size="17">🏠 House</text>
              <text x="90" y="80" text-anchor="middle" fill="var(--on-panel)" font-weight="700" font-size="26">${Utils.fmtPower(load * 1000)}</text>
              <text x="90" y="105" text-anchor="middle" fill="var(--panel-line)" font-size="14">Load</text>
            </g>

            <!-- Flow arrows (routed so the export line does NOT cross the battery box) -->
            <g stroke="var(--panel-line)" stroke-width="3" fill="none" marker-end="url(#arrow)">
              <!-- PV -> Battery -->
              <path d="M200 100 Q220 100 240 100" opacity="${this.batCharge > 0 ? 1 : 0.3}"/>
              <!-- PV -> Grid (export) — routed DOWN and ACROSS UNDER the battery, then UP to the Grid box bottom edge -->
                            <path d="M110 160 L110 205 L560 205 L560 160" opacity="${grid < 0 ? 1 : 0.3}"/>
              <!-- Grid -> House (import) — routed under/round the battery -->
              <path d="M550 160 L550 215 L350 215 L350 260" opacity="${grid > 0 ? 1 : 0.3}"/>
              <!-- Battery -> House -->
              <path d="M330 160 Q330 210 330 260" opacity="${this.batDischarge > 0 ? 1 : 0.3}"/>
              <!-- PV -> House -->
              <path d="M110 160 L110 205 L330 205 L330 260" opacity="${pv > 0 ? 1 : 0.3}"/>
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