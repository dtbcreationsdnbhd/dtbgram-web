/* eslint-disable no-console */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.ARCHIVE_PORT) || 8724;
const DB_DIR = join(import.meta.dirname, '..', '.archive');
const DB_PATH = join(DB_DIR, 'internal-messages.sqlite');

mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    date INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    json TEXT NOT NULL,
    archived_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (chat_id, message_id, date, sender_id, json, archived_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (chat_id, message_id) DO UPDATE SET json = excluded.json
`);

const selectMessagesByChat = db.prepare(
  'SELECT json FROM messages WHERE chat_id = ? ORDER BY message_id',
);

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && pathname === '/messages') {
    handleSaveMessage(req, res).catch((err) => {
      console.error('Failed to save message', err);
      respondJson(res, 500, { error: 'Internal error' });
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/messages') {
    const chatId = searchParams.get('chatId');
    if (!chatId) {
      respondJson(res, 400, { error: 'Missing `chatId` query parameter' });
      return;
    }

    const messages = selectMessagesByChat.all(chatId).map(({ json }) => JSON.parse(json));
    respondJson(res, 200, { messages });
    return;
  }

  respondJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Internal archive server is listening on http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});

async function handleSaveMessage(req, res) {
  const body = await readBody(req);

  let message;
  try {
    message = JSON.parse(body).message;
  } catch (err) {
    respondJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!message || typeof message.chatId !== 'string' || typeof message.id !== 'number') {
    respondJson(res, 400, { error: 'Expected `message` with `chatId` and `id`' });
    return;
  }

  insertMessage.run(
    message.chatId,
    message.id,
    message.date || 0,
    message.senderId || '',
    JSON.stringify(message),
    Date.now(),
  );

  respondJson(res, 200, { ok: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function respondJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
