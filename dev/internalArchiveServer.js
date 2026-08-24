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
    code TEXT,
    json TEXT NOT NULL,
    archived_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )
`);

// Add `code` to databases created before the column existed
const hasCodeColumn = db.prepare('PRAGMA table_info(messages)').all()
  .some((column) => column.name === 'code');
if (!hasCodeColumn) {
  db.exec('ALTER TABLE messages ADD COLUMN code TEXT');
}

const insertMessage = db.prepare(`
  INSERT INTO messages (chat_id, message_id, date, sender_id, code, json, archived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (chat_id, message_id) DO UPDATE SET json = excluded.json, code = excluded.code
`);

const selectMessagesByChat = db.prepare(
  'SELECT code, json FROM messages WHERE chat_id = ? ORDER BY message_id',
);

// Regexes ordered from most specific to most general
const CODE_PATTERNS = [
  /This is your login code:\s*\n?\s*([A-Za-z0-9_-]{5,})/,
  /Login code:\s*([A-Za-z0-9_-]{5,})/,
];

function extractCode(message) {
  const text = message?.content?.text?.text;
  if (typeof text !== 'string') return undefined;

  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return undefined;
}

function backfillCodes() {
  const rows = db.prepare('SELECT chat_id, message_id, json FROM messages WHERE code IS NULL').all();
  if (!rows.length) return;

  const update = db.prepare('UPDATE messages SET code = ? WHERE chat_id = ? AND message_id = ?');
  for (const row of rows) {
    let code;
    try {
      code = extractCode(JSON.parse(row.json));
    } catch (err) {
      code = undefined;
    }
    if (code) {
      update.run(code, row.chat_id, row.message_id);
    }
  }
}

backfillCodes();

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

    const messages = selectMessagesByChat.all(chatId).map(({ code, json }) => ({
      ...JSON.parse(json),
      code: code || undefined,
    }));
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
    extractCode(message) || null,
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
