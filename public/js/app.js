import { api, connectLive } from './api.js';
import {
  $, $$, esc, debounce, today, addDays, diffDays, startOfWeek, startOfMonth, endOfMonth,
  fmtDayMonth, fmtShort, fmtFull, fmtTime, fmtWeekday, fmtRange,
  pct, fmtPct, plural, parsePrInput, summarize, avatar, icon, statusIcon, copyText,
} from './utils.js';
import { buildReportModel, renderReport, reportText, bucketize, columnChart, chartLegend } from './report.js';
import { canCopyImage, copyImage, downloadImage } from './export-image.js';

const LS = { me: 'prt.me', meName: 'prt.meName', theme: 'prt.theme', repTheme: 'prt.reportTheme' };
const ME_COOKIE = 'prt_me';

// Quem é você: fica gravado no navegador (localStorage + cookie de 1 ano) para só perguntar na primeira vez.
function saveIdentity(member) {
  if (member) {
    localStorage.setItem(LS.me, String(member.id));
    localStorage.setItem(LS.meName, member.name);
    document.cookie = `${ME_COOKIE}=${encodeURIComponent(`${member.id}|${member.name}`)}; Max-Age=${60 * 60 * 24 * 400}; Path=/; SameSite=Lax`;
  } else {
    localStorage.removeItem(LS.me);
    localStorage.removeItem(LS.meName);
    document.cookie = `${ME_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}
function loadIdentity() {
  const id = Number(localStorage.getItem(LS.me)) || null;
  const name = localStorage.getItem(LS.meName);
  if (id || name) return { id, name };
  const m = document.cookie.split(/;\s*/).find((c) => c.startsWith(`${ME_COOKIE}=`));
  if (!m) return null;
  const [cid, ...rest] = decodeURIComponent(m.slice(ME_COOKIE.length + 1)).split('|');
  return { id: Number(cid) || null, name: rest.join('|') || null };
}
const VIEWS = ['hoje', 'historico', 'relatorio', 'equipe'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const state = {
  meta: { members: [], settings: {}, urls: [], db_file: '' },
  me: null,
  view: 'hoje',
  day: today(),
  dayPinned: false,
  dayData: null,
  recFilter: 'all',
  newIds: new Set(),
  hist: { preset: '30d', member: '', q: '', open: new Set(), data: null },
  rep: {
    preset: 'today', from: today(), to: today(), member: '',
    showList: true, showChart: true, listTouched: false,
    theme: localStorage.getItem(LS.repTheme) || null,
    data: null, model: null,
  },
  live: 'connecting',
};

const memberById = (id) => state.meta.members.find((m) => m.id === id);
const activeMembers = () => state.meta.members.filter((m) => m.active);

// ===========================================================================
// Tema
// ===========================================================================
const themePref = () => localStorage.getItem(LS.theme) || 'system';
function resolvedTheme() {
  const p = themePref();
  if (p !== 'system') return p;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ===========================================================================
// Toasts, menus, diálogos, tooltip
// ===========================================================================
function toast(message, { iconHtml = '', action = null, error = false, duration = 5000 } = {}) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<span class="msg">${error ? `<span class="ti-err">${icon('x', 16, 2.4)}</span>` : iconHtml}<span>${esc(message)}</span></span>`
    + (action ? `<button class="btn secondary" type="button">${icon('undo', 14)}${esc(action.label)}</button>` : '');
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.querySelector('button').addEventListener('click', async () => {
      remove();
      try { await action.fn(); } catch (e) { toast(e.message, { error: true }); }
    });
  }
  let timer = setTimeout(remove, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(remove, 2000); });
  box.appendChild(el);
}

let menuState = null;
function closeMenu() {
  if (!menuState) return;
  menuState.el.remove();
  menuState.anchor.setAttribute('aria-expanded', 'false');
  menuState = null;
}
function openMenu(anchor, html, onPick) {
  if (menuState?.anchor === anchor) return closeMenu();
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = html;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menuState = { el, anchor };
  el.addEventListener('click', (e) => {
    const item = e.target.closest('[data-mi]');
    if (!item || item.disabled) return;
    const keep = item.hasAttribute('data-keep');
    if (!keep) closeMenu();
    onPick(item.dataset.mi, item);
  });
  el.addEventListener('keydown', (e) => {
    const items = $$('.menu-item:not(:disabled), .theme-seg button', el);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); }
  });
  el.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => {
  if (menuState && !menuState.el.contains(e.target) && !menuState.anchor.contains(e.target)) closeMenu();
});
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, { passive: true });

const menuItem = (id, label, ic, { danger = false, disabled = false } = {}) =>
  `<button class="menu-item${danger ? ' danger' : ''}" role="menuitem" data-mi="${id}" ${disabled ? 'disabled' : ''}>${icon(ic, 16)}<span>${esc(label)}</span></button>`;

function dialog({ html, mount, required = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    dlg.innerHTML = html;
    dlg.oncancel = (e) => { if (required) e.preventDefault(); };
    dlg.onclose = () => finish(null);
    dlg.onclick = (e) => { if (e.target === dlg && !required) finish(null); };
    dlg.showModal();
    $$('[data-dlg-cancel]', dlg).forEach((b) => b.addEventListener('click', () => finish(null)));
    mount?.(dlg, finish);
  });
}

const tip = () => $('#tooltip');
function showChartTip(col) {
  const [title, a, r] = col.dataset.chartTip.split('|');
  const t = tip();
  t.innerHTML = `<strong>${esc(title)}</strong>
    <div class="tt-row"><i class="dot ok"></i>Aprovados<b>${a}</b></div>
    <div class="tt-row"><i class="dot no"></i>Rejeitados<b>${r}</b></div>`;
  t.hidden = false;
  const rc = col.getBoundingClientRect();
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  const left = Math.max(8, Math.min(rc.left + rc.width / 2 - tw / 2, innerWidth - tw - 8));
  const stack = col.querySelector('.rc-stack');
  const segTop = stack?.firstElementChild ? stack.firstElementChild.getBoundingClientRect().top : rc.bottom;
  let top = segTop - th - 10;
  if (top < 8) top = rc.bottom + 10;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}
document.addEventListener('pointerover', (e) => {
  const col = e.target.closest?.('[data-chart-tip]');
  if (col) showChartTip(col);
  else if (!tip().hidden) tip().hidden = true;
});

// ===========================================================================
// Usuário atual
// ===========================================================================
function setMe(member) {
  state.me = member || null;
  saveIdentity(state.me);
  renderUserBtn();
  if (state.view === 'hoje') renderToday();
  if (state.view === 'equipe') renderTeam();
}

function renderUserBtn() {
  const btn = $('#user-btn');
  btn.innerHTML = state.me
    ? `${avatar(state.me, 28)}<span class="user-name">${esc(state.me.name)}</span>`
    : `<span class="btn secondary sm" style="pointer-events:none">Entrar</span>`;
}

