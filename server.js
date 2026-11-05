// PR Review Tracker — servidor local (Node puro). Usa SQLite por padrão ou Postgres se DATABASE_URL existir.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { createApp } from './lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'pr-tracker.db'));

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}`);
    }
  }
  return urls;
}

const db = await openDb({ file: DB_FILE });
await db.init();
const app = createApp({ db, realtime: 'sse', publicDir: path.join(__dirname, 'public'), lanUrls });
const server = http.createServer((req, res) => app.handle(req, res));

server.listen(PORT, HOST, () => {
  console.log('\n  PR Review Tracker rodando\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Equipe:  ${u}`);
  console.log(`  Banco:   ${db.label}`);
  if (process.env.TEAM_CODE) console.log('  Acesso:  protegido por código da equipe (TEAM_CODE)');
  console.log('');
});

function shutdown() {
  app.closeClients();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
