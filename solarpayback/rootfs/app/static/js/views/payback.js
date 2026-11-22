// HA SolarPayBack — Payback Projection View

import { Utils } from '../utils.js';
import { storage } from '../storage.js';
import { Calc } from '../calc.js';

export class PaybackView {
  constructor(app) {
    this.app = app;
    this.monthlyData = [];
    this.systemCost = 0;
    this.mcsAnnual = 0;
    this.installDate = '';
  }

  async render() {
    await this.loadData();
    this.renderCumulativeChart();
    this.renderPaybackMovementChart();
  }

  async loadData() {
      const settings = await storage.getAllSettings();
      this.systemCost = parseFloat(settings.systemCost) || 0;
      this.mcsAnnual = parseFloat(settings.mcsAnnual) || 0;
      this.installDate = settings.installDate || '';
      this.exportStartDate = settings.exportStartDate || null;

      // Use Calc.recalculateAll which already includes grid events in monthly totals
      this.monthlyData = await Calc.recalculateAll(this.systemCost, this.mcsAnnual, this.installDate, this.exportStartDate);

    // Also get raw monthly data (with battery components) for without-battery calculation
    this.rawMonths = await storage.getAllMonths();
    this.rawMonths.sort((a, b) => a.month.localeCompare(b.month));
  }

  // Calculate cumulative savings for both scenarios
  // WITH battery: solar self-use + export income + battery saving + grid events
  // WITHOUT battery: solar self-use + export income only (grid events included as external income)
  calculateCumulativeScenarios() {
    const withBattery = [];
    const withoutBattery = [];

    let cumWith = 0;
    let cumWithout = 0;

    for (const month of this.monthlyData) {
      // With battery = totalSaved (already includes: solarUsedValue + exportIncome + batterySaving + gridEventIncome)
      cumWith += month.totalSaved;
      withBattery.push({
        month: month.month,
        cumulative: cumWith,
        ...month
      });

      // Without battery = totalSaved - batterySaving - gridEventIncome (grid events are external, so KEEP them per user requirement)
      // Actually user said: "grid events should count in BOTH scenarios since they are external income not battery-dependent"
      const withoutBatterySaving = month.totalSaved - month.batterySaving;
      cumWithout += withoutBatterySaving;
      withoutBattery.push({
        month: month.month,
        cumulative: cumWithout,
        ...month
      });
    }

    return { withBattery, withoutBattery };
  }

  // Find payback date (month where cumulative >= systemCost)
  findPaybackDate(scenarioData) {
    const crossed = scenarioData.find(m => m.cumulative >= this.systemCost);
    if (!crossed) return null;

    // Interpolate for more precise date
    const prev = scenarioData[scenarioData.indexOf(crossed) - 1];
    if (!prev) return Utils.parseMonthKey(crossed.month);

    const prevCum = prev.cumulative;
    const currCum = crossed.cumulative;
    const monthStart = Utils.parseMonthKey(crossed.month);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const fraction = (this.systemCost - prevCum) / (currCum - prevCum);
    const daysInMonth = (monthEnd - monthStart) / (1000 * 60 * 60 * 24);
    const paybackDate = new Date(monthStart.getTime() + fraction * daysInMonth * 24 * 60 * 60 * 1000);

    return paybackDate;
  }

  renderCumulativeChart() {
    const container = document.getElementById('cumulativeChart');
    const datesContainer = document.getElementById('paybackDates');
    if (!container) return;

    const { withBattery, withoutBattery } = this.calculateCumulativeScenarios();
    const paybackWith = this.findPaybackDate(withBattery);
    const paybackWithout = this.findPaybackDate(withoutBattery);

    // Render payback dates
    datesContainer.innerHTML = `
      <div class="payback-date with-battery" style="padding:8px 12px; background:var(--sun-soft); border:1px solid var(--sun); border-radius:8px;">
        <strong style="color:var(--sun-ink);">With Battery:</strong>
        <span class="num" style="margin-left:8px;">${paybackWith ? paybackWith.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'Not reached'}</span>
      </div>
      <div class="payback-date without-battery" style="padding:8px 12px; background:var(--export); color:white; border-radius:8px;">
        <strong>Without Battery:</strong>
        <span class="num" style="margin-left:8px;">${paybackWithout ? paybackWithout.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'Not reached'}</span>
      </div>
    `;

    // SVG chart dimensions
    const width = Math.min(720, container.clientWidth || 720);
    const height = 320;
    const padding = { top: 20, right: 80, bottom: 40, left: 80 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Data points for lines
    const allPoints = [...withBattery, ...withoutBattery];
    const maxCumulative = Math.max(...allPoints.map(p => p.cumulative), this.systemCost * 1.1);
    const minCumulative = Math.min(0, ...allPoints.map(p => p.cumulative));

    const months = withBattery.map(m => m.month);
    const xStep = chartWidth / Math.max(1, months.length - 1);

    // Scales
    const xScale = (i) => padding.left + i * xStep;
    const yScale = (val) => padding.top + chartHeight - ((val - minCumulative) / (maxCumulative - minCumulative)) * chartHeight;

    // Build path data for with-battery line
    const withPath = withBattery.map((m, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(m.cumulative)}`).join(' ');
    const withoutPath = withoutBattery.map((m, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(m.cumulative)}`).join(' ');

    // System cost line
    const costY = yScale(this.systemCost);
    const costLine = `M ${padding.left} ${costY} L ${width - padding.right} ${costY}`;

    // X-axis labels (show every nth month to avoid crowding)
    const labelStep = Math.max(1, Math.ceil(months.length / 10));
    const xLabels = months.map((m, i) => {
      if (i % labelStep !== 0 && i !== months.length - 1) return '';
      const x = xScale(i);
      return `<text x="${x}" y="${height - padding.bottom + 18}" text-anchor="middle" font-size="0.7rem" fill="var(--muted)">${Utils.formatMonth(m)}</text>`;
    }).join('');

    // Y-axis labels (5 ticks)
    const yTicks = 5;
    const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
      const val = minCumulative + (maxCumulative - minCumulative) * (i / yTicks);
      const y = yScale(val);
      return `
        <line x1="${padding.left - 6}" y1="${y}" x2="${padding.left}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
        <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" font-size="0.7rem" fill="var(--muted)">${Utils.fmtCurrency(val, 0)}</text>
      `;
    }).join('');

