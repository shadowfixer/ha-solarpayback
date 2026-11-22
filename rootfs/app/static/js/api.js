// HA SolarPayBack — API Client (replaces ha-api.js)
// Calls the add-on's backend REST API at /api/*
// No HA token needed — backend uses Supervisor token server-side

export const api = {
  // Base is same origin (ingress handles auth via HA session cookie)
  base: '/api',

  async request(path, options = {}) {
    const url = `${this.base}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const resp = await fetch(url, { ...options, headers, credentials: 'include' });

    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new Error(`API ${resp.status}: ${err}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  },

  // Settings
  async getSettings() {
    return this.request('/settings');
  },

  async putSettings(settings) {
    return this.request('/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },

  // Monthly Data
  async getMonthlyData(month = null) {
    const path = month ? `/monthly-data?month=${encodeURIComponent(month)}` : '/monthly-data';
    return this.request(path);
  },

  async saveMonthlyData(data) {
    return this.request('/monthly-data', { method: 'POST', body: JSON.stringify(data) });
  },

  async deleteMonthlyData(month) {
    return this.request(`/monthly-data?month=${encodeURIComponent(month)}`, { method: 'DELETE' });
  },

  // Tariff History
  async getTariffs() {
    return this.request('/tariffs');
  },

  async saveTariff(tariff) {
    return this.request('/tariffs', { method: 'POST', body: JSON.stringify(tariff) });
  },

  async deleteTariff(id) {
    return this.request(`/tariffs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // Grid Events
  async getGridEvents(month = null) {
    const path = month ? `/grid-events?month=${encodeURIComponent(month)}` : '/grid-events';
    return this.request(path);
  },

  async saveGridEvent(event) {
    return this.request('/grid-events', { method: 'POST', body: JSON.stringify(event) });
  },

  async deleteGridEvent(id) {
    return this.request(`/grid-events/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // HA Proxy Endpoints
  async haGetState(entityId) {
    return this.request(`/ha/state?entity_id=${encodeURIComponent(entityId)}`);
  },

  async haGetStates() {
    return this.request('/ha/states');
  },

  async haGetHistory(entityIds, startTime, endTime, period = null) {
    const ids = Array.isArray(entityIds) ? entityIds.join(',') : entityIds;
    const params = new URLSearchParams({
      entity_id: ids,
      end_time: endTime,
    });
    if (startTime) params.append('start_time', startTime);
    if (period) params.append('period', period);
    return this.request(`/ha/history?${params.toString()}`);
  },

  async haGetStats(entityIds, startTime, endTime) {
    const ids = Array.isArray(entityIds) ? entityIds.join(',') : entityIds;
    const params = new URLSearchParams({
      entity_id: ids,
      end_time: endTime,
    });
    if (startTime) params.append('start_time', startTime);
    return this.request(`/ha/stats?${params.toString()}`);
  },

  async haGetFoxEssEntities() {
    return this.request('/ha/entities/foxess');
  },

  // HA Monthly Aggregation (server-side daily-max)
  async haGetMonthly(entityIds, startTime, endTime) {
    const ids = Array.isArray(entityIds) ? entityIds.join(',') : entityIds;
    const params = new URLSearchParams({
      entity_ids: ids,
      end_time: endTime,
    });
    if (startTime) params.append('start_time', startTime);
    return this.request(`/ha/monthly?${params.toString()}`);
  }
};

window.HASolarPayBackAPI = api;