// Primeiro acesso / troca de usuário. O campo de nome vem primeiro; os nomes já cadastrados
// ficam discretos embaixo e sempre pedem confirmação, para ninguém entrar no nome de outra pessoa sem querer.
async function pickUser({ required = !state.me } = {}) {
  const members = activeMembers().filter((m) => m.id !== state.me?.id);
  const first = state.meta.members.length === 0;
  const html = `<form class="dlg-body" id="pick-form" autocomplete="off">
      <h2 class="dlg-title">${first ? 'Bem-vindo ao PR Review' : 'Qual é o seu nome?'}</h2>
      <p class="dlg-desc">${first
        ? 'Configure a equipe e digite seu nome. Os outros analistas entram pelo mesmo link e digitam o deles.'
        : 'Seus registros vão sair nesse nome. Ele fica gravado neste navegador, então só perguntamos uma vez.'}</p>
      <div class="dlg-fields">
        ${first ? `<div><label class="field-label" for="pick-team">Nome da equipe</label>
          <input class="input" id="pick-team" maxlength="60" value="${esc(state.meta.settings.team_name || 'Equipe QA')}"></div>` : ''}
        <div><label class="field-label" for="pick-name">Seu nome</label>
          <div class="inline-form" style="margin-top:0">
            <input class="input" id="pick-name" maxlength="40" placeholder="Ex.: Ana Paula">
            <button class="btn primary" type="submit">Entrar</button>
          </div></div>
      </div>
      <p class="dlg-error" id="pick-error" hidden></p>
      <div class="pick-confirm" id="pick-confirm" hidden></div>
      ${members.length ? `<div class="pick-existing">
        <p>Já usa o PR Review em outro computador? Toque no seu nome:</p>
        <div class="pick-chips">${members.map((m) => `<button type="button" class="pick-chip" data-pick="${m.id}">${avatar(m, 18)}<span>${esc(m.name)}</span></button>`).join('')}</div>
      </div>` : ''}
    </form>
    ${required ? '' : '<div class="dlg-foot"><button class="btn secondary sm" type="button" data-dlg-cancel>Cancelar</button></div>'}`;

  await dialog({
    html,
    required,
    mount: (dlg, finish) => {
      const err = $('#pick-error', dlg);
      const box = $('#pick-confirm', dlg);
      const input = $('#pick-name', dlg);
      const fail = (m) => { box.hidden = true; err.textContent = m; err.hidden = false; };

      const confirmAs = (m, typed) => {
        err.hidden = true;
        box.innerHTML = `${avatar(m, 28)}
          <div class="pick-confirm-text"><strong>${typed ? `Já existe “${esc(m.name)}” na equipe. É você?` : `Você é ${esc(m.name)}?`}</strong>
            <span>Tudo o que você registrar vai sair no nome de ${esc(m.name)}.</span></div>
          <div class="pick-confirm-actions">
            <button type="button" class="btn secondary sm" data-no>${typed ? 'Não, outro nome' : 'Não sou'}</button>
            <button type="button" class="btn primary sm" data-yes>Sou eu</button>
          </div>`;
        box.hidden = false;
        $('[data-yes]', box).addEventListener('click', () => { setMe(m); finish(true); });
        $('[data-no]', box).addEventListener('click', () => { box.hidden = true; input.focus(); input.select(); });
        $('[data-no]', box).focus();
      };

      $$('[data-pick]', dlg).forEach((b) => b.addEventListener('click', () => confirmAs(memberById(Number(b.dataset.pick)), false)));

      $('#pick-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) { input.focus(); return fail('Digite seu nome.'); }
        const existing = activeMembers().find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (existing) return confirmAs(existing, true);
        try {
          if (first) {
            const team = $('#pick-team', dlg).value.trim();
            if (team) await api.updateSettings({ team_name: team });
          }
          const { member } = await api.addMember(name);
          await loadMeta();
          setMe(memberById(member.id));
          finish(true);
        } catch (ex) { fail(ex.message); }
      });
      input.focus();
    },
  });
}

function openUserMenu(anchor) {
  const pref = themePref();
  const m = state.me;
  const html = `
    ${m ? `<div class="menu-head">${avatar(m, 32)}<div><strong>${esc(m.name)}</strong><span>${esc(state.meta.settings.team_name || '')}</span></div></div><div class="menu-sep"></div>` : ''}
    ${menuItem('switch', m ? 'Trocar de usuário' : 'Entrar', 'users')}
    ${menuItem('team', 'Equipe e configurações', 'pencil')}
    ${state.meta.auth_required ? menuItem('logout', 'Sair deste navegador', 'logout') : ''}
    <div class="menu-sep"></div>
    <div class="menu-row"><span>Tema</span>
      <span class="theme-seg" role="group" aria-label="Tema">
        <button type="button" data-mi="theme:system" data-keep aria-pressed="${pref === 'system'}" title="Sistema" aria-label="Tema do sistema">${icon('monitor', 14)}</button>
        <button type="button" data-mi="theme:light" data-keep aria-pressed="${pref === 'light'}" title="Claro" aria-label="Tema claro">${icon('sun', 14)}</button>
        <button type="button" data-mi="theme:dark" data-keep aria-pressed="${pref === 'dark'}" title="Escuro" aria-label="Tema escuro">${icon('moon', 14)}</button>
      </span>
    </div>`;
  openMenu(anchor, html, (id, el) => {
    if (id === 'switch') pickUser({ required: !state.me });
    if (id === 'team') location.hash = '#equipe';
    if (id === 'logout') api.logout().finally(() => location.reload());
    if (id.startsWith('theme:')) {
      localStorage.setItem(LS.theme, id.slice(6));
      applyTheme();
      $$('.theme-seg button', el.closest('.menu')).forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      if (state.view === 'relatorio' && !localStorage.getItem(LS.repTheme)) renderReportView();
    }
  });
}

// ===========================================================================
// Dados / meta
// ===========================================================================
async function loadMeta() {
  state.meta = await api.meta();
  $('#team-name').textContent = state.meta.settings.team_name || 'Equipe QA';
  document.title = `PR Review · ${state.meta.settings.team_name || 'Equipe QA'}`;
  if (state.me) {
    const fresh = memberById(state.me.id);
    state.me = fresh && fresh.active ? fresh : null;
    if (state.me) saveIdentity(state.me);
  }
  renderUserBtn();
}

let everLive = false;
function setLive(status) {
  const was = state.live;
  state.live = status;
  const el = $('#live');
  el.dataset.state = status;
  el.querySelector('span').textContent = { live: 'Ao vivo', connecting: 'Conectando', paused: 'Pausado', offline: 'Offline' }[status];
  el.title = status === 'paused' ? 'Sincronização pausada (aba inativa). Volta sozinha ao usar.' : 'Sincronização em tempo real';
  if (status === 'live' && was !== 'live') {
    if (everLive) refreshActive({ scope: 'reconnect' });
    everLive = true;
  }
}

const refreshActive = debounce(async (evt = {}) => {
  try {
    if (['members', 'settings', 'reconnect'].includes(evt.scope)) await loadMeta();
    if (state.view !== 'historico') state.hist.data = null;
    await loadView({ silent: true });
  } catch { /* próxima mudança tenta de novo */ }
}, 180);

// ===========================================================================
// Roteamento
// ===========================================================================
function parseHash() {
  const [view, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { view: VIEWS.includes(view) ? view : 'hoje', arg: arg ? decodeURIComponent(arg) : '' };
}

async function route() {
  const { view, arg } = parseHash();
  state.view = view;
  if (view === 'hoje') {
    const t = today();
    state.day = DAY_RE.test(arg) && arg <= t ? arg : t;
    state.dayPinned = state.day !== t;
  }
  if (view === 'relatorio' && arg) {
    const [f, t2] = arg.split('_');
    if (DAY_RE.test(f) && (!t2 || DAY_RE.test(t2))) setReportRange('custom', f, t2 || f, { fromLink: true });
  }
  showView();
  await loadView();
}

function showView() {
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== state.view; });
  $$('.tab').forEach((t) => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  moveIndicator();
  closeMenu();
}

function moveIndicator() {
  const active = $(`.tab[data-view="${state.view}"]`);
  const ind = $('#tab-indicator');
  if (!active) return;
  ind.style.width = `${active.offsetWidth - 16}px`;
  ind.style.transform = `translateX(${active.offsetLeft + 8}px)`;
}
window.addEventListener('resize', moveIndicator);

async function loadView(opts = {}) {
  try {
    if (state.view === 'hoje') await loadDay(opts);
    else if (state.view === 'historico') await loadHistory(opts);
    else if (state.view === 'relatorio') await loadReport(opts);
    else renderTeam();
  } catch (e) {
    toast(e.message || 'Falha ao carregar dados.', { error: true });
  }
}

// ===========================================================================
// HOJE
// ===========================================================================
const dayRecord = () => state.dayData?.days.find((d) => d.day === state.day) || null;
const isClosed = () => Boolean(dayRecord()?.closed_at);
const isDayClosed = (day) => Boolean((state.dayData?.days || []).concat(state.hist.data?.days || [])
  .find((d) => d.day === day)?.closed_at);

async function loadDay() {
  const day = state.day;
  if (state.dayData?.day !== day) {
    state.dayData = null;
    renderToday();
  }
  const data = await api.data(day, day);
  if (day !== state.day) return;
  state.dayData = { day, ...data };
  renderToday();
}

function setDay(d) {
  const t = today();
  const next = d > t ? t : d;
  history.replaceState(null, '', next === t ? '#hoje' : `#hoje/${next}`);
  route();
}

