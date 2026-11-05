// Função serverless da Vercel: todas as rotas /api/* caem aqui (ver vercel.json).
// Na Vercel o banco é Postgres (Neon) via DATABASE_URL e a sincronização é por polling.
import { openDb } from '../lib/db.js';
import { createApp } from '../lib/app.js';

let appPromise = null;

async function boot() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    const err = new Error('Banco não configurado: conecte um Postgres (Neon) ao projeto na Vercel para criar DATABASE_URL.');
    err.status = 503;
    throw err;
  }
  const db = await openDb();
  await db.init();
  return createApp({ db, realtime: 'poll' });
}

export default async function handler(req, res) {
  try {
    appPromise ||= boot();
    const app = await appPromise;
    await app.handle(req, res);
  } catch (err) {
    appPromise = null;
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: err.status ? err.message : 'Erro ao iniciar o servidor.' }));
    }
  }
}
