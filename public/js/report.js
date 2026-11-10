// Relatório para a gestão: modelo, HTML (pronto para print/PNG), texto e gráfico de colunas.
import {
  esc, icon, statusIcon, avatar, summarize, fmtPct, plural,
  fmtLong, fmtRange, fmtShort, fmtFull, fmtTime, fmtWeekday,
  eachDay, isWeekend, diffDays, startOfWeek, startOfMonth, endOfMonth, addDays,
} from './utils.js';

// ---------------------------------------------------------------------------
// Gráfico de colunas empilhadas (aprovados embaixo, rejeitados em cima)
// ---------------------------------------------------------------------------
function niceCeil(n) {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const v = m * pow;
    if (v >= n && Number.isInteger(v / 2)) return v;
  }
  return Math.ceil(n / pow) * pow;
}

export function bucketize(reviews, from, to) {
  const span = diffDays(from, to) + 1;
  const weekly = span > 45;
  const map = new Map();
  for (const r of reviews) {
    const key = weekly ? startOfWeek(r.day) : r.day;
    const b = map.get(key) || { approved: 0, rejected: 0 };
    b[r.status]++;
    map.set(key, b);
  }
  const keys = [];
  if (weekly) {
    for (let d = startOfWeek(from); d <= to; d = addDays(d, 7)) keys.push(d);
  } else {
    for (const d of eachDay(from, to)) if (!isWeekend(d) || map.has(d)) keys.push(d);
  }
  return keys.map((k) => {
    const b = map.get(k) || { approved: 0, rejected: 0 };
    return {
      key: k,
      label: weekly ? 'Sem' : fmtWeekday(k),
      sub: fmtShort(k),
      title: weekly ? `Semana de ${fmtShort(k)}` : fmtLong(k),
      ...b,
    };
  });
}

export function columnChart(buckets, { height = 140 } = {}) {
  if (!buckets.length) return '';
  const max = Math.max(0, ...buckets.map((b) => b.approved + b.rejected));
  const top = niceCeil(max);
  const ticks = [top, top / 2, 0];
  const showCaps = buckets.length <= 16;
  const every = buckets.length <= 16 ? 1 : Math.ceil(buckets.length / 12);
  const h = (v) => (v ? Math.max(2, (v / top) * height) : 0);

  const cols = buckets.map((b, i) => {
    const total = b.approved + b.rejected;
    const tip = `${b.title}|${b.approved}|${b.rejected}`;
    return `<div class="rc-col" data-chart-tip="${esc(tip)}">
      <div class="rc-stack">
        ${showCaps && total ? `<span class="rc-cap">${total}</span>` : ''}
        ${b.rejected ? `<i class="rc-seg no" style="height:${h(b.rejected)}px"></i>` : ''}
        ${b.approved ? `<i class="rc-seg ok" style="height:${h(b.approved)}px"></i>` : ''}
      </div>
      <div class="rc-x">${i % every === 0 ? `<span>${esc(b.label)}</span><span>${esc(b.sub)}</span>` : ''}</div>
    </div>`;
  }).join('');

  return `<div class="rc" style="--rc-h:${height}px">
    <div class="rc-y">${ticks.map((t) => `<span style="bottom:${(t / top) * 100}%">${t}</span>`).join('')}</div>
    <div class="rc-plot">
      ${ticks.map((t) => `<i class="rc-grid${t === 0 ? ' base' : ''}" style="bottom:${(t / top) * 100}%"></i>`).join('')}
      <div class="rc-cols">${cols}</div>
    </div>
  </div>`;
}

export const chartLegend = () => `<div class="rc-legend">
  <span><i class="dot ok"></i>Aprovados</span><span><i class="dot no"></i>Rejeitados</span>
</div>`;

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------
function kindOf(from, to) {
  if (from === to) return 'Relatório diário';
  if (from === startOfMonth(from) && to === endOfMonth(from)) return 'Relatório mensal';
  if (from === startOfWeek(from) && diffDays(from, to) <= 6) return 'Relatório semanal';
  return 'Relatório do período';
}

