// HA SunBack — Main Application

import { haApi } from './ha-api.js';
import { storage } from './storage.js';
import { Calc } from './calc.js';
import { OverviewView } from './views/overview.js';
import { LiveView } from './views/live.js';
import { HistoryView } from './views/history.js';
import { SettingsView } from './views/settings.js';
import { PaybackView } from './views/payback.js';
import { Utils } from './utils.js';

class HASunBackApp {
  constructor() {
    this.views = {};
    this.currentView = 'overview';
    this.initialized = false;
  }

  async init() {
    // Load saved HA config
    await haApi.init();

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

    // Show connection status
    this.updateConnectionBanner();

    // Initial view
    this.showView('overview');

    this.initialized = true;
    console.log('HA SunBack initialized');

    // If HA is configured, auto-connect and sync historical data
    if (haApi.isConfigured()) {
      try {
        await haApi.init();
        const resp = await haApi.testConnection();
        if (resp) {
          this.showToast('Connected to Home Assistant');
          // Sync historical monthly data from HA
          await this.views.overview.refreshFromHA();
        }
        this.refreshAllViews();
      } catch (e) {
        this.showConnectionError(e.message);
      }
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
    const status = document.getElementById('connStatus');

    if (haApi.isConfigured()) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.classList.remove('error');
      status.textContent = 'Not connected to Home Assistant. Go to Settings to configure.';
    }
  }

  async initializeHA() {
    try {
      await haApi.init();
      this.updateConnectionBanner();

      // Test connection
      const resp = await haApi.testConnection();
      if (resp) {
        this.showToast('Connected to Home Assistant');
        // Auto-detect entities
        const entities = await haApi.detectFoxEntities();
        console.log('Detected Fox ESS entities:', entities);
      }
      this.refreshAllViews();
    } catch (e) {
      this.showConnectionError(e.message);
    }
  }

  showConnectionError(msg) {
    const banner = document.getElementById('connBanner');
    const status = document.getElementById('connStatus');
    banner.hidden = false;
    banner.classList.add('error');
    status.textContent = `Connection failed: ${msg}`;
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
const app = new HASunBackApp();
window.HASunBackApp = app;

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => app.init());

// Handle page unload
window.addEventListener('beforeunload', () => {
  const view = app.views[app.currentView];
  if (view && view.destroy) view.destroy();
});