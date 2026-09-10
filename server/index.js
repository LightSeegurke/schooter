'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const auth = require('./auth');
const game = require('./game');

db.load();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
game.init(io);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- REST API ---------------------------------------------------------------

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const result = await auth.register(username, password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ token: result.token, user: db.publicUser(result.user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const result = await auth.login(username, password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ token: result.token, user: db.publicUser(result.user) });
});

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: db.publicUser(req.user) });
});

// ---- Admin API --------------------------------------------------------------

app.get('/api/admin/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ users: db.getUsers().map(db.publicUser) });
});

app.get('/api/admin/stats', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    users: db.getUsers().length,
    admins: db.getUsers().filter((u) => u.role === 'admin').length,
    banned: db.getUsers().filter((u) => u.banned).length,
    rooms: game.rooms.size,
    players: [...game.rooms.values()].reduce((n, r) => n + r.players.size, 0),
    uptime: Math.round(process.uptime())
  });
});

app.post('/api/admin/users/:id/ban', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = db.findUserById(id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Admins können nicht gesperrt werden.' });
  const banned = !!(req.body && req.body.banned);
  db.updateUser(id, { banned });
  res.json({ user: db.publicUser(target) });
});

app.post('/api/admin/users/:id/role', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = db.findUserById(id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
  const role = (req.body && req.body.role) === 'admin' ? 'admin' : 'user';
  db.updateUser(id, { role });
  res.json({ user: db.publicUser(target) });
});

app.post('/api/admin/rooms/:id/close', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const room = game.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Raum nicht gefunden.' });
  game.destroyRoom(room);
  res.json({ ok: true });
});

app.get('/api/leaderboard', auth.requireAuth, (req, res) => {
  const top = db.getUsers()
    .filter((u) => !u.banned)
    .map(db.publicUser)
    .sort((a, b) => (b.stats.kills - a.stats.kills) || (b.stats.wins - a.stats.wins))
    .slice(0, 15);
  res.json({ leaderboard: top });
});