export function buildReportModel({ from, to, memberId, data, meta, me }) {
  const members = new Map(meta.members.map((m) => [m.id, m]));
  const memberFilter = memberId ? members.get(memberId) || null : null;
  const reviews = data.reviews
    .filter((r) => r.day >= from && r.day <= to && (!memberFilter || r.member_id === memberFilter.id))
    .sort((a, b) => (a.day === b.day ? a.created_at.localeCompare(b.created_at) : a.day.localeCompare(b.day)));
  const days = data.days.filter((d) => d.day >= from && d.day <= to);
  const summary = summarize(reviews);

  const pendingDay = [...days].sort((a, b) => b.day.localeCompare(a.day)).find((d) => d.pending != null);
  const byMember = [...summary.byMember.entries()]
    .map(([id, s]) => ({ member: members.get(id) || { id, name: '—' }, ...s }))
    .sort((a, b) => b.total - a.total || a.member.name.localeCompare(b.member.name));
  const notes = days.filter((d) => d.note).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ day: d.day, note: d.note }));

  const single = from === to;
  const dayInfo = single ? days.find((d) => d.day === from) : null;

  return {
    from, to, single,
    kind: kindOf(from, to),
    title: single ? fmtLong(from) : fmtRange(from, to),
    teamName: meta.settings.team_name || 'Equipe QA',
    memberFilter,
    reviews,
    summary,
    pending: pendingDay ? { value: pendingDay.pending, day: pendingDay.day } : null,
    byMember,
    buckets: single ? [] : bucketize(reviews, from, to),
    notes,
    closed: dayInfo?.closed_at ? { at: dayInfo.closed_at, by: members.get(dayInfo.closed_by)?.name } : null,
    activeDays: new Set(reviews.map((r) => r.day)).size,
    members,
    generatedAt: new Date(),
    generatedBy: me?.name || null,
  };
}

// ---------------------------------------------------------------------------
// HTML do relatório (estilizado por /css/report.css — também embutido no PNG)
// ---------------------------------------------------------------------------
const MAX_LIST = 120;

function prItem(r, m, withDay) {
  const member = m.members.get(r.member_id);
  return `<li class="rpt-pr">
    ${statusIcon(r.status, 16)}
    <span class="rpt-pr-id">${esc(r.pr)}</span>${r.author ? `<span class="rpt-pr-author">- ${esc(r.author)}</span>` : ''}
    ${r.attempt > 0 ? `<span class="rpt-tag">${r.attempt + 1}ª análise</span>` : ''}
    <span class="rpt-pr-meta">${m.memberFilter ? '' : `${avatar(member, 14)}<span>${esc(member?.name || '—')}</span>`}${withDay ? `<span class="rpt-mono">${fmtShort(r.day)}</span>` : ''}</span>
  </li>`;
}

