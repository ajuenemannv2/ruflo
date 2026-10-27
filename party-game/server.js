import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Room } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
// Speeds up every timer, e.g. TIME_SCALE=0.1 for testing.
const TIME_SCALE = Number(process.env.TIME_SCALE) || 1;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ROOM_IDLE_MS = 30 * 60 * 1000;

const PAGES = { '/': 'play.html', '/play': 'play.html', '/host': 'host.html' };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const roomClients = new Map();

// No vowels, so codes can't spell anything rude.
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ';
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = newCode();
  const room = new Room(code, { onChange: () => sync(code), timeScale: TIME_SCALE });
  rooms.set(code, room);
  roomClients.set(code, new Set());
  return room;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sync(code) {
  const room = rooms.get(code);
  if (!room) return;
  const host = room.hostView();
  for (const ws of roomClients.get(code) ?? []) {
    send(ws, { t: 'state', state: ws.role === 'host' ? host : room.playerView(ws.playerId) });
  }
}

function attach(ws, room, role, playerId = null) {
  detach(ws);
  ws.code = room.code;
  ws.role = role;
  ws.playerId = playerId;
  roomClients.get(room.code).add(ws);
}

function detach(ws) {
  if (!ws.code) return;
  const room = rooms.get(ws.code);
  roomClients.get(ws.code)?.delete(ws);
  // Only mark offline if this was the player's last open socket (they may have a second tab).
  if (room && ws.role === 'player') {
    const stillHere = [...roomClients.get(ws.code)].some((c) => c.playerId === ws.playerId);
    if (!stillHere) room.disconnect(ws.playerId);
  }
  ws.code = null;
}

function handle(ws, msg) {
  const room = ws.code ? rooms.get(ws.code) : null;
  const isHost = ws.role === 'host';
  const isPlayer = ws.role === 'player' && room?.players.has(ws.playerId);

  switch (msg.t) {
    case 'host:create': {
      const r = createRoom();
      attach(ws, r, 'host');
      send(ws, { t: 'host:ok', code: r.code });
      sync(r.code);
      return;
    }
    case 'host:join': {
      const r = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!r) return send(ws, { t: 'error', message: 'Room not found', fatal: true });
      attach(ws, r, 'host');
      send(ws, { t: 'host:ok', code: r.code });
      sync(r.code);
      return;
    }
    case 'join': {
      const r = rooms.get(String(msg.code ?? '').trim().toUpperCase());
      if (!r) return send(ws, { t: 'error', message: 'No room with that code', fatal: true });
      const { player, error } = r.join(msg.name, msg.playerId);
      if (error) return send(ws, { t: 'error', message: error, fatal: true });
      attach(ws, r, 'player', player.id);
      send(ws, { t: 'joined', playerId: player.id, code: r.code, name: player.name });
      sync(r.code);
      return;
    }
  }

  if (!room) return;
  room.touch();

  switch (msg.t) {
    case 'start':
      if (isHost || (isPlayer && room.vip === ws.playerId)) room.start();
      return;
    case 'again':
      if (isHost || (isPlayer && room.vip === ws.playerId)) room.playAgain();
      return;
    case 'skip':
      if (isHost) room.skip();
      return;
    case 'kick':
      if (isHost) room.kick(msg.playerId);
      return;
    case 'answer':
      if (isPlayer) room.submitAnswer(ws.playerId, msg.matchupId, msg.text);
      return;
    case 'safety':
      if (isPlayer) send(ws, { t: 'safety', text: room.safetyQuip() });
      return;
    case 'vote':
      if (isPlayer) room.vote(ws.playerId, msg.matchupId, msg.choice);
      return;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/qr.svg') {
    const text = url.searchParams.get('text') ?? '';
    if (!text || text.length > 300) {
      res.writeHead(400).end();
      return;
    }
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': TYPES['.svg'], 'Cache-Control': 'no-store' }).end(svg);
    return;
  }

  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ lanUrls: lanUrls() }));
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  const rel = PAGES[url.pathname] ?? url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function lanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

const server = http.createServer((req, res) => {
  serveStatic(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') handle(ws, msg);
  });
  ws.on('close', () => detach(ws));
});

// Heartbeat keeps connections alive through tunnels/proxies and reaps dead phones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (roomClients.get(code).size === 0 && now - room.lastActivity > ROOM_IDLE_MS) {
      room.destroy();
      rooms.delete(code);
      roomClients.delete(code);
    }
  }
}, 60_000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(reaper);
});

server.listen(PORT, () => {
  console.log(`\n  Quip Clash is running!`);
  console.log(`  Host screen:  http://localhost:${PORT}/host`);
  for (const url of lanUrls()) console.log(`  Players join: ${url}`);
  console.log('');
});
