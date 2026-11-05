// Cliente da API + sincronização (SSE no servidor local, polling na Vercel).

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 && data?.auth) window.dispatchEvent(new CustomEvent('prt:unauthorized'));
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

export const api = {
  auth: () => request('GET', '/api/auth'),
  login: (code) => request('POST', '/api/login', { code }),
  logout: () => request('POST', '/api/logout'),
  meta: () => request('GET', '/api/meta'),
  version: () => request('GET', '/api/version'),
  data: (from, to) => request('GET', `/api/data?from=${from}&to=${to}`),
  lookup: (pr) => request('GET', `/api/lookup?pr=${encodeURIComponent(pr)}`),
  addReviews: (payload) => request('POST', '/api/reviews', payload),
  updateReview: (id, patch) => request('PATCH', `/api/reviews/${id}`, patch),
  deleteReview: (id) => request('DELETE', `/api/reviews/${id}`),
  updateDay: (day, patch) => request('PUT', `/api/days/${day}`, patch),
  closeDay: (day, payload) => request('POST', `/api/days/${day}/close`, payload),
  reopenDay: (day) => request('POST', `/api/days/${day}/reopen`),
  addMember: (name) => request('POST', '/api/members', { name }),
  updateMember: (id, patch) => request('PATCH', `/api/members/${id}`, patch),
  updateSettings: (patch) => request('PUT', '/api/settings', patch),
  csvUrl: (from, to) => `/api/export.csv${from ? `?from=${from}&to=${to}` : ''}`,
};

// Status: 'connecting' | 'live' | 'paused' | 'offline'
export function connectLive({ mode, onChange, onStatus }) {
  if (mode === 'sse') return connectSse({ onChange, onStatus });
  return connectPolling({ onChange, onStatus });
}

function connectSse({ onChange, onStatus }) {
  let es;
  let retry;
  const open = () => {
    onStatus('connecting');
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => onStatus('live'));
    es.addEventListener('change', (e) => {
      try { onChange(JSON.parse(e.data)); } catch { onChange({}); }
    });
    es.onerror = () => {
      onStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(open, 4000);
      }
    };
  };
  open();
}

// Polling leve: só com a aba visível e com alguém usando nos últimos 15 min,
// para não manter o banco acordado à toa.
function connectPolling({ onChange, onStatus }) {
  const INTERVAL = 6000;
  const IDLE_AFTER = 15 * 60 * 1000;
  let last = null;
  let timer = null;
  let lastActivity = Date.now();
  let paused = false;

  const schedule = (ms = INTERVAL) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  async function tick() {
    const idle = Date.now() - lastActivity > IDLE_AFTER;
    if (document.visibilityState !== 'visible' || idle) {
      paused = true;
      onStatus('paused');
      return;
    }
    paused = false;
    try {
      const { rev } = await api.version();
      onStatus('live');
      if (last !== null && rev !== last) onChange({ scope: 'poll' });
      last = rev;
    } catch {
      onStatus('offline');
    }
    schedule();
  }
  const wake = () => {
    lastActivity = Date.now();
    if (paused) tick();
  };
  ['pointerdown', 'keydown', 'focus'].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  onStatus('connecting');
  tick();
}