function renderToday() {
  const d = state.day;
  const t = today();
  const loaded = state.dayData?.day === d;
  const rec = loaded ? dayRecord() : null;
  const closed = Boolean(rec?.closed_at);
  const reviews = loaded ? state.dayData.reviews : [];
  const s = summarize(reviews);

  // Cabeçalho
  $('#day-title').textContent = fmtDayMonth(d) + (d.slice(0, 4) !== t.slice(0, 4) ? ` de ${d.slice(0, 4)}` : '');
  $('#day-date').textContent = fmtFull(d);
  $('#btn-next').disabled = d >= t;
  const rel = d === t ? '<span class="tag">Hoje</span>' : d === addDays(t, -1) ? '<span class="tag">Ontem</span>' : '';
  const closer = rec?.closed_by ? memberById(rec.closed_by)?.name : null;
  const badge = !loaded ? '' : closed
    ? `<span class="badge">${icon('lock', 12)}Fechado às ${fmtTime(rec.closed_at)}${closer ? ` por ${esc(closer)}` : ''}</span>`
    : '<span class="badge">Aberto</span>';
  $('#day-state').innerHTML = rel + badge;

  const actions = [];
  if (d !== t) actions.push(`<button class="btn ghost sm" data-action="go-today">Ir para hoje</button>`);
  actions.push(`<a class="btn secondary sm" href="#relatorio/${d}">${icon('report', 15)}Relatório do dia</a>`);
  if (loaded) {
    actions.push(closed
      ? `<button class="btn secondary sm" data-action="reopen-day">${icon('unlock', 15)}Reabrir dia</button>`
      : `<button class="btn secondary sm" data-action="close-day">${icon('lock', 15)}Fechar dia</button>`);
  }
  $('#day-actions').innerHTML = actions.join('');

  // KPIs (não re-renderiza enquanto alguém digita os pendentes)
  if (document.activeElement?.id !== 'pending-input') {
    const pend = rec?.pending;
    const share = (n) => (s.total ? `${pct(n, s.total)}% do total` : '—');
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">Revisados</div><div class="kpi-value">${s.total}</div>
        <div class="kpi-sub">${s.total ? plural(s.byMember.size, 'pessoa', 'pessoas') : 'Nenhum ainda'}</div></div>
      <div class="kpi"><div class="kpi-label"><i class="dot ok"></i>Aprovados</div><div class="kpi-value">${s.approved}</div><div class="kpi-sub">${share(s.approved)}</div></div>
      <div class="kpi"><div class="kpi-label"><i class="dot no"></i>Rejeitados</div><div class="kpi-value">${s.rejected}</div><div class="kpi-sub">${share(s.rejected)}</div></div>
      <div class="kpi"><div class="kpi-label"><i class="dot pend"></i>Pendentes</div>
        <div class="kpi-value">
          <input class="pending-input" id="pending-input" type="number" min="0" max="9999" inputmode="numeric" placeholder="—"
                 value="${pend ?? ''}" aria-label="PRs pendentes na fila" ${closed || !loaded ? 'disabled' : ''}
                 style="width:${Math.max(1, String(pend ?? '—').length) + 0.6}ch">
          ${closed || !loaded ? '' : `<span class="stepper">
            <button class="btn ghost icon" type="button" data-action="pending-dec" aria-label="Diminuir pendentes">${icon('minus', 14)}</button>
            <button class="btn ghost icon" type="button" data-action="pending-inc" aria-label="Aumentar pendentes">${icon('plus', 14)}</button></span>`}
        </div>
        <div class="kpi-sub">${closed ? 'no fechamento' : 'na fila agora'}</div></div>
      <div class="kpi"><div class="kpi-label">Taxa de aprovação</div><div class="kpi-value">${fmtPct(s.rate)}</div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.rate ?? 0}" aria-label="Taxa de aprovação"><i style="width:${s.rate ?? 0}%"></i></div></div>`;
  }

  // Campo de registro
  const entry = $('#entry');
  entry.classList.toggle('is-locked', closed);
  $('#entry-locked').hidden = !closed;
  if (closed) {
    $('#entry-locked').innerHTML = `${icon('lock', 16)}<span>Dia fechado${closer ? ` por <strong>${esc(closer)}</strong>` : ''} às ${fmtTime(rec.closed_at)}. Reabra para registrar ou editar.</span>
      <button class="btn secondary sm" type="button" data-action="reopen-day">${icon('unlock', 14)}Reabrir dia</button>`;
  }
  $('#entry-as').innerHTML = state.me
    ? `${avatar(state.me, 20)}<span>Registrando como <strong>${esc(state.me.name)}</strong></span><button type="button" class="linkish" data-action="switch-user">trocar</button>`
    : `<button type="button" class="linkish" data-action="switch-user">Escolha seu nome para registrar</button>`;

  // Lista
  const list = reviews.filter((r) => state.recFilter === 'all'
    || (state.recFilter === 'mine' ? r.member_id === state.me?.id : r.status === state.recFilter));
  $('#rec-count').textContent = reviews.length;
  $$('#rec-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.recFilter)));
  const el = $('#records');
  if (!loaded) el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  else if (!reviews.length) {
    el.innerHTML = `<div class="empty"><div class="empty-title">Nenhum PR registrado ${d === t ? 'hoje' : 'neste dia'}</div>
      ${closed ? 'O dia foi fechado sem registros.' : 'Cole o ID no campo acima e pressione <kbd>↵</kbd> para aprovar ou <kbd>⇧</kbd><kbd>↵</kbd> para rejeitar.'}</div>`;
  } else if (!list.length) el.innerHTML = '<div class="empty">Nenhum registro com esse filtro.</div>';
  else el.innerHTML = list.map(rowHtml).join('');

  // Lateral
  const rows = [...s.byMember.entries()]
    .map(([id, v]) => ({ m: memberById(id) || { id, name: '—' }, ...v }))
    .sort((a, b) => b.total - a.total || a.m.name.localeCompare(b.m.name));
  const max = Math.max(1, ...rows.map((r) => r.total));
  $('#by-member').innerHTML = rows.length
    ? rows.map((r) => `<div class="who">${avatar(r.m, 24)}<span class="who-name">${esc(r.m.name)}</span>
        <span class="who-nums" aria-label="${r.approved} aprovados, ${r.rejected} rejeitados"><span><i class="dot ok"></i>${r.approved}</span><span><i class="dot no"></i>${r.rejected}</span></span>
        <div class="who-bar" style="width:${(r.total / max) * 100}%">${r.approved ? `<i class="ok" style="flex:${r.approved}"></i>` : ''}${r.rejected ? `<i class="no" style="flex:${r.rejected}"></i>` : ''}</div></div>`).join('')
    : '<p class="aside-empty">Ninguém registrou ainda.</p>';

  const note = $('#day-note');
  if (document.activeElement !== note) note.value = rec?.note || '';
  note.disabled = closed || !loaded;
}

function rowHtml(r) {
  const m = memberById(r.member_id);
  const id = r.link
    ? `<a class="row-id" href="${esc(r.link)}" target="_blank" rel="noopener" title="Abrir ${esc(r.pr)}">${esc(r.pr)}${icon('external', 12)}</a>`
    : `<span class="row-id" title="${esc(r.pr)}">${esc(r.pr)}</span>`;
  return `<div class="row${state.newIds.has(r.id) ? ' is-new' : ''}" data-action="edit-review" data-id="${r.id}">
    ${statusIcon(r.status, 20)}
    <div class="row-main">${id}${r.attempt > 0 ? `<span class="tag" title="Este PR já foi revisado antes">${r.attempt + 1}ª análise</span>` : ''}${r.note ? `<span class="row-note" title="${esc(r.note)}">${esc(r.note)}</span>` : ''}</div>
    <span class="row-who">${avatar(m, 20)}<span>${esc(m?.name || '—')}</span></span>
    <span class="row-time">${fmtTime(r.created_at)}</span>
    <button class="btn ghost sm icon row-menu" type="button" data-action="review-menu" data-id="${r.id}" aria-label="Ações para ${esc(r.pr)}" aria-haspopup="menu">${icon('more', 16)}</button>
  </div>`;
}

