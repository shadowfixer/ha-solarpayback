// HA SolarPayBack — Runway view (Dashboard paid-back box replacement)
//
// Replaces the old 100-cell panel grid with two tile strips:
//   STRIP 1 "How close to payback"  — 25 square tiles (4% of system cost each), actuals only
//   STRIP 2 "25 years"               — 25 numbered portrait tiles, actuals + projection, with
//                                     a Cautious / Expected / Optimistic scenario toggle.
//
// All payback maths is reused from Calc / Utils — nothing is re-implemented here.
// The Overview view calls render(data) with the data it already loaded, so this module
// does not re-fetch or re-implement the payback calculation.

import { Utils } from '../utils.js';

const SCENARIOS = {
  cautious:   { label: 'Cautious',   baselineFactor: 0.90, priceOffset: -3, exportFactor: 0.6 },
  expected:   { label: 'Expected',   baselineFactor: 1.00, priceOffset:  0, exportFactor: 1.0 },
  optimistic: { label: 'Optimistic', baselineFactor: 1.05, priceOffset:  2, exportFactor: 1.0 }
};

// --- Small date helpers ------------------------------------------------------
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthsBetweenExclusive(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class RunwayView {
  constructor(app) {
    this.app = app;
    this.scenario = 'expected';
    this._bound = false;
  }

  // data: { monthlyData, systemCost, installDate, priceRise, wear, paybackDate }
  render(hostId, data) {
    const host = document.getElementById(hostId);
    if (!host) return;

    const systemCost = parseFloat(data.systemCost) || 0;
    const installDate = data.installDate || '';
    const priceRise = parseFloat(data.priceRise) || 0;
    const wear = parseFloat(data.wear) || 0;
    const monthly = data.monthlyData || [];

    if (!installDate || systemCost <= 0 || monthly.length < 1) {
      host.innerHTML = this.emptyState(!installDate, systemCost <= 0, monthly.length < 1);
      return;
    }

    const install = new Date(installDate);
    const model = this.buildModel(monthly, systemCost, install, priceRise, wear);

    host.innerHTML = this.markup(model, data.paybackDate);
    this.bind(host);
  }

  emptyState(noInstall, noCost, noData) {
    const parts = [];
    if (noInstall) parts.push('<strong>Install Date</strong>');
    if (noCost) parts.push('<strong>System Cost</strong>');
    if (noData) parts.push('at least <strong>one month of data</strong> (or sync from HA)');
    return `<div class="runway-empty muted">Set your ${parts.join(', ')} in Settings to see your payback runway.</div>`;
  }

  // --- Model --------------------------------------------------------------
  buildModel(monthly, systemCost, install, priceRise, wear) {
    const now = new Date();
    const last = monthly[monthly.length - 1];
    const paidBack = last ? last.cumulative : 0;
    const paidPct = systemCost > 0 ? Math.min(100, paidBack / systemCost * 100) : 0;

    // Baseline annual saving: last 12 complete months, else seasonally-adjusted.
    const nowKey = Utils.monthKey(now);
    const complete = monthly.filter(m => m.month < nowKey);
    let baselineAnnual;
    if (complete.length >= 12) {
      baselineAnnual = complete.slice(-12).reduce((s, m) => s + (m.totalSaved || 0), 0);
    } else {
      baselineAnnual = Utils.projectAnnual(monthly.map(m => m.totalSaved || 0), install);
    }
    if (!isFinite(baselineAnnual)) baselineAnnual = 0;

    // Export share of historical savings (to discount export under "cautious").
    const totalSaved = monthly.reduce((s, m) => s + (m.totalSaved || 0), 0);
    const exportTotal = monthly.reduce((s, m) => s + (m.exportIncome || 0), 0);
    const exportShare = totalSaved > 0 ? exportTotal / totalSaved : 0;

    // Per-year windows (year 1 begins at install date).
    const windows = Array.from({ length: 25 }, (_, i) => ({
      start: addMonths(install, i * 12),
      end: addMonths(install, (i + 1) * 12)
    }));

    // Per-scenario savings array.
    const savings = {};
    for (const key of Object.keys(SCENARIOS)) {
      const sc = SCENARIOS[key];
      const effBaseline = Math.max(0, baselineAnnual * sc.baselineFactor * (1 - exportShare + exportShare * sc.exportFactor));
      const pr = Math.max(0, priceRise + sc.priceOffset);
      savings[key] = windows.map((w, i) => {
        if (w.end <= now) {
          return monthly
            .filter(m => { const d = Utils.parseMonthKey(m.month); return d >= w.start && d < w.end; })
            .reduce((a, m) => a + (m.totalSaved || 0), 0);
        }
        if (w.start <= now && now < w.end) {
          const actual = monthly
            .filter(m => { const d = Utils.parseMonthKey(m.month); return d >= w.start && d <= now; })
            .reduce((a, m) => a + (m.totalSaved || 0), 0);
          const remaining = monthsBetweenExclusive(now, w.end);
          return actual + (effBaseline / 12) * remaining;
        }
        return effBaseline * Math.pow(1 - wear / 100, i) * Math.pow(1 + pr / 100, i);
      });
    }

    return { install, windows, paidBack, paidPct, systemCost, savings };
  }

  // Break-even: first year cumulative >= cost, fractional within that year.
  analyze(years, systemCost) {
    let cum = 0;
    let breakEven = null;
    for (let i = 0; i < 25; i++) {
      const ysave = Math.max(0, years[i]);
      const before = cum;
      cum += ysave;
      if (!breakEven && systemCost > 0 && cum >= systemCost) {
        const denom = ysave > 0 ? ysave : 1;
        breakEven = { year: i + 1, years: i + Math.min(1, Math.max(0, (systemCost - before) / denom)) };
        break;
      }
    }
    return { breakEven, netAfter25: cum - systemCost };
  }

  // --- Markup --------------------------------------------------------------
  markup(model, paybackDate) {
    const dateStr = paybackDate
      ? paybackDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
      : '—';

    const strip1 = this.strip1(model);
    const { breakEven, netAfter25 } = this.analyze(model.savings[this.scenario], model.systemCost);
    const strip2 = this.strip2(model, breakEven);
    const positions = Object.fromEntries(Object.keys(SCENARIOS).map(k =>
      [k, this.analyze(model.savings[k], model.systemCost).breakEven]));

    return `
      <div class="runway">
        <div class="runway-sec">
          <h3 class="runway-title">How close to payback</h3>
          <p class="runway-sub muted">${Utils.fmtCurrency(model.paidBack, 0)} paid back — ${Utils.fmtPct(model.paidPct, 1)} of ${Utils.fmtCurrency(model.systemCost)} · projected payback <strong>${dateStr}</strong></p>
          <div class="runway-strip1" role="img" aria-label="How close to payback: 25 tiles, each 4% of the system cost">
            ${strip1}
          </div>
        </div>

        <div class="runway-sec">
          <div class="runway-head">
            <h3 class="runway-title">25 years</h3>
            <div class="runway-scen" role="group" aria-label="Scenario">
              ${Object.keys(SCENARIOS).map(k => `
                <button type="button" class="runway-scen-btn ${k === this.scenario ? 'active' : ''}" data-scen="${k}"
                  aria-pressed="${k === this.scenario}">${SCENARIOS[k].label}</button>`).join('')}
            </div>
          </div>
          <div class="runway-strip2" role="img" aria-label="25 year projection; amber before, green after, split at break-even">
            ${strip2}
          </div>
          <div class="runway-readout">
            ${this.readout(breakEven, netAfter25)}
            ${this.range(positions)}
          </div>
        </div>

        <div class="runway-tip" role="status" aria-live="polite" hidden></div>
      </div>`;
  }

  strip1(model) {
    const { paidPct } = model;
    let out = '';
    for (let i = 0; i < 25; i++) {
      const tileMin = i * 4;
      const inProgress = paidPct > tileMin && paidPct < tileMin + 4;
      const recovered = paidPct >= tileMin + 4;
      let style = 'background:var(--runway-amber);';
      if (inProgress) {
        const frac = Math.min(1, Math.max(0, (paidPct - tileMin) / 4));
        style = `background:linear-gradient(90deg, var(--runway-green) ${(frac * 100).toFixed(1)}%, var(--runway-amber) ${(frac * 100).toFixed(1)}%);`;
      } else if (recovered) {
        style = 'background:var(--runway-green);';
      }
      out += `<span class="runway-square" role="img" tabindex="0" aria-label="Tile ${i + 1}: ${recovered ? 'recovered' : inProgress ? 'in progress' : 'to recover'}" style="${style}"></span>`;
    }
    return out;
  }

  strip2(model, breakEven) {
    const years = model.savings[this.scenario];
    let cum = 0;
    let out = '';
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      const ysave = Math.max(0, years[i]);
      const before = cum;
      cum += ysave;

      const isBreak = breakEven && breakEven.year === i + 1;
      const isAfter = breakEven && i + 1 > breakEven.year;

      let style = 'background:var(--runway-amber);';
      let cls = 'runway-year';
      if (isBreak) {
        const denom = ysave > 0 ? ysave : 1;
        const frac = Math.min(1, Math.max(0, (model.systemCost - before) / denom));
        cls += ' runway-split';
        style = `background:linear-gradient(90deg, var(--runway-amber) ${(frac * 100).toFixed(1)}%, var(--runway-green) ${(frac * 100).toFixed(1)}%);`;
      } else if (isAfter) {
        cls += ' runway-recovered';
        style = 'background:var(--runway-green);';
      } else {
        cls += ' runway-pending';
      }
      if (model.windows[i].start > now) cls += ' runway-projected';

      const ahead = Math.max(0, cum - model.systemCost);
      const behind = Math.max(0, model.systemCost - cum);
      const tip = `Year ${i + 1}: saves ${Utils.fmtCurrency(ysave, 0)}. ` +
        (cum >= model.systemCost
          ? `Running total ${Utils.fmtCurrency(ahead, 0)} ahead`
          : `${Utils.fmtCurrency(behind, 0)} still to recover`);

      out += `<span class="${cls}" tabindex="0" role="img" data-tip="${escapeAttr(tip)}" aria-label="${escapeAttr(tip)}" style="${style}">${i + 1}</span>`;
    }
    return out;
  }

  readout(breakEven, netAfter25) {
    if (!breakEven) {
      return `<span class="muted">Not reached within 25 years — consider a higher export rate or lower cost.</span>`;
    }
    const monthIdx = Math.round((breakEven.years - (breakEven.year - 1)) * 12);
    const monthLabel = monthIdx <= 1 ? 'Jan' : new Date(0, monthIdx - 1).toLocaleString(undefined, { month: 'short' });
    return `<span><strong>Break-even in ${breakEven.years.toFixed(1)} years</strong></span>
            <span class="muted">(year ${breakEven.year}, ${monthLabel})</span>
            <span class="runway-net">${netAfter25 >= 0 ? `${Utils.fmtCurrency(netAfter25, 0)} ahead after 25 years` : `${Utils.fmtCurrency(Math.abs(netAfter25), 0)} still owing after 25 years`}</span>`;
  }

  range(positions) {
    const vals = Object.values(positions).filter(v => v && isFinite(v.years)).map(v => v.years);
    if (!vals.length) return '';
    // Position dots on the SAME 0–25 year scale as the tiles above, so a dot at
    // (years/25) sits exactly above its Year tile. E.g. 15.8 yrs -> 63%, 18.7 -> 75%.
    const pct = (y) => Math.min(100, Math.max(0, (y / 25) * 100));
    const dots = Object.entries(positions).map(([k, v]) => {
      if (!v || !isFinite(v.years)) return '';
      return `<span class="runway-dot ${this.scenario === k ? 'active' : ''} runway-dot-${k}" data-scen="${k}"
        style="left:${pct(v.years).toFixed(1)}%" title="${SCENARIOS[k].label}: break-even ${v.years.toFixed(1)} yrs" aria-hidden="true"></span>`;
    }).join('');
    const labels = Object.keys(SCENARIOS).map(k => {
      const v = positions[k];
      const active = this.scenario === k;
      return `<button type="button" class="runway-scen-label ${active ? 'active' : ''}" data-scen="${k}"
        aria-pressed="${active}">${SCENARIOS[k].label} ${v ? v.years.toFixed(1) : '—'}y</button>`;
    }).join('');
    return `<div class="runway-range-track"><div class="runway-range-line"></div>${dots}</div>
            <div class="runway-range-legend">${labels}</div>`;
  }

  bind(host) {
    // Single delegated listener catches clicks on the header buttons, the range-bar
    // dots AND labels. Delegation survives innerHTML re-renders (direct per-element
    // listeners on buttons would be dropped the first time the view re-renders).
    if (!this._bound) {
      this._bound = true;
      host.addEventListener('click', (e) => {
        const t = e.target.closest('.runway-scen-btn, .runway-dot, .runway-scen-label');
        if (t && t.dataset && t.dataset.scen) {
          this.scenario = t.dataset.scen;
          if (this.app) this.app.refreshAllViews();
        }
      });
    }

    host.addEventListener('mouseover', (e) => this.positionTip(e, host));
    host.addEventListener('focusin', (e) => this.positionTip(e, host));
    host.addEventListener('mouseleave', () => this.hideTip(host));
    host.addEventListener('focusout', (e) => { if (!host.contains(e.relatedTarget)) this.hideTip(host); });
  }

  positionTip(e, host) {
    const tile = e.target && e.target.closest && e.target.closest('.runway-year');
    const tip = host.querySelector('.runway-tip');
    if (!tile || !tip) return;
    tip.textContent = tile.dataset.tip || '';
    tip.hidden = false;
  }
  hideTip(host) {
    const tip = host.querySelector('.runway-tip');
    if (tip) tip.hidden = true;
  }

  destroy() { this._bound = false; }
}

window.HASolarPayBackRunway = RunwayView;