app.get('/api/config', (req, res) => {
  res.json({ maps: game.MAPS, weapons: game.WEAPONS, weaponOrder: game.WEAPON_ORDER });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Socket.IO --------------------------------------------------------------

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const payload = token ? auth.verifyToken(token) : null;
  if (!payload) return next(new Error('unauthorized'));
  const user = db.findUserById(payload.uid);
  if (!user) return next(new Error('unauthorized'));
  if (user.banned) return next(new Error('banned'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join('lobby');
  if (user.role === 'admin') socket.join('admins');

  socket.emit('lobby:rooms', game.publicRoomList());
  if (user.role === 'admin') socket.emit('admin:rooms', game.adminRoomList());

  // --- Lobby / room management ---

  socket.on('lobby:list', () => {
    socket.emit('lobby:rooms', game.publicRoomList());
  });

  socket.on('room:create', (data, cb) => {
    const room = game.createRoom({
      owner: user,
      name: data && data.name,
      visibility: data && data.visibility,
      maxPlayers: data && data.maxPlayers,
      mode: data && data.mode,
      mapId: data && data.mapId,
      killLimit: data && data.killLimit
    });
    joinRoom(socket, room, cb);
  });

  socket.on('room:join', (data, cb) => {
    let room = null;
    if (data && data.roomId != null) room = game.getRoom(data.roomId);
    if (!room && data && data.code) {
      room = [...game.rooms.values()].find((r) => r.joinCode === String(data.code).toUpperCase());
    }
    if (!room) return cb && cb({ error: 'Raum nicht gefunden.' });
    const check = game.canJoin(room, user);
    if (!check.ok) return cb && cb({ error: check.reason });
    joinRoom(socket, room, cb);
  });

  socket.on('room:leave', () => {
    game.removePlayer(socket);
    socket.join('lobby');
    if (user.role === 'admin') socket.join('admins');
    socket.emit('lobby:rooms', game.publicRoomList());
  });

  // --- In-game input ---

  socket.on('input', (input) => {
    const roomId = game.socketToRoom.get(socket.id);
    if (roomId == null) return;
    const room = game.getRoom(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !input) return;
    player.input.up = !!input.up;
    player.input.down = !!input.down;
    player.input.left = !!input.left;
    player.input.right = !!input.right;
    player.input.fire = !!input.fire;
    if (typeof input.angle === 'number') player.input.angle = input.angle;
  });

  // Discrete in-game actions (weapon switch / reload / grenade / dash).
  socket.on('act', (data) => {
    const roomId = game.socketToRoom.get(socket.id);
    if (roomId == null) return;
    const room = game.getRoom(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive || !data) return;
    if (data.a === 'switch' && game.WEAPON_ORDER.includes(data.w)) {
      player.weapon = data.w;
      player.reloadUntil = 0;
    } else if (data.a === 'reload') {
      game.startReload(player);
    } else if (data.a === 'grenade') {
      game.throwGrenade(room, player);
    } else if (data.a === 'dash') {
      game.dash(room, player);
    }
  });

  socket.on('room:addBot', (data, cb) => withManagedRoom(socket, cb, (room) => {
    if ([...room.players.values()].length >= 16) return cb && cb({ error: 'Raum ist voll (max. 16).' });
    game.addBot(room);
    cb && cb({ ok: true });
  }));

  socket.on('room:removeBot', (data, cb) => withManagedRoom(socket, cb, (room) => {
    if (!game.removeBot(room)) return cb && cb({ error: 'Keine Bots im Raum.' });
    cb && cb({ ok: true });
  }));

  socket.on('chat:send', (msg) => {
    const roomId = game.socketToRoom.get(socket.id);
    if (roomId == null) return;
    const text = String((msg && msg.text) || '').slice(0, 200).trim();
    if (!text) return;
    io.to('room:' + roomId).emit('chat:msg', { name: user.username, text });
  });

  // --- Owner / moderator actions ---

  socket.on('room:invite', (data, cb) => withManagedRoom(socket, cb, (room) => {
    const target = db.findUserByName(data && data.username);
    if (!target) return cb && cb({ error: 'Benutzer nicht gefunden.' });
    room.invited.add(target.id);
    emitMeta(room);
    cb && cb({ ok: true, message: `${target.username} eingeladen.` });
  }));

  socket.on('room:kick', (data, cb) => withManagedRoom(socket, cb, (room) => {
    const targetSid = data && data.sid;
    const target = room.players.get(targetSid);
    if (!target) return cb && cb({ error: 'Spieler nicht im Raum.' });
    if (target.userId === room.ownerId) return cb && cb({ error: 'Der Eigentümer kann nicht gekickt werden.' });
    const s = io.sockets.sockets.get(targetSid);
    if (s) {
      game.removePlayer(s);
      s.emit('room:kicked', { roomId: room.id });
    }
    cb && cb({ ok: true });
  }));

  socket.on('room:ban', (data, cb) => withManagedRoom(socket, cb, (room) => {
    const target = room.players.get(data && data.sid);
    if (!target) return cb && cb({ error: 'Spieler nicht im Raum.' });
    if (target.userId === room.ownerId) return cb && cb({ error: 'Der Eigentümer kann nicht verbannt werden.' });
    room.banned.add(target.userId);
    room.invited.delete(target.userId);
    const s = io.sockets.sockets.get(target.sid);
    if (s) { game.removePlayer(s); s.emit('room:kicked', { roomId: room.id, banned: true }); }
    emitMeta(room);
    cb && cb({ ok: true });
  }));

  socket.on('room:setModerator', (data, cb) => withManagedRoom(socket, cb, (room) => {
    // Only the owner (or admin) may change moderators, not other mods.
    if (room.ownerId !== user.id && user.role !== 'admin') {
      return cb && cb({ error: 'Nur der Eigentümer kann Moderatoren verwalten.' });
    }
    const target = db.findUserByName(data && data.username);
    if (!target) return cb && cb({ error: 'Benutzer nicht gefunden.' });
    if (target.id === room.ownerId) return cb && cb({ error: 'Der Eigentümer ist bereits Verwalter.' });
    if (data.enabled) room.moderators.add(target.id);
    else room.moderators.delete(target.id);
    room.invited.add(target.id);
    emitMeta(room);
    cb && cb({ ok: true });
  }));

  socket.on('room:update', (data, cb) => withManagedRoom(socket, cb, (room) => {
    if (data && typeof data.name === 'string' && data.name.trim()) {
      room.name = data.name.trim().slice(0, 30);
      room.ownerName = room.ownerName; // unchanged
    }
    if (data && (data.visibility === 'public' || data.visibility === 'private')) {
      room.visibility = data.visibility;
    }
    emitMeta(room);
    game.broadcastRoomList();
    cb && cb({ ok: true });
  }));

  socket.on('room:close', (data, cb) => withManagedRoom(socket, cb, (room) => {
    if (room.ownerId !== user.id && user.role !== 'admin') {
      return cb && cb({ error: 'Nur der Eigentümer kann den Raum schließen.' });
    }
    game.destroyRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('disconnect', () => {
    game.removePlayer(socket);
  });

  function joinRoom(sock, room, cb) {
    game.removePlayer(sock); // ensure not in another room
    sock.leave('lobby');
    game.addPlayer(room, sock, user);
    io.to('room:' + room.id).emit('chat:msg', { system: true, text: `${user.username} ist beigetreten.` });
    emitMeta(room);
    cb && cb({
      ok: true,
      roomId: room.id,
      meta: game.roomMeta(room),
      you: { userId: user.id, role: user.role },
      weapons: game.WEAPONS,
      weaponOrder: game.WEAPON_ORDER,
      world: game.WORLD,
      obstacles: room.obstacles,
      mode: room.mode
    });
  }
});

function emitMeta(room) {
  const meta = game.roomMeta(room);
  io.to('room:' + room.id).emit('room:state:meta', meta);
}

function withManagedRoom(socket, cb, fn) {
  const roomId = game.socketToRoom.get(socket.id);
  const room = roomId != null ? game.getRoom(roomId) : null;
  if (!room) return cb && cb({ error: 'Nicht in einem Raum.' });
  if (!game.canManage(room, socket.user.id)) return cb && cb({ error: 'Keine Berechtigung.' });
  fn(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🔫  Schooter läuft auf http://localhost:${PORT}\n`);
});