// --- Registro --------------------------------------------------------------
let submitting = false;
async function submitEntry(status) {
  if (submitting) return;
  const input = $('#entry-input');
  const items = parsePrInput(input.value);
  if (!items.length) {
    input.focus();
    toast('Digite ou cole o identificador do PR.', { error: true, duration: 2500 });
    return;
  }
  if (!state.me) {
    await pickUser({ required: false });
    if (!state.me) return;
  }
  let note = null;
  if (status === 'rejected') {
    const res = await rejectDialog(items);
    if (res === null) { input.focus(); return; }
    note = res;
  }
  submitting = true;
  $('#btn-approve').disabled = true;
  $('#btn-reject').disabled = true;
  try {
    const { created } = await api.addReviews({ day: state.day, status, member_id: state.me.id, items, note });
    input.value = '';
    setHint('');
    created.forEach((c) => state.newIds.add(c.id));
    setTimeout(() => created.forEach((c) => state.newIds.delete(c.id)), 1500);
    await loadDay({ silent: true });
    const n = created.length;
    const verb = status === 'approved' ? (n > 1 ? 'aprovados' : 'aprovado') : (n > 1 ? 'rejeitados' : 'rejeitado');
    toast(`${n > 1 ? `${n} PRs` : created[0].pr} ${verb}`, {
      iconHtml: statusIcon(status, 16),
      action: {
        label: 'Desfazer',
        fn: async () => {
          for (const c of created) await api.deleteReview(c.id);
          await loadDay({ silent: true });
          toast('Registro desfeito.', { duration: 2500 });
        },
      },
    });
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    submitting = false;
    $('#btn-approve').disabled = false;
    $('#btn-reject').disabled = false;
    input.focus();
  }
}

function rejectDialog(items) {
  const label = items.length === 1 ? items[0].pr : `${items.length} PRs`;
  return dialog({
    html: `<form id="rej-form">
      <div class="dlg-body">
        <h2 class="dlg-title">Rejeitar <span class="mono" style="font-size:17px;letter-spacing:-0.02em">${esc(label)}</span></h2>
        <p class="dlg-desc">O motivo é opcional, mas ajuda a gestão a entender o retrabalho.</p>
        <div class="dlg-fields">
          <textarea class="textarea" id="rej-note" maxlength="1000" rows="3" placeholder="Ex.: quebra no fluxo de cadastro, faltou evidência de teste…"></textarea>
        </div>
        <p class="help"><kbd>↵</kbd> confirma · <kbd>⇧</kbd><kbd>↵</kbd> nova linha</p>
      </div>
      <div class="dlg-foot">
        <button class="btn secondary sm" type="button" data-dlg-cancel>Cancelar</button>
        <button class="btn primary sm" type="submit">${statusIcon('rejected', 14)}Rejeitar</button>
      </div></form>`,
    mount: (dlg, finish) => {
      const ta = $('#rej-note', dlg);
      ta.focus();
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(ta.value.trim()); }
      });
      $('#rej-form', dlg).addEventListener('submit', (e) => { e.preventDefault(); finish(ta.value.trim()); });
    },
  });
}

// --- Dica "já revisado antes" --------------------------------------------
function setHint(html, warn = false) {
  const el = $('#entry-hint');
  el.innerHTML = html;
  el.classList.toggle('warn', warn);
}
let lookupSeq = 0;
const lookupPr = debounce(async (value) => {
  const items = parsePrInput(value);
  const seq = ++lookupSeq;
  if (!items.length) return setHint('');
  if (items.length > 1) return setHint(`<span><strong style="color:var(--fg)">${items.length} PRs</strong> serão registrados de uma vez</span>`);
  try {
    const { results } = await api.lookup(items[0].pr);
    if (seq !== lookupSeq) return;
    if (!results.length) return setHint(items[0].link ? `<span>Link reconhecido como <span class="mono">${esc(items[0].pr)}</span></span>` : '');
    const last = results[0];
    const when = last.day === state.day ? 'hoje' : `em ${fmtShort(last.day)}`;
    const st = last.status === 'approved' ? 'aprovado' : 'rejeitado';
    setHint(`<span>Já ${st} por ${esc(last.member_name)} ${when}${last.note ? ` — “${esc(last.note)}”` : ''}${results.length > 1 ? ` · ${results.length} revisões` : ''}</span>`, true);
  } catch { /* silencioso */ }
}, 250);

// --- Ações em registros ----------------------------------------------------
function reviewById(id) {
  return state.dayData?.reviews.find((r) => r.id === id)
    || state.hist.data?.reviews.find((r) => r.id === id);
}

async function deleteReview(r) {
  await api.deleteReview(r.id);
  await loadView({ silent: true });
  toast(`${r.pr} excluído`, {
    iconHtml: icon('trash', 16),
    action: {
      label: 'Desfazer',
      fn: async () => {
        await api.addReviews({ day: r.day, status: r.status, member_id: r.member_id, note: r.note, items: [{ pr: r.pr, link: r.link }] });
        await loadView({ silent: true });
      },
    },
  });
}

async function toggleStatus(r) {
  const status = r.status === 'approved' ? 'rejected' : 'approved';
  await api.updateReview(r.id, { status });
  await loadView({ silent: true });
  toast(`${r.pr} marcado como ${status === 'approved' ? 'aprovado' : 'rejeitado'}`, {
    iconHtml: statusIcon(status, 16),
    action: { label: 'Desfazer', fn: async () => { await api.updateReview(r.id, { status: r.status }); await loadView({ silent: true }); } },
  });
}

function openReviewMenu(anchor, r) {
  const closed = isDayClosed(r.day);
  const other = r.status === 'approved' ? 'rejeitado' : 'aprovado';
  const html = `
    ${menuItem('edit', closed ? 'Ver detalhes' : 'Editar', closed ? 'note' : 'pencil')}
    ${menuItem('toggle', `Marcar como ${other}`, 'swap', { disabled: closed })}
    ${menuItem('copy', 'Copiar ID', 'copy')}
    ${r.link ? menuItem('open', 'Abrir link', 'external') : ''}
    <div class="menu-sep"></div>
    ${menuItem('delete', 'Excluir', 'trash', { danger: true, disabled: closed })}`;
  openMenu(anchor, html, async (id) => {
    try {
      if (id === 'edit') editReview(r);
      if (id === 'toggle') await toggleStatus(r);
      if (id === 'copy') { await copyText(r.pr); toast('ID copiado.', { duration: 2000 }); }
      if (id === 'open') window.open(r.link, '_blank', 'noopener');
      if (id === 'delete') await deleteReview(r);
    } catch (e) { toast(e.message, { error: true }); }
  });
}

