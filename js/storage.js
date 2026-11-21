// HA SunBack — IndexedDB Storage Wrapper

import { haApi } from './ha-api.js';

const DB_NAME = 'ha-sunback-db';
const DB_VERSION = 1;

const STORES = {
  SETTINGS: 'settings',
  MONTHLY_DATA: 'monthlyData',
  TARIFF_HISTORY: 'tariffHistory',
  GRID_EVENTS: 'gridEvents',
  HA_CACHE: 'haCache'
};

// Key to track if we've attempted HA restore on this device/browser
const HA_RESTORE_ATTEMPTED_KEY = 'ha-sunback-ha-restore-attempted';

export class Storage {
  constructor() {
    this.db = null;
    this.ready = this.init();
    this._haSyncPending = false;
  }

  // ID generation safe in insecure (http) contexts, where crypto.randomUUID may be undefined
  _uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for plain-http contexts (e.g. http://homeassistant.local) - no secure context
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.MONTHLY_DATA)) {
          const store = db.createObjectStore(STORES.MONTHLY_DATA, { keyPath: 'month' });
          store.createIndex('year', 'year', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.TARIFF_HISTORY)) {
          db.createObjectStore(STORES.TARIFF_HISTORY, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.GRID_EVENTS)) {
          db.createObjectStore(STORES.GRID_EVENTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.HA_CACHE)) {
          db.createObjectStore(STORES.HA_CACHE, { keyPath: 'key' });
        }
      };
    });
  }

  async ensureReady() {
    if (!this.db) await this.ready;
    return this.db;
  }

  // Generic CRUD
  async get(storeName, key) {
    const db = await this.ensureReady();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAll(storeName) {
    const db = await this.ensureReady();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put(storeName, value) {
    const db = await this.ensureReady();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName, key) {
    const db = await this.ensureReady();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName) {
    const db = await this.ensureReady();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Settings
  async getSetting(key, defaultValue = null) {
    const item = await this.get(STORES.SETTINGS, key);
    return item ? item.value : defaultValue;
  }

  async setSetting(key, value) {
    await this.put(STORES.SETTINGS, { key, value, updatedAt: Date.now() });
  }

  async getAllSettings() {
    const items = await this.getAll(STORES.SETTINGS);
    const obj = {};
    items.forEach(item => obj[item.key] = item.value);
    return obj;
  }

  // Monthly Data
  async saveMonth(monthKey, data) {
    const year = parseInt(monthKey.split('-')[0], 10);
    await this.put(STORES.MONTHLY_DATA, { month: monthKey, year, ...data, updatedAt: Date.now() });
  }

  async getMonth(monthKey) {
    return this.get(STORES.MONTHLY_DATA, monthKey);
  }

  async getAllMonths() {
    return this.getAll(STORES.MONTHLY_DATA);
  }

  async getMonthsInRange(startYear, endYear) {
    const all = await this.getAll(STORES.MONTHLY_DATA);
    return all.filter(m => m.year >= startYear && m.year <= endYear);
  }

  async deleteMonth(monthKey) {
    return this.delete(STORES.MONTHLY_DATA, monthKey);
  }

  // HA Cache
  async setCache(key, data, ttlMs = 300000) { // 5 min default
    await this.put(STORES.HA_CACHE, { key, data, expiresAt: Date.now() + ttlMs });
  }

  async getCache(key) {
    const item = await this.get(STORES.HA_CACHE, key);
    if (!item) return null;
    if (item.expiresAt < Date.now()) {
      await this.delete(STORES.HA_CACHE, key);
      return null;
    }
    return item.data;
  }

  // Clear all data (danger zone)
  async clearAll() {
    await Promise.all([
      this.clear(STORES.SETTINGS),
      this.clear(STORES.MONTHLY_DATA),
      this.clear(STORES.TARIFF_HISTORY),
      this.clear(STORES.GRID_EVENTS),
      this.clear(STORES.HA_CACHE)
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
      for (const [key, value] of Object.entries(data.settings)) {
        await this.setSetting(key, value);
      }
    }
    if (data.months) {
      for (const month of data.months) {
        await this.put(STORES.MONTHLY_DATA, month);
      }
    }
    if (data.tariffs) {
      for (const tariff of data.tariffs) {
        await this.put(STORES.TARIFF_HISTORY, tariff);
      }
    }
    if (data.gridEvents) {
      for (const event of data.gridEvents) {
        await this.put(STORES.GRID_EVENTS, event);
      }
    }
  }

  // ==== HA Persistence ====

  // Check if IndexedDB has any grid events or tariff history
  async _hasLocalData() {
    const [tariffs, events] = await Promise.all([
      this.getAll(STORES.TARIFF_HISTORY),
      this.getAll(STORES.GRID_EVENTS)
    ]);
    return tariffs.length > 0 || events.length > 0;
  }

  // Attempt to restore from HA on first load if IndexedDB is empty
  // Only runs once per browser (tracked in localStorage)
  async maybeRestoreFromHA() {
    // Skip if already attempted in this browser
    if (localStorage.getItem(HA_RESTORE_ATTEMPTED_KEY) === 'true') {
      return false;
    }
    localStorage.setItem(HA_RESTORE_ATTEMPTED_KEY, 'true');

    // Skip if HA not configured
    if (!haApi.isConfigured()) {
      return false;
    }

    // Skip if we already have local data
    if (await this._hasLocalData()) {
      return false;
    }

    try {
      const data = await haApi.fetchPersistedData();
      if (data && (data.gridEvents?.length || data.tariffHistory?.length)) {
        // Restore into IndexedDB
        if (data.gridEvents?.length) {
          for (const event of data.gridEvents) {
            await this.put(STORES.GRID_EVENTS, event);
          }
        }
        if (data.tariffHistory?.length) {
          for (const tariff of data.tariffHistory) {
            await this.put(STORES.TARIFF_HISTORY, tariff);
          }
        }
        console.log('Restored data from HA:', {
          gridEvents: data.gridEvents?.length || 0,
          tariffHistory: data.tariffHistory?.length || 0
        });
        return true;
      }
    } catch (e) {
      console.warn('HA restore failed (non-blocking):', e.message);
    }
    return false;
  }

  // Sync current grid events + tariff history to HA (fire-and-forget)
  // Never blocks local save; logs errors only
  async _syncToHA() {
    if (this._haSyncPending) return; // Debounce concurrent calls
    this._haSyncPending = true;

    try {
      const [gridEvents, tariffHistory] = await Promise.all([
        this.getAll(STORES.GRID_EVENTS),
        this.getAll(STORES.TARIFF_HISTORY)
      ]);

      // Only sync if HA is configured
      if (haApi.isConfigured()) {
        await haApi.persistToHA(gridEvents, tariffHistory);
      }
    } catch (e) {
      console.warn('HA sync failed (non-blocking):', e.message);
    } finally {
      this._haSyncPending = false;
    }
  }

  // Tariff History
  async saveTariff(tariff) {
    const id = tariff.id || this._uuid();
    await this.put(STORES.TARIFF_HISTORY, { ...tariff, id, createdAt: Date.now() });
    // Fire-and-forget HA sync
    this._syncToHA();
    return id;
  }

  async getAllTariffs() {
    const tariffs = await this.getAll(STORES.TARIFF_HISTORY);
    return tariffs.sort((a, b) => a.month.localeCompare(b.month));
  }

  async deleteTariff(id) {
    await this.delete(STORES.TARIFF_HISTORY, id);
    // Fire-and-forget HA sync
    this._syncToHA();
  }

  // Grid Events
  async saveGridEvent(event) {
    const id = event.id || this._uuid();
    await this.put(STORES.GRID_EVENTS, { ...event, id, createdAt: Date.now() });
    // Fire-and-forget HA sync
    this._syncToHA();
    return id;
  }

  async getAllGridEvents() {
    const events = await this.getAll(STORES.GRID_EVENTS);
    return events.sort((a, b) => a.date.localeCompare(b.date));
  }

  async getGridEventsForMonth(monthKey) {
    const events = await this.getAll(STORES.GRID_EVENTS);
    return events.filter(e => e.date.startsWith(monthKey));
  }

  async deleteGridEvent(id) {
    await this.delete(STORES.GRID_EVENTS, id);
    // Fire-and-forget HA sync
    this._syncToHA();
  }
}

export const storage = new Storage();
window.HASunBackStorage = Storage;