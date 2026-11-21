// HA SunBack — Home Assistant API Client

import { Utils } from './utils.js';

export class HAAPI {
  constructor() {
    this.baseUrl = '';
    this.token = '';
    this.ws = null;
    this.wsCallbacks = new Map();
    this.wsMsgId = 1;
    this.connected = false;
    this.entityCache = new Map();
  }

  // Initialize from stored config
  async init() {
    const config = await this.getStoredConfig();
    if (config) {
      this.baseUrl = config.url.replace(/\/$/, '');
      this.token = config.token;
      return true;
    }
    return false;
  }

  async getStoredConfig() {
    try {
      const stored = localStorage.getItem('ha-sunback-config');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  async saveConfig(url, token) {
    this.baseUrl = url.replace(/\/$/, '');
    this.token = token;
    localStorage.setItem('ha-sunback-config', JSON.stringify({ url, token }));
  }

  // Clear config
  clearConfig() {
    this.baseUrl = '';
    this.token = '';
    localStorage.removeItem('ha-sunback-config');
    this.disconnectWS();
  }

  // Check if configured
  isConfigured() {
    return !!(this.baseUrl && this.token);
  }

  // Make authenticated request
  async request(path, options = {}) {
    if (!this.isConfigured()) throw new Error('HA not configured');

    const url = `${this.baseUrl}/api${path}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const resp = await fetch(url, { ...options, headers });
    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new Error(`HA API ${resp.status}: ${err}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }

  // Test connection
  async testConnection() {
    return this.request('/');
  }

  // Call shell_command/ha_sunback_store service to persist data in HA
  // Payload: { gridEvents: [...], tariffHistory: [...] }
  // Fire-and-forget: never throws, logs errors only
  async persistToHA(gridEvents, tariffHistory) {
    if (!this.isConfigured()) return false;
    try {
      await this.request('/services/shell_command/ha_sunback_store', {
        method: 'POST',
        body: JSON.stringify({ gridEvents, tariffHistory })
      });
      return true;
    } catch (e) {
      console.warn('HA persist failed (non-blocking):', e.message);
      return false;
    }
  }

  // Fetch persisted data from HA command_line sensor exposing /config/ha-sunback-data.json
  // The sensor's json_attributes carry gridEvents + tariffHistory arrays
  async fetchPersistedData() {
    if (!this.isConfigured()) return null;
    try {
      const state = await this.getState('sensor.ha_sunback_data');
      if (!state) return null;
      const attrs = state.attributes || {};
      const gridEvents = attrs.gridEvents || [];
      const tariffHistory = attrs.tariffHistory || [];
      if (!gridEvents.length && !tariffHistory.length) return null;
      return { gridEvents, tariffHistory };
    } catch (e) {
      console.warn('HA fetch persisted data failed:', e.message);
    }
    return null;
  }

  // Get entity state
  async getState(entityId) {
    return this.request(`/states/${encodeURIComponent(entityId)}`);
  }

  // Get multiple states
  async getStates(entityIds) {
    const states = await this.request('/states');
    const map = new Map();
    entityIds.forEach(id => {
      const found = states.find(s => s.entity_id === id);
      if (found) map.set(id, found);
    });
    return map;
  }

  // Get history for period (for monthly aggregation)
  async getHistory(entityId, startTime, endTime) {
    const params = new URLSearchParams({
      filter_entity_id: entityId,
      end_time: endTime.toISOString()
    });
    if (startTime) params.append('start_time', startTime.toISOString());
    return this.request(`/history/period?${params.toString()}`);
  }

  // Get history for multiple entities
  async getHistoryMulti(entityIds, startTime, endTime) {
    const params = new URLSearchParams({
      filter_entity_id: entityIds.join(','),
      end_time: endTime.toISOString()
    });
    if (startTime) params.append('start_time', startTime.toISOString());
    return this.request(`/history/period?${params.toString()}`);
  }

  // Get daily long-term statistics for multiple entities
  // Uses HA's /history/period endpoint with period=day which returns aggregated 'sum' per day
  // Works beyond the ~10-day raw history window because it reads from the statistics DB
  async getDailyStatistics(entityIds, startTime, endTime) {
    try {
      const params = new URLSearchParams({
        filter_entity_id: entityIds.join(','),
        end_time: endTime.toISOString(),
        period: 'day'
      });
      if (startTime) params.append('start_time', startTime.toISOString());

      const resp = await this.request(`/history/period?${params.toString()}`);

      // Response format with period=day:
      // { "entity_id": [ { "start": "2026-11-13T00:00:00+00:00", "end": "...", "sum": 12.5, "mean": ..., "min": ..., "max": ... }, ... ], ... }
      // Returns an object keyed by entity_id, each value is an array of daily stat objects with 'sum'
      if (!resp || typeof resp !== 'object') {
        console.warn('Unexpected statistics response format');
        return null;
      }
      return resp;
    } catch (e) {
      console.warn('Daily statistics API not available, falling back to history:', e);
      return null;
    }
  }

  // Compute monthly sums using long-term statistics (preferred) with fallback to raw history
  // For daily-reset cumulative counters: each day's 'sum' from statistics = that day's total energy
  // Monthly total = sum of daily sums across days in that month
  async computeMonthlySums(entityIds, startDate, endDate) {
    // First try the long-term statistics path (works beyond ~10 days)
    const stats = await this.getDailyStatistics(entityIds, startDate, endDate);

    if (stats && Object.keys(stats).length > 0) {
      return this._computeMonthlyFromStatistics(stats, entityIds);
    }

    // Fallback: raw history with daily-max aggregation (existing logic)
    console.log('Falling back to raw history for monthly sums');
    return this._computeMonthlyFromHistory(entityIds, startDate, endDate);
  }

  // Internal: compute monthly sums from HA statistics API response (period=day)
  // HA returns RUNNING CUMULATIVE sums per day (each day's 'sum' = total from start of tracking).
  // We must compute deltas: day_energy[i] = stats[i].sum - stats[i-1].sum (first day = its sum).
  // Month total = sum of daily deltas in that month.
  _computeMonthlyFromStatistics(stats, entityIds) {
    const monthly = new Map();
    entityIds.forEach(id => monthly.set(id, new Map()));

    entityIds.forEach(entityId => {
      const entityStats = stats[entityId];
      if (!entityStats || !entityStats.length) return;

      const monthMap = monthly.get(entityId);

      // Sort by start time to ensure chronological order
      const sortedStats = [...entityStats].sort((a, b) =>
        new Date(a.start) - new Date(b.start)
      );

      let prevSum = null;

      sortedStats.forEach(dayStat => {
        const sum = parseFloat(dayStat.sum);
        if (isNaN(sum)) return;

        const startDate = new Date(dayStat.start);
        const monthKey = startDate.getFullYear() + '-' +
                         String(startDate.getMonth() + 1).padStart(2, '0');

        // Compute daily energy as delta from previous day's cumulative sum
        let dayEnergy;
        if (prevSum === null) {
          // First row: cumulative from zero
          dayEnergy = sum;
        } else {
          dayEnergy = sum - prevSum;
          // Guard against negative deltas (counter resets, data issues)
          if (dayEnergy < 0) dayEnergy = 0;
        }
        prevSum = sum;

        monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + dayEnergy);
      });
    });

    // Convert to regular object
    const result = {};
    monthly.forEach((map, entityId) => {
      result[entityId] = Object.fromEntries(map);
    });
    return result;
  }

  // Internal: compute monthly sums from raw history (fallback - original logic)
  // Groups raw points by local calendar day, takes daily max, sums daily maxes per month
  async _computeMonthlyFromHistory(entityIds, startDate, endDate) {
    const history = await this.getHistoryMulti(entityIds, startDate, endDate);
    const monthly = new Map();

    entityIds.forEach(id => monthly.set(id, new Map()));

    history.forEach(entityHistory => {
      if (!entityHistory || !entityHistory.length) return;
      const entityId = entityHistory[0].entity_id;

      // Step 1: Group by local calendar day, track max state per day
      const dailyMax = new Map();

      entityHistory.forEach(point => {
        const state = parseFloat(point.state);
        if (isNaN(state)) return;

        const date = new Date(point.last_changed);
        const dayKey = date.getFullYear() + '-' +
                       String(date.getMonth() + 1).padStart(2, '0') + '-' +
                       String(date.getDate()).padStart(2, '0');

        const currentMax = dailyMax.get(dayKey) || 0;
        if (state > currentMax) {
          dailyMax.set(dayKey, state);
        }
      });

      // Step 2: Sum daily maxes by month
      const monthMap = monthly.get(entityId);
      dailyMax.forEach((maxState, dayKey) => {
        const monthKey = dayKey.substring(0, 7); // "YYYY-MM"
        monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + maxState);
      });
    });

    // Convert to regular object
    const result = {};
    monthly.forEach((map, entityId) => {
      result[entityId] = Object.fromEntries(map);
    });
    return result;
  }

