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

  // Get statistics (hourly/daily/monthly aggregates) - if available
  async getStatistics(entityId, startTime, endTime) {
    try {
      const params = new URLSearchParams({
        entity_id: entityId,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        period: 'month' // or 'day', 'hour'
      });
      return this.request(`/statistics?${params.toString()}`);
    } catch (e) {
      console.warn('Statistics API not available, falling back to history:', e);
      return null;
    }
  }

  // Compute monthly sums from history data for daily-reset cumulative counters
  // For each entity: group points by local calendar day, take daily max, sum daily maxes per month
  async computeMonthlySums(entityIds, startDate, endDate) {
    const history = await this.getHistoryMulti(entityIds, startDate, endDate);
    const monthly = new Map(); // entityId -> Map<monthKey, sum>

    entityIds.forEach(id => monthly.set(id, new Map()));

    history.forEach(entityHistory => {
      if (!entityHistory || !entityHistory.length) return;
      const entityId = entityHistory[0].entity_id;

      // Step 1: Group by local calendar day, track max state per day
      const dailyMax = new Map(); // dayKey (YYYY-MM-DD) -> max state

      entityHistory.forEach(point => {
        const state = parseFloat(point.state);
        if (isNaN(state)) return; // skip unavailable, unknown, non-numeric

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