    // Grid lines
    const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
      const val = minCumulative + (maxCumulative - minCumulative) * (i / yTicks);
      const y = yScale(val);
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--line)" stroke-width="0.5" opacity="0.5"/>`;
    }).join('');

    // Vertical grid lines
    const vGridLines = months.map((_, i) => {
      const x = xScale(i);
      return `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="0.5" opacity="0.3"/>`;
    }).join('');

    // Payback marker circles
    const paybackMarkers = [];
    if (paybackWith) {
      const idx = withBattery.findIndex(m => m.cumulative >= this.systemCost);
      if (idx >= 0) {
        const x = xScale(idx);
        const y = yScale(withBattery[idx].cumulative);
        paybackMarkers.push(`
          <circle cx="${x}" cy="${y}" r="6" fill="var(--sun)" stroke="var(--surface)" stroke-width="2"/>
          <text x="${x}" y="${y - 12}" text-anchor="middle" font-size="0.65rem" fill="var(--sun-ink)" font-weight="700">Payback</text>
        `);
      }
    }
    if (paybackWithout) {
      const idx = withoutBattery.findIndex(m => m.cumulative >= this.systemCost);
      if (idx >= 0) {
        const x = xScale(idx);
        const y = yScale(withoutBattery[idx].cumulative);
        paybackMarkers.push(`
          <circle cx="${x}" cy="${y}" r="6" fill="var(--export)" stroke="var(--surface)" stroke-width="2"/>
          <text x="${x}" y="${y - 12}" text-anchor="middle" font-size="0.65rem" fill="white" font-weight="700">Payback</text>
        `);
      }
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block;" role="img" aria-label="Cumulative savings chart with battery vs without battery">
        <!-- Grid -->
        ${gridLines}
        ${vGridLines}

        <!-- System cost threshold line -->
        <path d="${costLine}" stroke="var(--bad)" stroke-width="2" stroke-dasharray="6,4" fill="none"/>
        <text x="${width - padding.right + 10}" y="${costY - 4}" font-size="0.7rem" fill="var(--bad)" font-weight="600">System Cost (${Utils.fmtCurrency(this.systemCost, 0)})</text>

        <!-- Without battery line -->
        <path d="${withoutPath}" stroke="var(--export)" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- With battery line -->
        <path d="${withPath}" stroke="var(--sun)" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Payback markers -->
        ${paybackMarkers.join('')}

        <!-- Y axis -->
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="1"/>
        ${yLabels}

        <!-- X axis -->
                <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="1"/>
                ${xLabels}
              </svg>

              <!-- Legend (below chart) -->
              <div style="display:flex; gap:24px; justify-content:center; flex-wrap:wrap; margin-top:10px; font-size:0.8rem; font-weight:600;">
                <span style="display:inline-flex; align-items:center; gap:6px; color:var(--sun);">
                  <span style="width:22px; height:3px; background:var(--sun); border-radius:2px; display:inline-block;"></span>
                  With Battery
                </span>
                <span style="display:inline-flex; align-items:center; gap:6px; color:var(--export);">
                  <span style="width:22px; height:3px; background:var(--export); border-radius:2px; display:inline-block;"></span>
                  Without Battery
                </span>
              </div>
            `;
  }

  // Calculate projected payback date at each observation point (month)
  // This shows how the payback date MOVES over time as real data accumulates
  calculatePaybackMovement() {
    const movement = [];

    // For each month in the data, recalculate payback date using only data up to that month
    for (let i = 0; i < this.monthlyData.length; i++) {
      const dataUpToMonth = this.monthlyData.slice(0, i + 1);
      const paybackDate = Calc.estimatePaybackDate(dataUpToMonth, this.systemCost, this.installDate);

      if (paybackDate) {
        movement.push({
          observationMonth: this.monthlyData[i].month,
          observationDate: Utils.parseMonthKey(this.monthlyData[i].month),
          projectedPaybackDate: paybackDate
        });
      }
    }

    return movement;
  }

  renderPaybackMovementChart() {
    const container = document.getElementById('paybackMovementChart');
    if (!container) return;

    const movement = this.calculatePaybackMovement();
    if (movement.length < 2) {
      container.innerHTML = '<p class="muted" style="text-align:center; padding:40px;">Need at least 2 months of data to show payback date movement.</p>';
      return;
    }

    // SVG chart dimensions
    const width = Math.min(720, container.clientWidth || 720);
    const height = 320;
    const padding = { top: 20, right: 20, bottom: 40, left: 80 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // X-axis: observation dates (months)
    const obsDates = movement.map(m => m.observationDate);
    const xStep = chartWidth / Math.max(1, obsDates.length - 1);
    const xScale = (i) => padding.left + i * xStep;

    // Y-axis: projected payback dates (convert to timestamps for scaling)
    const paybackTimestamps = movement.map(m => m.projectedPaybackDate.getTime());
    const minTs = Math.min(...paybackTimestamps);
    const maxTs = Math.max(...paybackTimestamps);
    // Add some padding to Y axis
    const tsRange = maxTs - minTs;
    const yMin = minTs - tsRange * 0.1;
    const yMax = maxTs + tsRange * 0.1;

    const yScale = (ts) => padding.top + chartHeight - ((ts - yMin) / (yMax - yMin)) * chartHeight;

    // Build path
    const pathData = movement.map((m, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(m.projectedPaybackDate.getTime())}`).join(' ');

    // X-axis labels (every nth)
    const labelStep = Math.max(1, Math.ceil(movement.length / 8));
    const xLabels = movement.map((m, i) => {
      if (i % labelStep !== 0 && i !== movement.length - 1) return '';
      const x = xScale(i);
      return `<text x="${x}" y="${height - padding.bottom + 18}" text-anchor="middle" font-size="0.7rem" fill="var(--muted)">${Utils.formatMonth(m.observationMonth)}</text>`;
    }).join('');

    // Y-axis labels (5 ticks, formatted as dates)
    const yTicks = 5;
    const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
      const ts = yMin + (yMax - yMin) * (i / yTicks);
      const date = new Date(ts);
      const y = yScale(ts);
      return `
        <line x1="${padding.left - 6}" y1="${y}" x2="${padding.left}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
        <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" font-size="0.7rem" fill="var(--muted)">${date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</text>
      `;
    }).join('');

    // Grid lines
    const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
      const ts = yMin + (yMax - yMin) * (i / yTicks);
      const y = yScale(ts);
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--line)" stroke-width="0.5" opacity="0.5"/>`;
    }).join('');

    const vGridLines = movement.map((_, i) => {
      const x = xScale(i);
      return `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="0.5" opacity="0.3"/>`;
    }).join('');

    // Current actual payback date (if already reached)
    const lastMonthData = this.monthlyData[this.monthlyData.length - 1];
    const actualCumulative = lastMonthData ? lastMonthData.cumulative : 0;
    const alreadyPaidBack = actualCumulative >= this.systemCost;

    // Add a horizontal line for "today" (the last observation's projected date = current best estimate)
    const currentBestEstimate = movement[movement.length - 1]?.projectedPaybackDate;
    const currentEstimateY = currentBestEstimate ? yScale(currentBestEstimate.getTime()) : null;

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block;" role="img" aria-label="Projected payback date movement over time">
        <!-- Grid -->
        ${gridLines}
        ${vGridLines}

        ${currentEstimateY !== null ? `
        <!-- Current best estimate line -->
        <line x1="${padding.left}" y1="${currentEstimateY}" x2="${width - padding.right}" y2="${currentEstimateY}" stroke="var(--sun)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.7"/>
        <text x="${width - padding.right + 8}" y="${currentEstimateY - 4}" font-size="0.65rem" fill="var(--sun)" font-weight="600">Current estimate: ${currentBestEstimate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</text>
        ` : ''}

        <!-- Movement line -->
        <path d="${pathData}" stroke="var(--panel)" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Data points -->
        ${movement.map((m, i) => `
          <circle cx="${xScale(i)}" cy="${yScale(m.projectedPaybackDate.getTime())}" r="4" fill="var(--panel)" stroke="var(--surface)" stroke-width="2"
            title="Observation: ${Utils.formatMonth(m.observationMonth)} → Projected payback: ${m.projectedPaybackDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}"/>
        `).join('')}

        <!-- Y axis -->
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="1"/>
        ${yLabels}

        <!-- X axis -->
        <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="1"/>
        ${xLabels}

        <!-- Legend/annotation -->
        <text x="${padding.left}" y="${padding.top - 6}" font-size="0.7rem" fill="var(--muted)">
          Downward trend = payback pulled earlier (good). Upward = pushed later.
        </text>
      </svg>
    `;
  }

  destroy() {
    // Cleanup if needed
  }
}

window.HASolarPayBackPaybackView = PaybackView;