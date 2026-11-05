// API do PR Review Tracker — compartilhada entre o servidor local (server.js) e a função da Vercel (api/index.js).
import crypto from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDay(d, label = 'Data') {
  const t = typeof d === 'string' && DAY_RE.test(d) ? Date.parse(d) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) throw bad(`${label} inválida.`);
  return d;
}
function cleanText(v, max, label) {
  if (v == null) return null;
  if (typeof v !== 'string') throw bad(`${label} inválido.`);
  const s = v.trim();
  if (s.length > max) throw bad(`${label} muito longo (máx. ${max}).`);
  return s || null;
}
function cleanLink(v) {
  const s = cleanText(v, 1000, 'Link');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) throw bad('Link deve começar com http:// ou https://');
  return s;
}
function cleanPending(v) {
  if (v === null || v === '' || v === undefined) return null;
  const p = Number(v);
  if (!Number.isInteger(p) || p < 0 || p > 9999) throw bad('Pendentes deve ser um número inteiro ≥ 0.');
  return p;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function readBody(req) {
  // Na Vercel o corpo já vem lido em req.body; no Node puro lemos o stream.
  if (req.body !== undefined) {
    if (req.body === null || req.body === '') return {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new HttpError(413, 'Requisição muito grande.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Código de acesso da equipe (ativo quando TEAM_CODE está definido)
// ---------------------------------------------------------------------------
function createAuth(teamCode, secret) {
  const code = (teamCode || '').trim();
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const token = code ? crypto.createHmac('sha256', secret || code).update(`prt:${code}`).digest('base64url') : '';
  const cookieOf = (req) => {
    const m = /(?:^|;\s*)prt_auth=([^;]+)/.exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  };
  return {
    required: Boolean(code),
    ok: (req) => !code || crypto.timingSafeEqual(digest(cookieOf(req)), digest(token)),
    check: (attempt) => Boolean(code) && crypto.timingSafeEqual(digest(String(attempt || '').trim()), digest(code)),
    cookie: (req, clear = false) => {
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
      return `prt_auth=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 60 * 60 * 24 * 180}${secure ? '; Secure' : ''}`;
    },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {object} o.db           banco aberto por lib/db.js (já inicializado)
 * @param {'sse'|'poll'} o.realtime  'sse' no servidor local, 'poll' na Vercel
 * @param {string} [o.publicDir]  serve arquivos estáticos (só no servidor local)
 * @param {() => string[]} [o.lanUrls]  endereços da rede local para mostrar na aba Equipe
 */
export function createApp({ db, realtime = 'sse', publicDir = null, lanUrls = () => [] }) {
  const auth = createAuth(process.env.TEAM_CODE, process.env.AUTH_SECRET);
  const clients = new Set();

  // --- consultas -----------------------------------------------------------
  const Q = {
    members: `SELECT m.id, m.name, m.active, m.created_at,
                     (SELECT CAST(COUNT(*) AS INTEGER) FROM reviews r WHERE r.member_id = m.id) AS total
                FROM members m ORDER BY m.active DESC, lower(m.name)`,
    member: `SELECT id, name, active, created_at FROM members WHERE id = $1`,
    memberByName: `SELECT id, name, active FROM members WHERE lower(name) = lower(CAST($1 AS TEXT))`,
    settings: `SELECT key, value FROM settings WHERE key NOT IN ('schema_version', 'rev')`,
    setSetting: `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    reviewsInRange: `SELECT r.*,
                            (SELECT CAST(COUNT(*) AS INTEGER) FROM reviews p
                              WHERE lower(p.pr) = lower(r.pr)
                                AND (p.day < r.day OR (p.day = r.day AND p.id < r.id))) AS attempt
                       FROM reviews r
                      WHERE r.day BETWEEN $1 AND $2
                      ORDER BY r.day DESC, r.created_at DESC, r.id DESC`,
    daysInRange: `SELECT * FROM days WHERE day BETWEEN $1 AND $2 ORDER BY day DESC`,
    review: `SELECT * FROM reviews WHERE id = $1`,
    lookup: `SELECT r.id, r.day, r.pr, r.status, r.note, r.created_at, m.name AS member_name
               FROM reviews r JOIN members m ON m.id = r.member_id
              WHERE lower(r.pr) = lower(CAST($1 AS TEXT))
              ORDER BY r.day DESC, r.id DESC LIMIT 5`,
    day: `SELECT * FROM days WHERE day = $1`,
  };

  const getMember = async (id) => {
    const m = Number.isInteger(Number(id)) ? await db.get(Q.member, [Number(id)]) : null;
    if (!m) throw bad('Responsável não encontrado.');
    return m;
  };
  const assertOpenDay = async (day) => {
    const d = await db.get(Q.day, [day]);
    if (d?.closed_at) throw new HttpError(409, 'Este dia está fechado. Reabra o dia para alterar registros.');
  };
  const settingsObject = async () => Object.fromEntries((await db.all(Q.settings)).map((r) => [r.key, r.value]));

  async function upsertDay(day, fields) {
    const cols = Object.keys(fields);
    const params = [day, ...cols.map((c) => fields[c])];
    const sql = cols.length
      ? `INSERT INTO days (day, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (day) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')} RETURNING *`
      : `INSERT INTO days (day) VALUES ($1) ON CONFLICT (day) DO UPDATE SET day = excluded.day RETURNING *`;
    return (await db.all(sql, params))[0];
  }

  async function notify(scope, extra = {}) {
    const at = now();
    await db.run(Q.setSetting, ['rev', `${at}#${Math.random().toString(36).slice(2, 8)}`]);
    const msg = `event: change\ndata: ${JSON.stringify({ scope, at, ...extra })}\n\n`;
    for (const res of clients) res.write(msg);
  }

  if (realtime === 'sse') {
    setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000).unref();
  }

  // --- rotas ---------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: Boolean(opts.public) });
  };

  route('GET', '/api/auth', (req) => ({ required: auth.required, ok: auth.ok(req) }), { public: true });

  route('POST', '/api/login', async (req, _p, _q, body, res) => {
    if (!auth.required) return { ok: true };
    if (!auth.check(body.code)) {
      await new Promise((r) => setTimeout(r, 600));
      throw new HttpError(401, 'Código incorreto.');
    }
    res.setHeader('Set-Cookie', auth.cookie(req));
    return { ok: true };
  }, { public: true });

  route('POST', '/api/logout', (req, _p, _q, _b, res) => {
    res.setHeader('Set-Cookie', auth.cookie(req, true));
    return { ok: true };
  }, { public: true });

  route('GET', '/api/meta', async () => ({
    members: await db.all(Q.members),
    settings: await settingsObject(),
    urls: lanUrls(),
    storage: db.kind,
    db_file: db.label,
    realtime,
    auth_required: auth.required,
    server_time: now(),
  }));

  route('GET', '/api/version', async () => ({ rev: (await db.get(`SELECT value FROM settings WHERE key = 'rev'`))?.value || '0' }));

  route('GET', '/api/data', async (_req, _p, query) => {
    const from = assertDay(query.get('from') || '1970-01-01', 'Data inicial');
    const to = assertDay(query.get('to') || '2999-12-31', 'Data final');
    const [reviews, days] = await Promise.all([db.all(Q.reviewsInRange, [from, to]), db.all(Q.daysInRange, [from, to])]);
    return { reviews, days };
  });

  route('GET', '/api/lookup', async (_req, _p, query) => {
    const pr = (query.get('pr') || '').trim();
    return { results: pr ? await db.all(Q.lookup, [pr]) : [] };
  });

  route('POST', '/api/reviews', async (_req, _p, _q, body) => {
    const day = assertDay(body.day);
    const { status } = body;
    if (status !== 'approved' && status !== 'rejected') throw bad('Status inválido.');
    const member = await getMember(body.member_id);
    const note = cleanText(body.note, 1000, 'Observação');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('Informe ao menos um PR.');
    if (items.length > 100) throw bad('Máximo de 100 PRs por vez.');
    await assertOpenDay(day);

    const rows = items.map((it) => {
      const pr = cleanText(it?.pr, 200, 'Identificador do PR');
      if (!pr) throw bad('Identificador do PR vazio.');
      return [day, pr, cleanLink(it?.link), status, member.id, note, now()];
    });
    // Um único INSERT com várias linhas: atômico nos dois motores.
    const values = rows.map((_, i) => `(${Array.from({ length: 7 }, (__, j) => `$${i * 7 + j + 1}`).join(', ')})`).join(', ');
    const created = await db.all(
      `INSERT INTO reviews (day, pr, link, status, member_id, note, created_at) VALUES ${values} RETURNING *`,
      rows.flat(),
    );
    await notify('reviews', { day });
    return { created };
  });

  route('PATCH', '/api/reviews/:id', async (_req, { id }, _q, body) => {
    const r = await db.get(Q.review, [Number(id)]);
    if (!r) throw new HttpError(404, 'Registro não encontrado.');
    await assertOpenDay(r.day);

    const next = { ...r };
    if ('pr' in body) {
      next.pr = cleanText(body.pr, 200, 'Identificador do PR');
      if (!next.pr) throw bad('Identificador do PR vazio.');
    }
    if ('link' in body) next.link = cleanLink(body.link);
    if ('note' in body) next.note = cleanText(body.note, 1000, 'Observação');
    if ('status' in body) {
      if (body.status !== 'approved' && body.status !== 'rejected') throw bad('Status inválido.');
      next.status = body.status;
    }
    if ('member_id' in body) next.member_id = (await getMember(body.member_id)).id;
    if ('day' in body) {
      next.day = assertDay(body.day);
      if (next.day !== r.day) await assertOpenDay(next.day);
    }
    const [review] = await db.all(
      `UPDATE reviews SET day = $1, pr = $2, link = $3, status = $4, member_id = $5, note = $6, updated_at = $7 WHERE id = $8 RETURNING *`,
      [next.day, next.pr, next.link, next.status, next.member_id, next.note, now(), r.id],
    );
    await notify('reviews', { day: next.day });
    return { review };
  });

  route('DELETE', '/api/reviews/:id', async (_req, { id }) => {
    const r = await db.get(Q.review, [Number(id)]);
    if (!r) throw new HttpError(404, 'Registro não encontrado.');
    await assertOpenDay(r.day);
    await db.run(`DELETE FROM reviews WHERE id = $1`, [r.id]);
    await notify('reviews', { day: r.day });
    return { ok: true };
  });

  route('PUT', '/api/days/:day', async (_req, { day }, _q, body) => {
    assertDay(day);
    await assertOpenDay(day);
    const fields = {};
    if ('pending' in body) fields.pending = cleanPending(body.pending);
    if ('note' in body) fields.note = cleanText(body.note, 2000, 'Observação');
    const row = await upsertDay(day, fields);
    await notify('days', { day });
    return { day: row };
  });

  route('POST', '/api/days/:day/close', async (_req, { day }, _q, body) => {
    assertDay(day);
    const member = await getMember(body.member_id);
    const fields = { pending: cleanPending(body.pending), closed_at: now(), closed_by: member.id };
    if ('note' in body) fields.note = cleanText(body.note, 2000, 'Observação');
    const row = await upsertDay(day, fields);
    await notify('days', { day });
    return { day: row };
  });

  route('POST', '/api/days/:day/reopen', async (_req, { day }) => {
    assertDay(day);
    const row = await upsertDay(day, { closed_at: null, closed_by: null });
    await notify('days', { day });
    return { day: row };
  });

  route('POST', '/api/members', async (_req, _p, _q, body) => {
    const name = cleanText(body.name, 40, 'Nome');
    if (!name) throw bad('Informe um nome.');
    const existing = await db.get(Q.memberByName, [name]);
    if (existing) {
      if (existing.active) throw new HttpError(409, 'Já existe alguém com esse nome na equipe.');
      await db.run(`UPDATE members SET active = 1 WHERE id = $1`, [existing.id]);
      await notify('members');
      return { member: await db.get(Q.member, [existing.id]) };
    }
    const [member] = await db.all(`INSERT INTO members (name, created_at) VALUES ($1, $2) RETURNING id, name, active, created_at`, [name, now()]);
    await notify('members');
    return { member };
  });

  route('PATCH', '/api/members/:id', async (_req, { id }, _q, body) => {
    const m = await getMember(id);
    if ('name' in body) {
      const name = cleanText(body.name, 40, 'Nome');
      if (!name) throw bad('Informe um nome.');
      const dup = await db.get(Q.memberByName, [name]);
      if (dup && dup.id !== m.id) throw new HttpError(409, 'Já existe alguém com esse nome na equipe.');
      await db.run(`UPDATE members SET name = $1 WHERE id = $2`, [name, m.id]);
    }
    if ('active' in body) await db.run(`UPDATE members SET active = $1 WHERE id = $2`, [body.active ? 1 : 0, m.id]);
    await notify('members');
    return { member: await db.get(Q.member, [m.id]) };
  });

  route('PUT', '/api/settings', async (_req, _p, _q, body) => {
    if ('team_name' in body) {
      const v = cleanText(body.team_name, 60, 'Nome da equipe');
      if (!v) throw bad('Informe o nome da equipe.');
      await db.run(Q.setSetting, ['team_name', v]);
    }
    await notify('settings');
    return { settings: await settingsObject() };
  });

  route('GET', '/api/export.csv', async (_req, _p, query, _b, res) => {
    const from = assertDay(query.get('from') || '1970-01-01', 'Data inicial');
    const to = assertDay(query.get('to') || '2999-12-31', 'Data final');
    const rows = await db.all(`
      SELECT r.day, r.pr, r.link, r.status, m.name AS member, r.note, r.created_at
        FROM reviews r JOIN members m ON m.id = r.member_id
       WHERE r.day BETWEEN $1 AND $2
       ORDER BY r.day, r.created_at`, [from, to]);
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtDay = (d) => d.split('-').reverse().join('/');
    const fmtTs = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: process.env.TZ_DISPLAY || 'America/Sao_Paulo' });
    const lines = [
      ['Data', 'PR', 'Status', 'Responsável', 'Observação', 'Link', 'Registrado em'].join(';'),
      ...rows.map((r) => [
        fmtDay(r.day), r.pr, r.status === 'approved' ? 'Aprovado' : 'Rejeitado', r.member, r.note, r.link, fmtTs(r.created_at),
      ].map(cell).join(';')),
    ];
    const name = from === '1970-01-01' ? 'prs-completo' : `prs-${from}_a_${to}`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end('﻿' + lines.join('\r\n'));
    return undefined;
  });

  if (realtime === 'sse') {
    route('GET', '/api/events', (req, _p, _q, _b, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ at: now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    });
  }

  // --- estáticos (servidor local) -----------------------------------------
  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Caminho inválido'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, 'Proibido');
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Não encontrado');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  // --- despachante --------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      if (!publicDir) return send(res, 404, { error: 'Não encontrado.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
      return serveStatic(req, res, pathname);
    }

    const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!match) return send(res, 404, { error: 'Rota não encontrada.' });
    if (!match.public && !auth.ok(req)) {
      return send(res, 401, { error: 'Acesso restrito. Informe o código da equipe.', auth: true });
    }

    try {
      const values = pathname.match(match.re).slice(1).map(decodeURIComponent);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, values[i]]));
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        try { body = await readBody(req); } catch (e) { throw e instanceof HttpError ? e : bad('JSON inválido.'); }
        if (!body || typeof body !== 'object') body = {};
      }
      const result = await match.handler(req, params, url.searchParams, body, res);
      if (result !== undefined) send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro interno no servidor.' : err.message, ...(err.extra || {}) });
    }
  }

  function closeClients() { for (const res of clients) res.end(); }

  return { handle, closeClients };
}
