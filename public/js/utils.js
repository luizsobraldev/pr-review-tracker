// Utilidades compartilhadas: DOM, datas, parsing de PR, ícones e avatares.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Datas (sempre "YYYY-MM-DD" no fuso local)
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toDay(new Date());
export function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return toDay(d);
}
export function diffDays(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / 86_400_000);
}
export function startOfWeek(s) {
  const d = parseDay(s);
  const dow = (d.getDay() + 6) % 7; // segunda = 0
  d.setDate(d.getDate() - dow);
  return toDay(d);
}
export const startOfMonth = (s) => s.slice(0, 8) + '01';
export function endOfMonth(s) {
  const d = parseDay(startOfMonth(s));
  d.setMonth(d.getMonth() + 1, 0);
  return toDay(d);
}
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const isWeekend = (s) => [0, 6].includes(parseDay(s).getDay());

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dtf = (opts) => new Intl.DateTimeFormat('pt-BR', opts);
const F = {
  long: dtf({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  dayMonth: dtf({ weekday: 'long', day: 'numeric', month: 'long' }),
  weekdayShort: dtf({ weekday: 'short' }),
  monthYear: dtf({ month: 'long', year: 'numeric' }),
  time: dtf({ hour: '2-digit', minute: '2-digit' }),
};
export const fmtLong = (s) => cap(F.long.format(parseDay(s)));
export const fmtDayMonth = (s) => cap(F.dayMonth.format(parseDay(s)));
export const fmtWeekday = (s) => cap(F.weekdayShort.format(parseDay(s)).replace('.', ''));
export const fmtMonthYear = (s) => cap(F.monthYear.format(parseDay(s)));
export const fmtShort = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
export const fmtFull = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
export const fmtTime = (iso) => F.time.format(new Date(iso));
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export function fmtRange(from, to) {
  if (from === to) return fmtLong(from);
  if (from === startOfMonth(from) && to === endOfMonth(from)) return fmtMonthYear(from);
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${d1} a ${d2} de ${MONTHS[m2 - 1]} de ${y2}`;
  if (y1 === y2) return `${d1} de ${MONTHS[m1 - 1]} a ${d2} de ${MONTHS[m2 - 1]} de ${y2}`;
  return `${fmtFull(from)} a ${fmtFull(to)}`;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------
export const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
export const fmtPct = (v) => (v == null ? '—' : `${v}%`);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Entrada de PR: aceita ID, branch, link do Jira/Bitbucket/GitHub/Azure ou vários IDs colados
// ---------------------------------------------------------------------------
const KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
const KEY_ONLY_RE = /^#?([a-z][a-z0-9_]+-\d+)$/i;
const URL_RE = /^https?:\/\/\S+$/i;

function fromUrl(url) {
  const key = url.match(KEY_RE);
  if (key) return { pr: key[1], link: url };
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex((p) => /^(pull-requests|pull|pullrequest|merge_requests)$/i.test(p));
    if (i > 0 && parts[i + 1]) {
      const repo = parts[i - 1] === '-' ? parts[i - 2] : parts[i - 1];
      return { pr: `${repo}#${parts[i + 1]}`, link: url };
    }
    return { pr: parts.at(-1) || u.host, link: url };
  } catch {
    return { pr: url, link: null };
  }
}

export function parsePrInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const multi = tokens.length > 1 && tokens.every((t) => KEY_ONLY_RE.test(t) || URL_RE.test(t));
  const list = multi ? tokens : [raw];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    let item;
    if (URL_RE.test(t)) item = fromUrl(t);
    else if (KEY_ONLY_RE.test(t)) item = { pr: t.replace(/^#/, '').toUpperCase(), link: null };
    else item = { pr: t.replace(/^#\s*/, ''), link: null };
    const k = item.pr.toLowerCase();
    if (item.pr && !seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agregações
// ---------------------------------------------------------------------------
export function summarize(reviews) {
  const s = { approved: 0, rejected: 0, total: 0, rate: null, byMember: new Map() };
  for (const r of reviews) {
    s[r.status]++;
    s.total++;
    const m = s.byMember.get(r.member_id) || { approved: 0, rejected: 0, total: 0 };
    m[r.status]++;
    m.total++;
    s.byMember.set(r.member_id, m);
  }
  s.rate = pct(s.approved, s.total);
  return s;
}

// ---------------------------------------------------------------------------
// Avatares (gradientes determinísticos por pessoa — só para identidade)
// ---------------------------------------------------------------------------
const GRADIENTS = [
  ['#007cf0', '#00dfd8'],
  ['#ff4d4d', '#f9cb28'],
  ['#7928ca', '#ff0080'],
  ['#0ea5a4', '#a3e635'],
  ['#f97316', '#facc15'],
  ['#475569', '#cbd5e1'],
  ['#e11d48', '#fb7185'],
  ['#059669', '#38bdf8'],
];
export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : parts[0].slice(0, 2)).toUpperCase();
}
export function avatar(member, size = 20) {
  const id = member?.id ?? 0;
  const [a, b] = GRADIENTS[id % GRADIENTS.length];
  const fs = Math.max(8, Math.round(size * 0.42));
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${fs}px;background:linear-gradient(135deg,${a},${b})" aria-hidden="true">${size >= 24 ? esc(initials(member?.name)) : ''}</span>`;
}

// ---------------------------------------------------------------------------
// Ícones (traço estilo Lucide)
// ---------------------------------------------------------------------------
const P = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  external: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  swap: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  report: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 18v-2"/><path d="M12 18v-5"/><path d="M16 18v-3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  note: '<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
};
export function icon(name, size = 16, sw = 2) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function statusIcon(status, size = 18) {
  const ok = status === 'approved';
  return `<span class="st st-${ok ? 'ok' : 'no'}" style="width:${size}px;height:${size}px" role="img" aria-label="${ok ? 'Aprovado' : 'Rejeitado'}">${icon(ok ? 'check' : 'x', Math.round(size * 0.62), 2.6)}</span>`;
}

// ---------------------------------------------------------------------------
// Copiar texto com fallback para contextos sem HTTPS
// ---------------------------------------------------------------------------
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Não foi possível copiar.');
}