async function editReview(r) {
  const closed = isDayClosed(r.day);
  const members = state.meta.members.filter((m) => m.active || m.id === r.member_id);
  const dis = closed ? 'disabled' : '';
  await dialog({
    html: `<form id="edit-form" autocomplete="off">
      <div class="dlg-body">
        <h2 class="dlg-title">${closed ? 'Detalhes do registro' : 'Editar registro'}</h2>
        <p class="dlg-desc">Registrado por ${esc(memberById(r.member_id)?.name || '—')} em ${fmtFull(r.day)} às ${fmtTime(r.created_at)}${closed ? ' · dia fechado' : ''}.</p>
        <div class="dlg-fields">
          <div><label class="field-label" for="ed-pr">PR</label><input class="input mono" id="ed-pr" maxlength="200" value="${esc(r.pr)}" ${dis}></div>
          <div><span class="field-label">Status</span>
            <div class="status-pick" id="ed-status">
              <button type="button" data-st="approved" aria-pressed="${r.status === 'approved'}" ${dis}>${statusIcon('approved', 18)}Aprovado</button>
              <button type="button" data-st="rejected" aria-pressed="${r.status === 'rejected'}" ${dis}>${statusIcon('rejected', 18)}Rejeitado</button>
            </div></div>
          <div class="dlg-row">
            <div><label class="field-label" for="ed-member">Responsável</label>
              <span class="select-wrap" style="width:100%"><select class="select" id="ed-member" ${dis}>${members.map((m) => `<option value="${m.id}" ${m.id === r.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>${icon('chevronDown', 14)}</span></div>
            <div><label class="field-label" for="ed-day">Dia</label><input class="input" type="date" id="ed-day" value="${r.day}" max="${today()}" ${dis}></div>
          </div>
          <div><label class="field-label" for="ed-link">Link <span class="faint">(opcional)</span></label><input class="input" id="ed-link" maxlength="1000" placeholder="https://…" value="${esc(r.link || '')}" ${dis}></div>
          <div><label class="field-label" for="ed-note">Observação <span class="faint">(opcional)</span></label><textarea class="textarea" id="ed-note" rows="2" maxlength="1000" ${dis}>${esc(r.note || '')}</textarea></div>
        </div>
        <p class="dlg-error" id="ed-error" hidden></p>
      </div>
      <div class="dlg-foot">
        ${closed ? '' : `<button class="btn ghost sm" type="button" id="ed-delete" style="color:var(--danger-fg)">${icon('trash', 15)}Excluir</button>`}
        <div class="right">
          <button class="btn secondary sm" type="button" data-dlg-cancel>${closed ? 'Fechar' : 'Cancelar'}</button>
          ${closed ? '' : '<button class="btn primary sm" type="submit">Salvar</button>'}
        </div>
      </div></form>`,
    mount: (dlg, finish) => {
      if (closed) return;
      let status = r.status;
      $$('#ed-status button', dlg).forEach((b) => b.addEventListener('click', () => {
        status = b.dataset.st;
        $$('#ed-status button', dlg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
      $('#ed-delete', dlg).addEventListener('click', async () => {
        finish(true);
        try { await deleteReview(r); } catch (e) { toast(e.message, { error: true }); }
      });
      $('#edit-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#ed-error', dlg);
        try {
          await api.updateReview(r.id, {
            pr: $('#ed-pr', dlg).value,
            status,
            member_id: Number($('#ed-member', dlg).value),
            day: $('#ed-day', dlg).value,
            link: $('#ed-link', dlg).value,
            note: $('#ed-note', dlg).value,
          });
          finish(true);
          await loadView({ silent: true });
          toast('Registro atualizado.', { duration: 2500 });
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
      $('#ed-pr', dlg).focus();
    },
  });
}

// --- Pendentes, observações, fechar dia -----------------------------------
const savePending = debounce(async (day, value) => {
  try { await api.updateDay(day, { pending: value }); } catch (e) { toast(e.message, { error: true }); }
}, 350);

function changePending(delta) {
  const input = $('#pending-input');
  if (!input || input.disabled) return;
  const cur = input.value === '' ? 0 : Number(input.value);
  const next = Math.max(0, Math.min(9999, cur + delta));
  input.value = String(next);
  input.style.width = `${String(next).length + 0.6}ch`;
  const rec = dayRecord();
  if (rec) rec.pending = next;
  else state.dayData?.days.push({ day: state.day, pending: next });
  savePending(state.day, next);
}

let noteSeq = 0;
const saveNote = debounce(async (day, value) => {
  const seq = ++noteSeq;
  const status = $('#day-note-status');
  status.textContent = 'Salvando…';
  try {
    await api.updateDay(day, { note: value });
    if (seq === noteSeq) status.textContent = `Salvo às ${fmtTime(new Date().toISOString())} · vai junto no relatório.`;
  } catch (e) {
    status.textContent = 'Não foi possível salvar.';
    toast(e.message, { error: true });
  }
}, 700);

async function closeDayDialog() {
  const day = state.day;
  const rec = dayRecord();
  const s = summarize(state.dayData?.reviews || []);
  if (!state.me) {
    await pickUser({ required: false });
    if (!state.me) return;
  }
  const result = await dialog({
    html: `<form id="close-form">
      <div class="dlg-body">
        <h2 class="dlg-title">Fechar o dia</h2>
        <p class="dlg-desc">${esc(fmtDayMonth(day))}. Depois de fechado, os registros ficam travados até alguém reabrir.</p>
        <div class="dlg-summary">
          <span><i class="dot ok"></i><strong>${s.approved}</strong> aprovados</span>
          <span><i class="dot no"></i><strong>${s.rejected}</strong> rejeitados</span>
          <span><strong>${fmtPct(s.rate)}</strong> de aprovação</span>
        </div>
        <div class="dlg-fields">
          <div><label class="field-label" for="cl-pending">PRs pendentes na fila</label>
            <input class="input mono" id="cl-pending" type="number" min="0" max="9999" inputmode="numeric" placeholder="0" value="${rec?.pending ?? ''}" style="max-width:140px"></div>
          <div><label class="field-label" for="cl-note">Observações para a gestão <span class="faint">(opcional)</span></label>
            <textarea class="textarea" id="cl-note" rows="3" maxlength="2000" placeholder="Ex.: ambiente de homologação instável à tarde.">${esc(rec?.note || $('#day-note').value || '')}</textarea></div>
        </div>
        <p class="dlg-error" id="cl-error" hidden></p>
      </div>
      <div class="dlg-foot">
        <button class="btn secondary sm" type="button" data-dlg-cancel>Cancelar</button>
        <div class="right">
          <button class="btn secondary sm" type="submit" data-then="stay">Só fechar</button>
          <button class="btn primary sm" type="submit" data-then="report">${icon('report', 15)}Fechar e gerar relatório</button>
        </div>
      </div></form>`,
    mount: (dlg, finish) => {
      $('#cl-pending', dlg).focus();
      $('#close-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const then = e.submitter?.dataset.then || 'stay';
        const pendingRaw = $('#cl-pending', dlg).value;
        try {
          await api.closeDay(day, {
            member_id: state.me.id,
            pending: pendingRaw === '' ? null : Number(pendingRaw),
            note: $('#cl-note', dlg).value,
          });
          finish(then);
        } catch (ex) {
          const err = $('#cl-error', dlg);
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    },
  });
  if (!result) return;
  if (result === 'report') {
    location.hash = `#relatorio/${day}`;
    toast('Dia fechado. Relatório pronto para enviar.', { iconHtml: icon('lock', 16) });
  } else {
    await loadDay({ silent: true });
    toast('Dia fechado.', {
      iconHtml: icon('lock', 16),
      action: { label: 'Ver relatório', fn: () => { location.hash = `#relatorio/${day}`; } },
    });
  }
}

async function reopenDay(day = state.day) {
  await api.reopenDay(day);
  await loadView({ silent: true });
  toast('Dia reaberto para edição.', { iconHtml: icon('unlock', 16), duration: 3000 });
}

// ===========================================================================
// HISTÓRICO
// ===========================================================================
function histRange() {
  const t = today();
  switch (state.hist.preset) {
    case '7d': return [addDays(t, -6), t];
    case 'month': return [startOfMonth(t), t];
    case 'lastmonth': { const p = addDays(startOfMonth(t), -1); return [startOfMonth(p), endOfMonth(p)]; }
    case 'all': return [null, t];
    default: return [addDays(t, -29), t];
  }
}

async function loadHistory({ silent = false } = {}) {
  const [from, to] = histRange();
  const key = `${from}|${to}`;
  if (!silent && state.hist.data?.key !== key) {
    $('#hist-days').innerHTML = '<div class="days"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  }
  const data = await api.data(from || '1970-01-01', to);
  const [f2, t2] = histRange();
  if (`${f2}|${t2}` !== key) return;
  state.hist.data = { key, from, to, ...data };
  renderHistory();
}

function fillMemberSelect(sel, value) {
  const opts = ['<option value="">Equipe toda</option>']
    .concat(state.meta.members.map((m) => `<option value="${m.id}">${esc(m.name)}${m.active ? '' : ' (inativo)'}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = value || '';
}

function highlight(text, q) {
  const s = esc(text);
  if (!q) return s;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return s;
  return esc(text.slice(0, i)) + `<mark class="mark">${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length));
}

function relDay(d) {
  const n = diffDays(d, today());
  if (n === 0) return 'hoje';
  if (n === 1) return 'ontem';
  if (n < 7) return `há ${n} dias`;
  if (d.slice(0, 4) !== today().slice(0, 4)) return d.slice(0, 4);
  return `há ${Math.round(n / 7)} sem.`;
}

function renderHistory() {
  const h = state.hist;
  $$('#hist-preset button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === h.preset)));
  fillMemberSelect($('#hist-member'), h.member);
  if (!h.data) return;

  const q = h.q.trim().toLowerCase();
  const memberId = h.member ? Number(h.member) : null;
  const reviews = h.data.reviews.filter((r) => (!memberId || r.member_id === memberId)
    && (!q || r.pr.toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q)));
  const daysMap = new Map(h.data.days.map((d) => [d.day, d]));
  const from = h.data.from || (h.data.reviews.length ? h.data.reviews.at(-1).day : today());
  const to = h.data.to;

  const byDay = new Map();
  for (const r of reviews) (byDay.get(r.day) || byDay.set(r.day, []).get(r.day)).push(r);
  const dayKeys = [...byDay.keys()].sort().reverse();
  const s = summarize(reviews);

  const csv = $('#hist-csv');
  csv.href = api.csvUrl(h.data.from, to);
  $('#hist-sub').textContent = `${fmtRange(from, to)} · ${plural(dayKeys.length, 'dia com revisões', 'dias com revisões')}`;

  const avg = dayKeys.length ? (s.total / dayKeys.length) : 0;
  $('#hist-kpis').innerHTML = `
    <div class="kpi"><div class="kpi-label">Revisados</div><div class="kpi-value">${s.total}</div><div class="kpi-sub">${plural(s.byMember.size, 'pessoa', 'pessoas')}</div></div>
    <div class="kpi"><div class="kpi-label"><i class="dot ok"></i>Aprovados</div><div class="kpi-value">${s.approved}</div><div class="kpi-sub">${s.total ? `${pct(s.approved, s.total)}% do total` : '—'}</div></div>
    <div class="kpi"><div class="kpi-label"><i class="dot no"></i>Rejeitados</div><div class="kpi-value">${s.rejected}</div><div class="kpi-sub">${s.total ? `${pct(s.rejected, s.total)}% do total` : '—'}</div></div>
    <div class="kpi"><div class="kpi-label">Média por dia</div><div class="kpi-value">${avg ? avg.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'}</div><div class="kpi-sub">em ${plural(dayKeys.length, 'dia', 'dias')}</div></div>
    <div class="kpi"><div class="kpi-label">Taxa de aprovação</div><div class="kpi-value">${fmtPct(s.rate)}</div><div class="meter"><i style="width:${s.rate ?? 0}%"></i></div></div>`;

  const buckets = bucketize(reviews, from, to);
  $('#hist-chart').innerHTML = buckets.length > 1 && s.total ? `<div class="panel">
      <div class="panel-head"><h2>${buckets[0].label === 'Sem' ? 'Revisões por semana' : 'Revisões por dia'}</h2>${chartLegend()}</div>
      ${columnChart(buckets, { height: 150 })}
    </div>` : '';

  if (!dayKeys.length) {
    $('#hist-days').innerHTML = `<div class="days"><div class="empty"><div class="empty-title">${q ? 'Nenhum PR encontrado' : 'Nada por aqui ainda'}</div>${q ? `Nenhum registro com “${esc(h.q)}” neste período.` : 'Os dias aparecem aqui conforme a equipe registra revisões.'}</div></div>`;
    return;
  }

  const maxTotal = Math.max(1, ...dayKeys.map((d) => byDay.get(d).length));
  const rows = dayKeys.map((d) => {
    const rs = byDay.get(d);
    const ds = summarize(rs);
    const info = daysMap.get(d);
    const open = h.open.has(d) || Boolean(q);
    return `<div class="day${open ? ' is-open' : ''}">
      <button class="day-row" type="button" data-action="toggle-day" data-day="${d}" aria-expanded="${open}">
        <span class="day-date"><strong>${fmtWeekday(d)}, ${fmtShort(d)}</strong><span>${relDay(d)}</span></span>
        <span class="day-bar" style="width:${(ds.total / maxTotal) * 100}%">${ds.approved ? `<i class="ok" style="flex:${ds.approved}"></i>` : ''}${ds.rejected ? `<i class="no" style="flex:${ds.rejected}"></i>` : ''}</span>
        <span class="day-num${ds.approved ? '' : ' zero'}"><i class="dot ok"></i>${ds.approved}</span>
        <span class="day-num${ds.rejected ? '' : ' zero'}"><i class="dot no"></i>${ds.rejected}</span>
        <span class="day-num c-pend${info?.pending ? '' : ' zero'}"><i class="dot pend"></i>${info?.pending ?? '—'}</span>
        <span class="day-rate c-rate">${fmtPct(ds.rate)}</span>
        <span class="c-state" style="justify-self:end">${info?.closed_at ? `<span class="badge">${icon('lock', 11)}Fechado</span>` : '<span class="badge">Aberto</span>'}</span>
        <span class="day-chev">${icon('chevronDown', 16)}</span>
      </button>
      ${open ? dayDetail(d, rs, ds, info, q) : ''}
    </div>`;
  }).join('');

  $('#hist-days').innerHTML = `<div class="days">
    <div class="days-head"><span>Dia</span><span>Distribuição</span><span class="r">Aprovados</span><span class="r">Rejeitados</span><span class="r c-pend">Pendentes</span><span class="r c-rate">Aprovação</span><span class="r c-state">Status</span><span></span></div>
    ${rows}</div>`;
}

function dayDetail(d, rs, ds, info, q) {
  const people = [...ds.byMember.entries()]
    .map(([id, v]) => ({ m: memberById(id) || { id, name: '—' }, ...v }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...people.map((p) => p.total));
  const closer = info?.closed_by ? memberById(info.closed_by)?.name : null;
  return `<div class="day-detail">
    <div>
      <h4>Por responsável</h4>
      ${people.map((p) => `<div class="who">${avatar(p.m, 24)}<span class="who-name">${esc(p.m.name)}</span>
        <span class="who-nums"><span><i class="dot ok"></i>${p.approved}</span><span><i class="dot no"></i>${p.rejected}</span></span>
        <div class="who-bar" style="width:${(p.total / max) * 100}%">${p.approved ? `<i class="ok" style="flex:${p.approved}"></i>` : ''}${p.rejected ? `<i class="no" style="flex:${p.rejected}"></i>` : ''}</div></div>`).join('')}
      ${info?.note ? `<p class="day-note">${esc(info.note)}</p>` : ''}
      ${info?.closed_at ? `<p class="day-closed">${icon('lock', 12)}Fechado às ${fmtTime(info.closed_at)}${closer ? ` por ${esc(closer)}` : ''}</p>` : ''}
      <div class="day-links">
        <a class="btn secondary xs" href="#hoje/${d}">${icon('calendar', 13)}Abrir dia</a>
        <a class="btn secondary xs" href="#relatorio/${d}">${icon('report', 13)}Relatório</a>
      </div>
    </div>
    <div>
      <h4>Registros · ${rs.length}</h4>
      <ul class="mini-list">${rs.map((r) => {
        const m = memberById(r.member_id);
        return `<li class="mini">${statusIcon(r.status, 16)}<span class="mini-id" title="${esc(r.pr)}">${highlight(r.pr, q)}</span>
          ${r.attempt > 0 ? `<span class="tag">${r.attempt + 1}ª</span>` : ''}
          <span class="mini-meta">${avatar(m, 16)}${esc(m?.name || '—')}<span class="mono">${fmtTime(r.created_at)}</span></span></li>`;
      }).join('')}</ul>
    </div>
  </div>`;
}

// ===========================================================================
// RELATÓRIO
// ===========================================================================
const REP_PRESETS = [
  ['today', 'Hoje'],
  ['yesterday', 'Ontem'],
  ['week', 'Esta semana'],
  ['lastweek', 'Semana passada'],
  ['month', 'Este mês'],
  ['lastmonth', 'Mês passado'],
];

function presetRange(p) {
  const t = today();
  switch (p) {
    case 'today': return [t, t];
    case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
    case 'week': return [startOfWeek(t), t];
    case 'lastweek': { const s = addDays(startOfWeek(t), -7); return [s, addDays(s, 6)]; }
    case 'month': return [startOfMonth(t), t];
    case 'lastmonth': { const p2 = addDays(startOfMonth(t), -1); return [startOfMonth(p2), endOfMonth(p2)]; }
    default: return [state.rep.from, state.rep.to];
  }
}

function setReportRange(preset, from, to, { fromLink = false } = {}) {
  const r = state.rep;
  let [f, t] = preset === 'custom' ? [from, to] : presetRange(preset);
  if (f > t) [f, t] = [t, f];
  if (fromLink || preset === 'custom') {
    const match = REP_PRESETS.find(([p]) => { const [a, b] = presetRange(p); return a === f && b === t; });
    preset = match ? match[0] : 'custom';
  }
  r.preset = preset;
  r.from = f;
  r.to = t;
  if (!r.listTouched) r.showList = f === t;
}

const rangeHint = (f, t) => (f === t ? fmtShort(f) : `${fmtShort(f)}–${fmtShort(t)}`);

async function loadReport({ silent = false } = {}) {
  const { from, to } = state.rep;
  const key = `${from}|${to}`;
  renderReportControls();
  if (!silent && state.rep.data?.key !== key) $('#report-preview').style.opacity = '0.5';
  const data = await api.data(from, to);
  if (`${state.rep.from}|${state.rep.to}` !== key) return;
  state.rep.data = { key, ...data };
  $('#report-preview').style.opacity = '';
  renderReportView();
}

function renderReportControls() {
  const r = state.rep;
  $('#rep-presets').innerHTML = REP_PRESETS.map(([p, label]) => {
    const [a, b] = presetRange(p);
    return `<button type="button" class="preset" data-preset="${p}" aria-pressed="${r.preset === p}">
      <span>${label} <small>${rangeHint(a, b)}</small></span>${icon('check', 16, 2.4)}</button>`;
  }).join('') + `<div class="preset-custom">
      <div><label for="rep-from">De</label><input class="input" type="date" id="rep-from" value="${r.from}" max="${today()}"></div>
      <div><label for="rep-to">Até</label><input class="input" type="date" id="rep-to" value="${r.to}" max="${today()}"></div>
    </div>`;
  fillMemberSelect($('#rep-member'), r.member);
  $('#rep-list').checked = r.showList;
  $('#rep-chart').checked = r.showChart;
  $('#rep-chart').disabled = r.from === r.to;
  $('#rep-chart').closest('.check').style.opacity = r.from === r.to ? '0.45' : '';
  const theme = r.theme || resolvedTheme();
  $$('#rep-theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
}

function renderReportView() {
  const r = state.rep;
  if (!r.data) return;
  r.model = buildReportModel({
    from: r.from, to: r.to, memberId: r.member ? Number(r.member) : null,
    data: r.data, meta: state.meta, me: state.me,
  });
  $('#report-preview').innerHTML = renderReport(r.model, {
    theme: r.theme || resolvedTheme(), showList: r.showList, showChart: r.showChart,
  });
  $$('#rep-theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === (r.theme || resolvedTheme()))));
}

const reportNode = () => $('#report-preview .rpt');
const reportFilename = () => {
  const { from, to } = state.rep;
  return `relatorio-prs-${from}${to !== from ? `_a_${to}` : ''}.png`;
};

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message || 'Algo deu errado.', { error: true }); } finally { btn.disabled = false; }
}

async function reportCopy(btn) {
  const node = reportNode();
  if (!node) return;
  await withBusy(btn, async () => {
    if (canCopyImage()) {
      try {
        await copyImage(node);
        toast('Imagem copiada. Cole com Ctrl+V no Teams, WhatsApp ou e-mail.', { iconHtml: icon('check', 16, 2.4) });
        return;
      } catch { /* cai no download */ }
    }
    await downloadImage(node, reportFilename());
    toast('Seu navegador só copia imagens em HTTPS ou localhost. Baixei o PNG.', { iconHtml: icon('download', 16), duration: 6000 });
  });
}

let presentEl = null;
function openPresent() {
  const node = reportNode();
  if (!node) return;
  presentEl = document.createElement('div');
  presentEl.className = 'present';
  presentEl.style.background = getComputedStyle(node).backgroundColor;
  presentEl.innerHTML = node.outerHTML
    + `<div class="present-hint">${icon('image', 14)}<span>Recorte com <kbd>Win</kbd><kbd>Shift</kbd><kbd>S</kbd> · <kbd>Esc</kbd> para sair</span></div>`;
  presentEl.addEventListener('click', (e) => { if (e.target === presentEl) closePresent(); });
  document.body.appendChild(presentEl);
  document.body.style.overflow = 'hidden';
  setTimeout(() => { const h = presentEl?.querySelector('.present-hint'); if (h) h.style.opacity = '0'; }, 3500);
}
function closePresent() {
  presentEl?.remove();
  presentEl = null;
  document.body.style.overflow = '';
}

// ===========================================================================
// EQUIPE
// ===========================================================================
function renderTeam() {
  const ti = $('#team-input');
  if (document.activeElement !== ti) ti.value = state.meta.settings.team_name || '';

  const members = state.meta.members;
  $('#members').innerHTML = members.length ? members.map((m) => `
    <div class="member${m.active ? '' : ' is-inactive'}">
      ${avatar(m, 32)}
      <div class="member-name"><span>${esc(m.name)}</span>${m.id === state.me?.id ? '<span class="tag">Você</span>' : ''}${m.active ? '' : '<span class="tag">Inativo</span>'}</div>
      <span class="member-stats">${plural(m.total, 'revisão', 'revisões')}</span>
      <button class="btn ghost sm icon" type="button" data-action="member-menu" data-id="${m.id}" aria-label="Ações para ${esc(m.name)}" aria-haspopup="menu">${icon('more', 16)}</button>
    </div>`).join('') : '<div class="empty">Ninguém na equipe ainda.</div>';

  const hosted = state.meta.storage === 'postgres';
  const urls = [...new Set([location.origin, ...state.meta.urls])];
  const accessCard = $('#access').closest('.setting');
  accessCard.querySelector('.desc').textContent = hosted
    ? 'Compartilhe este endereço com o time. Funciona de qualquer lugar, não só na rede da empresa.'
    : 'Compartilhe um destes endereços com o time (precisa estar na mesma rede que este computador).';
  accessCard.querySelector('.setting-foot span').textContent = state.meta.auth_required
    ? 'Protegido pelo código da equipe. Cada navegador pede o código uma vez.'
    : 'Dica: fixe o endereço como favorito no navegador de cada analista.';
  $('#access').innerHTML = urls.map((u) => `<div class="copy-field"><span>${esc(u)}</span>
    <button class="btn ghost xs icon" type="button" data-action="copy" data-text="${esc(u)}" aria-label="Copiar endereço">${icon('copy', 14)}</button></div>`).join('');

}

function openMemberMenu(anchor, m) {
  const html = `
    ${m.active && m.id !== state.me?.id ? menuItem('me', 'Usar como meu usuário', 'users') : ''}
    ${menuItem('rename', 'Renomear', 'pencil')}
    <div class="menu-sep"></div>
    ${m.active ? menuItem('deactivate', 'Desativar', 'lock', { danger: true }) : menuItem('activate', 'Reativar', 'unlock')}`;
  openMenu(anchor, html, async (id) => {
    try {
      if (id === 'me') setMe(m);
      if (id === 'rename') await renameMember(m);
      if (id === 'deactivate' || id === 'activate') {
        await api.updateMember(m.id, { active: id === 'activate' });
        await loadMeta();
        renderTeam();
        toast(id === 'activate' ? `${m.name} reativado.` : `${m.name} desativado. O histórico continua.`, { duration: 3000 });
      }
    } catch (e) { toast(e.message, { error: true }); }
  });
}

async function renameMember(m) {
  await dialog({
    html: `<form id="ren-form"><div class="dlg-body">
        <h2 class="dlg-title">Renomear</h2>
        <p class="dlg-desc">O novo nome vale para todo o histórico.</p>
        <div class="dlg-fields"><input class="input" id="ren-name" maxlength="40" value="${esc(m.name)}" aria-label="Nome"></div>
        <p class="dlg-error" id="ren-error" hidden></p>
      </div>
      <div class="dlg-foot"><button class="btn secondary sm" type="button" data-dlg-cancel>Cancelar</button>
        <button class="btn primary sm" type="submit">Salvar</button></div></form>`,
    mount: (dlg, finish) => {
      const input = $('#ren-name', dlg);
      input.select();
      $('#ren-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.updateMember(m.id, { name: input.value });
          await loadMeta();
          renderTeam();
          finish(true);
        } catch (ex) { const err = $('#ren-error', dlg); err.textContent = ex.message; err.hidden = false; }
      });
    },
  });
}

// ===========================================================================
// Eventos
// ===========================================================================
function bindStatic() {
  $('#brand-mark').innerHTML = icon('pr', 15, 2.2);
  $('#btn-prev').innerHTML = icon('chevronLeft', 16);
  $('#btn-next').innerHTML = icon('chevronRight', 16);
  $('#btn-approve').innerHTML = `${statusIcon('approved', 16)}<span>Aprovar</span><kbd>↵</kbd>`;
  $('#btn-reject').innerHTML = `${statusIcon('rejected', 16)}<span>Rejeitar</span><kbd>⇧↵</kbd>`;
  $('#hist-csv').innerHTML = `${icon('download', 15)}Exportar CSV`;
  $('#hist-search').insertAdjacentHTML('afterbegin', icon('search', 15));
  $('#hist-member-wrap').insertAdjacentHTML('beforeend', icon('chevronDown', 14));
  $('#rep-member').parentElement.insertAdjacentHTML('beforeend', icon('chevronDown', 14));
  $('#btn-rep-text').innerHTML = `${icon('copy', 15)}Copiar texto`;
  $('#btn-rep-download').innerHTML = `${icon('download', 15)}Baixar PNG`;
  $('#btn-rep-copy').innerHTML = `${icon('image', 15)}Copiar imagem`;
  $('#btn-present').innerHTML = `${icon('maximize', 15)}Modo print (tela cheia)`;
  $('#btn-add-member').innerHTML = `${icon('plus', 15)}Adicionar`;

  // Registro
  const input = $('#entry-input');
  $('#entry').addEventListener('submit', (e) => { e.preventDefault(); submitEntry('approved'); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); submitEntry('rejected'); }
    if (e.key === 'Escape') { input.value = ''; setHint(''); }
  });
  input.addEventListener('input', () => lookupPr(input.value));

  $('#rec-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.recFilter = b.dataset.filter;
    renderToday();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'pending-input') {
      const v = e.target.value === '' ? null : Math.max(0, Math.min(9999, Math.trunc(Number(e.target.value))));
      e.target.value = v ?? '';
      savePending(state.day, v);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'pending-input') e.target.style.width = `${Math.max(1, e.target.value.length) + 0.6}ch`;
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'pending-input' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  const note = $('#day-note');
  note.addEventListener('input', () => saveNote(state.day, note.value));

  // Histórico
  $('#hist-preset').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    state.hist.preset = b.dataset.preset;
    loadHistory();
  });
  $('#hist-member').addEventListener('change', (e) => { state.hist.member = e.target.value; renderHistory(); });
  $('#hist-q').addEventListener('input', debounce((e) => { state.hist.q = e.target.value; renderHistory(); }, 150));

  // Relatório
  $('#rep-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    setReportRange(b.dataset.preset);
    history.replaceState(null, '', '#relatorio');
    loadReport();
  });
  $('#rep-presets').addEventListener('change', (e) => {
    if (e.target.id !== 'rep-from' && e.target.id !== 'rep-to') return;
    const f = $('#rep-from').value;
    const t = $('#rep-to').value;
    if (!DAY_RE.test(f) || !DAY_RE.test(t)) return;
    setReportRange('custom', f, t);
    history.replaceState(null, '', '#relatorio');
    loadReport();
  });
  $('#rep-member').addEventListener('change', (e) => { state.rep.member = e.target.value; renderReportView(); });
  $('#rep-list').addEventListener('change', (e) => { state.rep.showList = e.target.checked; state.rep.listTouched = true; renderReportView(); });
  $('#rep-chart').addEventListener('change', (e) => { state.rep.showChart = e.target.checked; renderReportView(); });
  $('#rep-theme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    state.rep.theme = b.dataset.theme;
    localStorage.setItem(LS.repTheme, b.dataset.theme);
    renderReportView();
  });

  // Equipe
  $('#team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.updateSettings({ team_name: $('#team-input').value });
      await loadMeta();
      toast('Nome da equipe salvo.', { duration: 2500 });
    } catch (ex) { toast(ex.message, { error: true }); }
  });
  $('#member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputEl = $('#member-input');
    try {
      const { member } = await api.addMember(inputEl.value);
      inputEl.value = '';
      await loadMeta();
      renderTeam();
      toast(`${member.name} entrou na equipe.`, { duration: 2500 });
    } catch (ex) { toast(ex.message, { error: true }); }
  });

  // Ações delegadas
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'edit-review' && e.target.closest('a, button')) return;
    const id = Number(el.dataset.id);
    try {
      switch (a) {
        case 'user-menu': openUserMenu(el); break;
        case 'switch-user': pickUser({ required: !state.me }); break;
        case 'day-prev': setDay(addDays(state.day, -1)); break;
        case 'day-next': setDay(addDays(state.day, 1)); break;
        case 'go-today': setDay(today()); break;
        case 'submit-rejected': submitEntry('rejected'); break;
        case 'edit-review': { const r = reviewById(id); if (r) editReview(r); break; }
        case 'review-menu': { const r = reviewById(id); if (r) openReviewMenu(el, r); break; }
        case 'pending-inc': changePending(1); break;
        case 'pending-dec': changePending(-1); break;
        case 'close-day': await closeDayDialog(); break;
        case 'reopen-day': await reopenDay(); break;
        case 'toggle-day': {
          const d = el.dataset.day;
          if (state.hist.open.has(d)) state.hist.open.delete(d); else state.hist.open.add(d);
          renderHistory();
          break;
        }
        case 'report-copy': await reportCopy(el); break;
        case 'report-download': await withBusy(el, async () => { await downloadImage(reportNode(), reportFilename()); toast('PNG baixado.', { iconHtml: icon('download', 16), duration: 2500 }); }); break;
        case 'report-text':
          if (state.rep.model) {
            await copyText(reportText(state.rep.model, { showList: state.rep.showList }));
            toast('Texto copiado. Pronto para colar no Teams ou WhatsApp.', { iconHtml: icon('check', 16, 2.4) });
          }
          break;
        case 'present': openPresent(); break;
        case 'member-menu': { const m = memberById(id); if (m) openMemberMenu(el, m); break; }
        case 'copy': await copyText(el.dataset.text); toast('Copiado.', { duration: 1800 }); break;
        default: break;
      }
    } catch (ex) { toast(ex.message, { error: true }); }
  });

  // Atalhos globais
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && presentEl) { closePresent(); return; }
    if ($('#dialog').open || menuState) return;
    const t = e.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      if (state.view !== 'hoje') location.hash = '#hoje';
      setTimeout(() => $('#entry-input').focus(), 0);
      return;
    }
    if (state.view !== 'hoje') return;
    if (e.key === '[') setDay(addDays(state.day, -1));
    else if (e.key === ']') setDay(addDays(state.day, 1));
    else if (e.key === 't' || e.key === 'T') setDay(today());
    else if (e.key === 'r' || e.key === 'R') location.hash = `#relatorio/${state.day}`;
  });

  window.addEventListener('hashchange', route);

  // Virada do dia com a aba aberta
  setInterval(() => {
    if (state.view === 'hoje' && !state.dayPinned && state.day !== today()) route();
  }, 60_000);
}