export function renderReport(m, opts = {}) {
  const { theme = 'dark', showList = true, showChart = true } = opts;
  const s = m.summary;
  const people = m.byMember.length;

  const subParts = [plural(s.total, 'PR revisado', 'PRs revisados')];
  if (!m.memberFilter) subParts.push(plural(people, 'pessoa', 'pessoas'));
  if (!m.single) subParts.push(plural(m.activeDays, 'dia com revisões', 'dias com revisões'));
  if (m.closed) subParts.push(`dia fechado às ${fmtTime(m.closed.at)}`);

  const pendingLabel = m.pending && !m.single ? `<span class="rpt-kpi-note">em ${fmtShort(m.pending.day)}</span>` : '';

  const kpis = `<section class="rpt-kpis">
    <div class="rpt-kpi"><span class="rpt-lbl">Revisados</span><span class="rpt-val">${s.total}</span></div>
    <div class="rpt-kpi"><span class="rpt-lbl"><i class="dot ok"></i>Aprovados</span><span class="rpt-val">${s.approved}</span></div>
    <div class="rpt-kpi"><span class="rpt-lbl"><i class="dot no"></i>Rejeitados</span><span class="rpt-val">${s.rejected}</span></div>
    <div class="rpt-kpi"><span class="rpt-lbl"><i class="dot pend"></i>Pendentes</span><span class="rpt-val">${m.pending ? m.pending.value : '—'}</span>${pendingLabel}</div>
  </section>
  <div class="rpt-meter">
    <div class="rpt-meter-head"><span>Taxa de aprovação</span><span class="rpt-meter-val">${fmtPct(s.rate)}</span></div>
    <div class="rpt-track"><div class="rpt-fill" style="width:${s.rate ?? 0}%"></div></div>
  </div>`;

  const chart = !m.single && showChart && m.buckets.length > 1 ? `<section class="rpt-sec">
    <div class="rpt-sec-head"><h2>${m.buckets[0]?.label === 'Sem' ? 'Por semana' : 'Por dia'}</h2>${chartLegend()}</div>
    ${columnChart(m.buckets, { height: 132 })}
  </section>` : '';

  const maxTotal = Math.max(1, ...m.byMember.map((b) => b.total));
  const team = !m.memberFilter && people ? `<section class="rpt-sec">
    <div class="rpt-sec-head"><h2>Por responsável</h2></div>
    <table class="rpt-table">
      <thead><tr><th>Analista</th><th class="num">Aprovados</th><th class="num">Rejeitados</th><th class="num">Total</th><th class="bar-col"></th></tr></thead>
      <tbody>${m.byMember.map((b) => `<tr>
        <td><span class="rpt-person">${avatar(b.member, 20)}${esc(b.member.name)}</span></td>
        <td class="num">${b.approved}</td>
        <td class="num">${b.rejected}</td>
        <td class="num strong">${b.total}</td>
        <td class="bar-col"><div class="rpt-share" style="width:${(b.total / maxTotal) * 100}%">${b.approved ? `<i class="ok" style="flex:${b.approved}"></i>` : ''}${b.rejected ? `<i class="no" style="flex:${b.rejected}"></i>` : ''}</div></td>
      </tr>`).join('')}</tbody>
    </table>
  </section>` : '';

  let list = '';
  if (showList && s.total) {
    const items = m.reviews.slice(0, MAX_LIST);
    const rest = m.reviews.length - items.length;
    let body;
    if (m.single) {
      body = `<ul class="rpt-prs">${items.map((r) => prItem(r, m, false)).join('')}</ul>`;
    } else {
      const groups = new Map();
      for (const r of items) (groups.get(r.day) || groups.set(r.day, []).get(r.day)).push(r);
      body = [...groups.entries()].map(([day, rs]) => `<div class="rpt-group">
        <div class="rpt-group-head"><span>${fmtWeekday(day)}, ${fmtShort(day)}</span><span class="rpt-mono">${rs.length}</span></div>
        <ul class="rpt-prs">${rs.map((r) => prItem(r, m, false)).join('')}</ul>
      </div>`).join('');
    }
    list = `<section class="rpt-sec">
      <div class="rpt-sec-head"><h2>PRs revisados <span class="rpt-count">${s.total}</span></h2></div>
      ${body}
      ${rest > 0 ? `<p class="rpt-more">+ ${rest} outros registros não exibidos</p>` : ''}
    </section>`;
  }

  const rejected = m.reviews.filter((r) => r.status === 'rejected');
  const showRejections = rejected.length && (!showList || rejected.some((r) => r.note));
  const rejections = showRejections ? `<section class="rpt-sec">
    <div class="rpt-sec-head"><h2>Rejeições <span class="rpt-count">${rejected.length}</span></h2></div>
    <ul class="rpt-rejections">${rejected.map((r) => `<li>
      ${statusIcon('rejected', 16)}
      <div><div class="rpt-rej-top"><span class="rpt-pr-id">${esc(r.pr)}</span>${r.author ? `<span class="rpt-pr-author">- ${esc(r.author)}</span>` : ''}<span class="rpt-pr-meta">${esc(m.members.get(r.member_id)?.name || '—')}${m.single ? '' : ` · <span class="rpt-mono">${fmtShort(r.day)}</span>`}</span></div>
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}</div>
    </li>`).join('')}</ul>
  </section>` : '';

  const notes = m.notes.length ? `<section class="rpt-sec">
    <div class="rpt-sec-head"><h2>Observações</h2></div>
    <div class="rpt-notes">${m.notes.map((n) => `<p>${m.single ? '' : `<span class="rpt-mono">${fmtShort(n.day)}</span> `}${esc(n.note)}</p>`).join('')}</div>
  </section>` : '';

  const empty = !s.total ? `<section class="rpt-sec"><p class="rpt-empty">Nenhum PR registrado neste período.</p></section>` : '';

  const g = m.generatedAt;
  const gen = `Gerado em ${fmtFull(`${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`)} às ${fmtTime(g.toISOString())}${m.generatedBy ? ` por ${esc(m.generatedBy)}` : ''}`;

  return `<div class="rpt" data-theme="${theme}"><div class="rpt-frame">
    <i class="rpt-cross tl"></i><i class="rpt-cross tr"></i><i class="rpt-cross bl"></i><i class="rpt-cross br"></i>
    <header class="rpt-head">
      <div class="rpt-brand">${icon('pr', 16)}<span>PR Review</span><span class="rpt-slash">/</span><span class="rpt-team">${esc(m.teamName)}</span>${m.memberFilter ? `<span class="rpt-slash">/</span><span class="rpt-team">${esc(m.memberFilter.name)}</span>` : ''}</div>
      <div class="rpt-kind">${m.kind}</div>
    </header>
    <div class="rpt-hero">
      <h1 class="rpt-title">${esc(m.title)}</h1>
      <p class="rpt-sub">${subParts.join(' · ')}</p>
    </div>
    ${kpis}
    ${chart}
    ${team}
    ${list}
    ${rejections}
    ${notes}
    ${empty}
    <footer class="rpt-foot"><span>${gen}</span><span class="rpt-mono">PR Review Tracker</span></footer>
  </div></div>`;
}

