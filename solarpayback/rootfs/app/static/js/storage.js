// HA SolarPayBack — Server-Backed Storage (replaces IndexedDB storage.js)
// All operations call the add-on's /api/* endpoints

import { api } from './api.js';
import { Utils } from './utils.js';

export class Storage {
  constructor() {
    this._haSyncPending = false;
  }

  // ID generation (same as before for compatibility)
  _uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Settings
  async getSetting(key, defaultValue = null) {
    const settings = await this.getAllSettings();
    return settings[key] ?? defaultValue;
  }

  async setSetting(key, value) {
    const settings = await this.getAllSettings();
    settings[key] = value;
    await this.putSettings(settings);
  }

  async getAllSettings() {
    return api.getSettings();
  }

  async putSettings(settings) {
    return api.putSettings(settings);
  }

  // Monthly Data
  async saveMonth(monthKey, data) {
    const year = parseInt(monthKey.split('-')[0], 10);
    const payload = { month: monthKey, year, ...data };
    return api.saveMonthlyData(payload);
  }

  async getMonth(monthKey) {
    return api.getMonthlyData(monthKey);
  }

  async getAllMonths() {
    return api.getMonthlyData();
  }

  async getMonthsInRange(startYear, endYear) {
    const all = await this.getAllMonths();
    return all.filter(m => m.year >= startYear && m.year <= endYear);
  }

  async deleteMonth(monthKey) {
    return api.deleteMonthlyData(monthKey);
  }

  // Clear all data (danger zone)
  async clearAll() {
    // Delete all months, tariffs, grid events, settings
    const [months, tariffs, events] = await Promise.all([
      this.getAllMonths(),
      this.getAllTariffs(),
      this.getAllGridEvents()
    ]);

    await Promise.all([
      ...months.map(m => this.deleteMonth(m.month)),
      ...tariffs.map(t => this.deleteTariff(t.id)),
      ...events.map(e => this.deleteGridEvent(e.id)),
      this.putSettings({}) // Clear settings
    ]);
  }

  // Export all data for backup
  async exportAll() {
    const [settings, months, tariffs, gridEvents] = await Promise.all([
      this.getAllSettings(),
      this.getAllMonths(),
      this.getAllTariffs(),
      this.getAllGridEvents()
    ]);
    return { settings, months, tariffs, gridEvents, exportedAt: new Date().toISOString() };
  }

  // Import data
  async importAll(data) {
    if (data.settings) {
      await this.putSettings(data.settings);
    }
    if (data.months) {
      for (const month of data.months) {
        await this.saveMonth(month.month, month);
      }
    }
    if (data.tariffs) {
      for (const tariff of data.tariffs) {
        await this.saveTariff(tariff);
      }
    }
    if (data.gridEvents) {
      for (const event of data.gridEvents) {
        await this.saveGridEvent(event);
      }
    }
  }

  // Tariff History
  async saveTariff(tariff) {
    const id = tariff.id || this._uuid();
    await api.saveTariff({ ...tariff, id });
    return id;
  }

  async getAllTariffs() {
    return api.getTariffs();
  }

  async deleteTariff(id) {
    return api.deleteTariff(id);
  }

  // Grid Events
  async saveGridEvent(event) {
    const id = event.id || this._uuid();
    await api.saveGridEvent({ ...event, id });
    return id;
  }

  async getAllGridEvents() {
    return api.getGridEvents();
  }

  async getGridEventsForMonth(monthKey) {
    return api.getGridEvents(monthKey);
  }

  async deleteGridEvent(id) {
    return api.deleteGridEvent(id);
  }

  // HA Sync (trigger backend to pull from HA history)
  async syncFromHA() {
    // This calls the overview view's refreshFromHA equivalent
    // The backend doesn't have a direct "sync" endpoint, but the frontend
    // can call haGetHistory for the energy entities and save months
    return { triggered: true };
  }

  // HA Proxy (for live view etc.)
  async haGetState(entityId) {
    return api.haGetState(entityId);
  }

  async haGetStates(entityIds) {
    return api.haGetStates();
  }

  async haGetHistory(entityIds, startTime, endTime, period = null) {
    return api.haGetHistory(entityIds, startTime, endTime, period);
  }

  async haGetFoxEssEntities() {
    return api.haGetFoxEssEntities();
  }
}

export const storage = new Storage();
window.HASolarPayBackStorage = Storage;