// ===========================================================================
// Código de acesso da equipe
// ===========================================================================
let loginOpen = false;
async function loginDialog() {
  loginOpen = true;
  await dialog({
    required: true,
    html: `<form class="dlg-body" id="login-form" autocomplete="off">
        <div class="brand-mark" style="width:36px;height:36px;border-radius:9px;margin-bottom:18px">${icon('pr', 20, 2.2)}</div>
        <h2 class="dlg-title">Código da equipe</h2>
        <p class="dlg-desc">O PR Review é restrito à equipe. Peça o código para quem administra o sistema.</p>
        <div class="dlg-fields">
          <input class="input mono" id="login-code" type="password" autocomplete="current-password" placeholder="••••••••" aria-label="Código da equipe" autofocus>
        </div>
        <p class="dlg-error" id="login-error" hidden></p>
        <button class="btn primary" type="submit" style="width:100%;margin-top:16px">Entrar</button>
      </form>`,
    mount: (dlg, finish) => {
      const input = $('#login-code', dlg);
      input.focus();
      $('#login-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('#login-error', dlg);
        try {
          await api.login(input.value);
          finish(true);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          input.select();
        }
      });
    },
  });
  loginOpen = false;
}
window.addEventListener('prt:unauthorized', async () => {
  if (loginOpen) return;
  await loginDialog();
  location.reload();
});