// ---------------------------------------------------------------------------
// Versão texto (para colar no Teams / WhatsApp / e-mail)
// ---------------------------------------------------------------------------
export function reportText(m, { showList = true } = {}) {
  const s = m.summary;
  const L = [];
  L.push(`*Revisão de PRs — ${m.teamName}${m.memberFilter ? ` — ${m.memberFilter.name}` : ''}*`);
  L.push(m.title);
  L.push('');
  L.push(`✅ Aprovados: ${s.approved}`);
  L.push(`❌ Rejeitados: ${s.rejected}`);
  L.push(`⏳ Pendentes: ${m.pending ? m.pending.value + (m.single ? '' : ` (em ${fmtShort(m.pending.day)})`) : '—'}`);
  L.push(`📊 Taxa de aprovação: ${fmtPct(s.rate)} (${plural(s.total, 'revisado', 'revisados')})`);

  if (!m.memberFilter && m.byMember.length) {
    L.push('', '*Por responsável*');
    for (const b of m.byMember) L.push(`• ${b.member.name}: ${b.total} (✅ ${b.approved} · ❌ ${b.rejected})`);
  }

  if (!m.single && m.buckets.length > 1) {
    L.push('', `*${m.buckets[0].label === 'Sem' ? 'Por semana' : 'Por dia'}*`);
    for (const b of m.buckets) {
      if (!b.approved && !b.rejected) continue;
      L.push(`• ${b.label === 'Sem' ? b.title : `${b.label} ${b.sub}`}: ✅ ${b.approved} · ❌ ${b.rejected}`);
    }
  }

  if (showList && s.total) {
    L.push('', '*PRs revisados*');
    let lastDay = null;
    for (const r of m.reviews) {
      if (!m.single && r.day !== lastDay) { L.push(`_${fmtWeekday(r.day)}, ${fmtShort(r.day)}_`); lastDay = r.day; }
      const who = m.memberFilter ? '' : ` — ${m.members.get(r.member_id)?.name || '—'}`;
      const why = r.status === 'rejected' && r.note ? ` (${r.note})` : '';
      L.push(`${r.status === 'approved' ? '✅' : '❌'} ${r.pr}${r.author ? ` - ${r.author}` : ''}${who}${why}`);
    }
  } else {
    const rej = m.reviews.filter((r) => r.status === 'rejected');
    if (rej.length) {
      L.push('', '*Rejeições*');
      for (const r of rej) L.push(`❌ ${r.pr}${r.author ? ` - ${r.author}` : ''} — ${m.members.get(r.member_id)?.name || '—'}${r.note ? ` (${r.note})` : ''}`);
    }
  }

  if (m.notes.length) {
    L.push('', '*Observações*');
    for (const n of m.notes) L.push(m.single ? n.note : `${fmtShort(n.day)}: ${n.note}`);
  }
  return L.join('\n');
}