  // WebSocket connection for real-time updates
  connectWS() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/websocket';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('HA WebSocket connected');
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        this.handleWSMessage(msg);
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log('HA WebSocket disconnected');
        // Auto-reconnect after 5s
        setTimeout(() => this.connectWS(), 5000);
      };

      this.ws.onerror = (err) => {
        console.error('HA WebSocket error:', err);
        reject(err);
      };

      // Wait for auth_required
      const authHandler = (msg) => {
        if (msg.type === 'auth_required') {
          this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (msg.type === 'auth_ok') {
          this.connected = true;
          this.ws.removeEventListener('message', authHandler);
          this.subscribeToEntities();
          resolve();
        } else if (msg.type === 'auth_invalid') {
          this.ws.removeEventListener('message', authHandler);
          reject(new Error('HA auth invalid'));
        }
      };
      this.ws.addEventListener('message', authHandler);
    });
  }

  handleWSMessage(msg) {
    if (msg.type === 'event' && msg.event.event_type === 'state_changed') {
      const entityId = msg.event.data.entity_id;
      const newState = msg.event.data.new_state;
      if (newState) {
        this.entityCache.set(entityId, newState);
        // Notify callbacks
        const callbacks = this.wsCallbacks.get(entityId);
        if (callbacks) {
          callbacks.forEach(cb => cb(newState));
        }
      }
    }
  }

  subscribeToEntities(entityIds = null) {
    if (!this.connected) return;

    const ids = entityIds || [
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

    const msg = {
      id: this.wsMsgId++,
      type: 'subscribe_events',
      event_type: 'state_changed'
    };
    this.ws.send(JSON.stringify(msg));
  }

  // Subscribe to entity updates
  onEntityUpdate(entityId, callback) {
    if (!this.wsCallbacks.has(entityId)) {
      this.wsCallbacks.set(entityId, new Set());
    }
    this.wsCallbacks.get(entityId).add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.wsCallbacks.get(entityId);
      if (callbacks) callbacks.delete(callback);
    };
  }

  // Get cached entity state
  getCachedState(entityId) {
    return this.entityCache.get(entityId);
  }

  disconnectWS() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  // Auto-detect Fox ESS entities
  async detectFoxEntities() {
    const states = await this.request('/states');
    const entities = {};

    states.forEach(s => {
      const id = s.entity_id;
      if (id.startsWith('sensor.garage_foxess_') || id.startsWith('sensor.predbat_fox_')) {
        entities[id] = s.attributes.friendly_name || id;
      }
    });

    return entities;
  }

  // Auto-detect Octopus entities
  async detectOctopusEntities() {
    const states = await this.request('/states');
    const entities = {};

    states.forEach(s => {
      const id = s.entity_id;
      if (id.includes('octopus') || id.includes('electricity')) {
        entities[id] = s.attributes.friendly_name || id;
      }
    });

    return entities;
  }
}

// Singleton instance
export const haApi = new HAAPI();

// Global access
window.HASunBackAPI = HAAPI;