// Recupera a pessoa salva neste navegador: pelo id, ou pelo nome (se o banco mudou),
// recriando o cadastro só quando ninguém com esse nome existe.
async function restoreIdentity() {
  const saved = loadIdentity();
  if (!saved) return null;
  const byId = saved.id ? memberById(saved.id) : null;
  if (byId && (!saved.name || byId.name.toLowerCase() === saved.name.toLowerCase() || !state.meta.members.some((m) => m.name.toLowerCase() === saved.name.toLowerCase()))) {
    return byId.active ? byId : null;
  }
  if (!saved.name) return null;
  const byName = state.meta.members.find((m) => m.name.toLowerCase() === saved.name.toLowerCase());
  if (byName) return byName.active ? byName : null;
  try {
    const { member } = await api.addMember(saved.name);
    await loadMeta();
    return memberById(member.id) || null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Início
// ===========================================================================
async function init() {
  applyTheme();
  bindStatic();
  try {
    const auth = await api.auth();
    if (auth.required && !auth.ok) await loginDialog();
    await loadMeta();
  } catch {
    toast('Não foi possível conectar ao servidor. Verifique se ele está rodando.', { error: true, duration: 10_000 });
    return;
  }
  state.me = await restoreIdentity();
  if (state.me) saveIdentity(state.me);
  renderUserBtn();
  connectLive({ mode: state.meta.realtime, onChange: refreshActive, onStatus: setLive });
  await route();
  if (!state.me) pickUser({ required: true });
  document.fonts?.ready.then(moveIndicator);
}

init();
