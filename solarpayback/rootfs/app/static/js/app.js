// HA SolarPayBack — Main Application (Add-on version)
// No HA token/config in browser — backend handles HA via Supervisor token

// Cache-busting: each sub-import carries ?v=<release> so a fresh app.js (loaded with a
// new ?v= from index.html) always fetches the current module copies — never a stale
// browser-cached ES module. Bump together with the version in config.yaml.
import { storage } from './storage.js?v=1.2.0';
import { Calc } from './calc.js?v=1.2.0';
import { OverviewView } from './views/overview.js?v=1.2.0';
import { LiveView } from './views/live.js?v=1.2.0';
import { HistoryView } from './views/history.js?v=1.2.0';
import { SettingsView } from './views/settings.js?v=1.2.0';
import { PaybackView } from './views/payback.js?v=1.2.0';
import { Utils } from './utils.js?v=1.2.0';

class HASolarPayBackApp {
  constructor() {
    this.views = {};
    this.currentView = 'overview';
    this.initialized = false;
  }

  async init() {
    // Initialize views
    this.views.overview = new OverviewView(this);
    this.views.live = new LiveView(this);
    this.views.history = new HistoryView(this);
    this.views.settings = new SettingsView(this);
    this.views.payback = new PaybackView(this);

    // Set up routing
    this.setupRouting();
    this.setupModals();
    this.setupAddMonthButton();

    // Hide connection banner (no per-browser HA config needed)
    this.updateConnectionBanner();

    // Initial view
        this.showView('overview');

        this.initialized = true;
        console.log('HA SolarPayBack (add-on) initialized');

        // Auto-load data (settings, tariffs, grid events, monthly data from server)
        this.refreshAllViews();

        // Auto-sync (A): if there is no monthly data yet, pull historical month
        // data from HA automatically so the dashboard isn't blank. Keep the manual
        // "Sync Monthly Data from HA" button in Settings for forced re-syncs (B).
        this.autoSyncFromHA();
      }

      async autoSyncFromHA() {
        try {
          const months = await storage.getAllMonths();
          if (months.length > 0) {
            console.log('Auto-sync skipped: monthly data already present');
            return;
          }
          const settings = await storage.getAllSettings();
          if (!settings.installDate) {
            console.log('Auto-sync deferred: no install date set yet');
            return;
          }
          console.log('Auto-sync: pulling historical monthly data from HA...');
          await this.views.overview.refreshFromHA();
        } catch (e) {
          console.error('Auto-sync failed:', e);
        }
      }

      setupRouting() {
        // Handle hash changes
        window.addEventListener('hashchange', () => this.handleRoute());
        this.handleRoute();

        // Nav clicks
        document.querySelectorAll('.nav-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.preventDefault();
            const view = item.dataset.view;
            this.showView(view);
            history.pushState(null, '', `#${view}`);
          });
        });
      }

  handleRoute() {
    const hash = window.location.hash.slice(1) || 'overview';
    this.showView(hash);
  }

  showView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.hidden = true);
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // Show target view
    const view = document.getElementById(`view-${viewName}`);
    const nav = document.querySelector(`.nav-item[data-view="${viewName}"]`);
    if (view) view.hidden = false;
    if (nav) nav.classList.add('active');

    // Destroy previous view if needed
    if (this.currentView && this.currentView !== viewName) {
      const prevView = this.views[this.currentView];
      if (prevView && prevView.destroy) prevView.destroy();
    }

    this.currentView = viewName;

    // Render new view
    const newView = this.views[viewName];
    if (newView && newView.render) {
      newView.render().catch(e => console.error(`Error rendering ${viewName}:`, e));
    }
  }

  setupModals() {
    const overlay = document.getElementById('modalOverlay');
    const modal = document.getElementById('modalAddMonth');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const form = document.getElementById('formAddMonth');

    const openModal = () => {
      modal.hidden = false;
      overlay.hidden = false;
      // Set default to current month
      const now = new Date();
      document.getElementById('amMonth').value = Utils.monthKey(now);
    };

    const closeModal = () => {
      modal.hidden = true;
      overlay.hidden = true;
      form.reset();
    };

    document.getElementById('btnAddMonth').addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const month = document.getElementById('amMonth').value;
      const data = {
        generated: parseFloat(document.getElementById('amGen').value) || 0,
        exported: parseFloat(document.getElementById('amExp').value) || 0,
        gridImport: parseFloat(document.getElementById('amGrid').value) || 0,
        batCharge: parseFloat(document.getElementById('amBatChg').value) || 0,
        batDischarge: parseFloat(document.getElementById('amBatDis').value) || 0,
        gridEvents: 0
      };
      await storage.saveMonth(month, data);
      closeModal();
      this.showToast('Month added');
      this.refreshAllViews();
    });
  }

  setupAddMonthButton() {
    // Already handled in setupModals
  }

  async openEditMonth(monthKey) {
    const month = await storage.getMonth(monthKey);
    if (!month) return;

    const modal = document.getElementById('modalAddMonth');
    document.getElementById('amMonth').value = monthKey;
    document.getElementById('amGen').value = month.generated || '';
    document.getElementById('amExp').value = month.exported || '';
    document.getElementById('amGrid').value = month.gridImport || '';
    document.getElementById('amBatChg').value = month.batCharge || '';
    document.getElementById('amBatDis').value = month.batDischarge || '';
    modal.hidden = false;
    document.getElementById('modalOverlay').hidden = false;
    modal.dataset.editing = monthKey;
  }

  updateConnectionBanner() {
    const banner = document.getElementById('connBanner');
    // In add-on mode, HA is handled server-side — no banner needed
    banner.hidden = true;
  }

  refreshAllViews() {
    const view = this.views[this.currentView];
    if (view && view.render) {
      view.render().catch(e => console.error('Refresh error:', e));
    }
  }

  showToast(message, isError = false) {
    // Simple toast notification
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      padding: 12px 20px; border-radius: 8px; z-index: 1000;
      background: ${isError ? 'var(--bad)' : 'var(--good)'}; color: white;
      font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: slideUp 0.3s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideUp 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// Add toast animation
const style = document.createElement('style');
style.textContent = `
  @keyframes slideUp {
    from { opacity: 0; transform: translateX(-50%) translateY(20px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
`;
document.head.appendChild(style);

// Initialize app
const app = new HASolarPayBackApp();
window.HASolarPayBackApp = app;

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => app.init());

// Handle page unload
window.addEventListener('beforeunload', () => {
  const view = app.views[app.currentView];
  if (view && view.destroy) view.destroy();
});