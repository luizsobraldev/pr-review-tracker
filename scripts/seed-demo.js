// Sobe o servidor com um banco de demonstração (data/demo.db) cheio de dados fictícios.
// Não toca no banco real (data/pr-tracker.db).
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'demo.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });

const db = await openDb({ file, url: '' });
await db.init();

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const names = ['Luiz', 'Lucas', 'Ana Paula', 'Bruno'];
const ids = [];
for (const n of names) {
  const [m] = await db.all('INSERT INTO members (name, created_at) VALUES ($1, $2) RETURNING id', [n, new Date().toISOString()]);
  ids.push(m.id);
}
const weight = [0.36, 0.3, 0.2, 0.14];
const who = () => { let x = rnd(); for (let i = 0; i < ids.length; i++) { x -= weight[i]; if (x <= 0) return ids[i]; } return ids[0]; };

const reasons = [
  'Quebra no fluxo de cadastro de fornecedor',
  'Faltou evidência de teste no card',
  'Erro 500 ao salvar prescrição com item controlado',
  'Regressão na tela de checagem',
  'Mensagem de validação sem tradução',
  'Conflito com a branch de release',
];
const branches = [
  'fix/correcao-SUPRIMENTOS-Processo-Cadastro-de-OC-18',
  'feat/PEP-assinatura-digital-lote',
  'hotfix/faturamento-guia-tiss-v4',
];
const notes = [
  'Ambiente de homologação instável entre 14h e 15h.',
  'Fila alta por causa da release de sexta.',
  'Dois PRs aguardando correção do dev.',
];

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const days = [];
for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); days.length < 23; d.setDate(d.getDate() - 1)) {
  if (d.getDay() !== 0 && d.getDay() !== 6) days.unshift(new Date(d));
}

let prNum = 43420;
const rejectedPool = [];
for (const [idx, d] of days.entries()) {
  const isToday = idx === days.length - 1;
  const count = isToday ? 9 : 5 + Math.floor(rnd() * 10);
  const span = isToday ? Math.max(0.5, now.getHours() + now.getMinutes() / 60 - 8.6) : 9.5;
  const times = Array.from({ length: count }, () => 8.5 + rnd() * span).sort((a, b) => a - b);
  for (const t of times) {
    let pr;
    let status = rnd() < 0.86 ? 'approved' : 'rejected';
    if (rejectedPool.length && rnd() < 0.25) { pr = rejectedPool.shift(); status = 'approved'; }
    else if (rnd() < 0.05) pr = pick(branches);
    else pr = `AUTOTST-${prNum += 1 + Math.floor(rnd() * 3)}`;
    if (isToday) status = rnd() < 0.9 ? 'approved' : 'rejected';
    const note = status === 'rejected' ? pick(reasons) : null;
    if (status === 'rejected') rejectedPool.push(pr);
    const at = new Date(d);
    at.setHours(Math.floor(t), Math.floor((t % 1) * 60), Math.floor(rnd() * 60));
    const link = pr.startsWith('AUTOTST') && rnd() < 0.5 ? `https://jira.exemplo.com.br/browse/${pr}` : null;
    await db.run(
      'INSERT INTO reviews (day, pr, link, status, member_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [dayStr(d), pr, link, status, who(), note, at.toISOString()],
    );
  }
  if (!isToday) {
    const closedAt = new Date(d);
    closedAt.setHours(18, Math.floor(rnd() * 40));
    await db.run('INSERT INTO days (day, pending, note, closed_at, closed_by) VALUES ($1, $2, $3, $4, $5)',
      [dayStr(d), Math.floor(rnd() * 6), rnd() < 0.25 ? pick(notes) : null, closedAt.toISOString(), ids[0]]);
  } else {
    await db.run('INSERT INTO days (day, pending) VALUES ($1, $2)', [dayStr(d), 3]);
  }
}
db.close();
console.log(`\n  Demo: ${days.length} dias úteis de dados fictícios em ${path.relative(root, file)}`);

process.env.DB_FILE = file;
process.env.PORT = process.env.PORT || '3001';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
await import('../server.js');
