'use strict';

/**
 * Live game layer: rooms, players, physics and the authoritative game loop.
 *
 * The server is authoritative for movement, shooting and damage. Clients only
 * send their input state (pressed keys + aim angle + firing flag); the server
 * integrates it every tick and broadcasts a compact snapshot to the room.
 */

const db = require('./db');

// ---- Arena / balance constants ---------------------------------------------

const WORLD = { w: 1600, h: 900 };
const TICK_HZ = 30;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 260; // px/sec
const MAX_HP = 100;
const RESPAWN_MS = 3000;
const POWERUP_RESPAWN_MS = 12000;

const WEAPONS = {
  pistol: { name: 'Pistole', damage: 22, fireRate: 280, speed: 620, pellets: 1, spread: 0, range: 900, auto: false },
  rifle: { name: 'Gewehr', damage: 14, fireRate: 110, speed: 780, pellets: 1, spread: 0.03, range: 1100, auto: true },
  shotgun: { name: 'Schrotflinte', damage: 11, fireRate: 750, speed: 560, pellets: 7, spread: 0.32, range: 520, auto: false }
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ff6ec7', '#00d2ff', '#c0f000'];

// Static obstacles for the default arena (axis-aligned rectangles).
const OBSTACLES = [
  { x: 380, y: 180, w: 180, h: 40 },
  { x: 1040, y: 180, w: 180, h: 40 },
  { x: 720, y: 120, w: 160, h: 160 },
  { x: 200, y: 430, w: 40, h: 200 },
  { x: 1360, y: 430, w: 40, h: 200 },
  { x: 700, y: 620, w: 200, h: 40 },
  { x: 380, y: 680, w: 180, h: 40 },
  { x: 1040, y: 680, w: 180, h: 40 },
  { x: 720, y: 400, w: 160, h: 120 }
];

const POWERUP_SPOTS = [
  { x: 800, y: 90, type: 'health' },
  { x: 130, y: 450, type: 'shotgun' },
  { x: 1470, y: 450, type: 'rifle' },
  { x: 800, y: 810, type: 'health' },
  { x: 300, y: 250, type: 'rifle' },
  { x: 1300, y: 650, type: 'shotgun' }
];

let io = null;
const rooms = new Map();       // roomId -> live room
const socketToRoom = new Map(); // socketId -> roomId

function init(ioInstance) {
  io = ioInstance;
}

// ---- Helpers ----------------------------------------------------------------

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function circleRectCollide(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

function spawnPoint() {
  for (let i = 0; i < 40; i++) {
    const x = rand(60, WORLD.w - 60);
    const y = rand(60, WORLD.h - 60);
    if (!OBSTACLES.some((o) => circleRectCollide(x, y, PLAYER_RADIUS + 6, o))) {
      return { x, y };
    }
  }
  return { x: WORLD.w / 2, y: WORLD.h / 2 };
}

// ---- Room lifecycle ---------------------------------------------------------

function createRoom({ owner, name, visibility, maxPlayers }) {
  const id = db.nextRoomId();
  const room = {
    id,
    name: String(name || `Raum ${id}`).slice(0, 30),
    visibility: visibility === 'private' ? 'private' : 'public',
    ownerId: owner.id,
    ownerName: owner.username,
    moderators: new Set(),
    invited: new Set(),
    banned: new Set(),
    maxPlayers: Math.min(Math.max(parseInt(maxPlayers, 10) || 8, 2), 16),
    joinCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
    players: new Map(),   // socketId -> player
    bullets: [],
    powerups: POWERUP_SPOTS.map((s, i) => ({ id: i, x: s.x, y: s.y, type: s.type, active: true, respawnAt: 0 })),
    createdAt: Date.now(),
    loop: null,
    lastTick: Date.now()
  };
  rooms.set(id, room);
  startLoop(room);
  broadcastRoomList();
  return room;
}

function destroyRoom(room) {
  if (!room) return;
  if (room.loop) clearInterval(room.loop);
  for (const [sid] of room.players) {
    socketToRoom.delete(sid);
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.leave('room:' + room.id);
      s.emit('room:closed', { roomId: room.id });
    }
  }
  rooms.delete(room.id);
  broadcastRoomList();
}

function canManage(room, userId) {
  const user = db.findUserById(userId);
  if (user && user.role === 'admin') return true;
  return room.ownerId === userId || room.moderators.has(userId);
}

function canJoin(room, user) {
  if (room.banned.has(user.id)) return { ok: false, reason: 'Du wurdest aus diesem Raum verbannt.' };
  if (room.players.size >= room.maxPlayers) return { ok: false, reason: 'Der Raum ist voll.' };
  if (room.visibility === 'public') return { ok: true };
  // private room: owner, mods, invited or admins may join
  if (user.role === 'admin') return { ok: true };
  if (room.ownerId === user.id) return { ok: true };
  if (room.moderators.has(user.id)) return { ok: true };
  if (room.invited.has(user.id)) return { ok: true };
  return { ok: false, reason: 'Dieser Raum ist einladungspflichtig.' };
}

// ---- Player lifecycle -------------------------------------------------------

function addPlayer(room, socket, user) {
  const sp = spawnPoint();
  const color = COLORS[room.players.size % COLORS.length];
  const player = {
    sid: socket.id,
    userId: user.id,
    username: user.username,
    color,
    x: sp.x,
    y: sp.y,
    angle: 0,
    hp: MAX_HP,
    weapon: 'pistol',
    kills: 0,
    deaths: 0,
    alive: true,
    respawnAt: 0,
    lastShot: 0,
    input: { up: false, down: false, left: false, right: false, fire: false, angle: 0 }
  };
  room.players.set(socket.id, player);
  socketToRoom.set(socket.id, room.id);
  socket.join('room:' + room.id);
  broadcastRoomList();
  return player;
}

function removePlayer(socket) {
  const roomId = socketToRoom.get(socket.id);
  if (roomId == null) return;
  const room = rooms.get(roomId);
  socketToRoom.delete(socket.id);
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave('room:' + room.id);
  if (player) {
    io.to('room:' + room.id).emit('chat:msg', { system: true, text: `${player.username} hat den Raum verlassen.` });
  }
  // Owner left and room is empty -> close it. Otherwise keep it alive.
  if (room.players.size === 0) {
    destroyRoom(room);
  } else {
    io.to('room:' + room.id).emit('room:state:meta', roomMeta(room));
    broadcastRoomList();
  }
}

// ---- Combat -----------------------------------------------------------------

function fire(room, player, now) {
  if (!player.alive) return;
  const w = WEAPONS[player.weapon];
  if (now - player.lastShot < w.fireRate) return;
  player.lastShot = now;
  for (let i = 0; i < w.pellets; i++) {
    const spread = (Math.random() - 0.5) * w.spread * 2;
    const a = player.input.angle + spread;
    room.bullets.push({
      x: player.x + Math.cos(a) * (PLAYER_RADIUS + 4),
      y: player.y + Math.sin(a) * (PLAYER_RADIUS + 4),
      vx: Math.cos(a) * w.speed,
      vy: Math.sin(a) * w.speed,
      dmg: w.damage,
      owner: player.sid,
      ownerName: player.username,
      dist: 0,
      range: w.range
    });
  }
  io.to('room:' + room.id).emit('sfx', { type: 'shot', weapon: player.weapon, x: player.x, y: player.y });
}

function killPlayer(room, victim, killerName, killerSid) {
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = Date.now() + RESPAWN_MS;
  victim.hp = 0;
  const killer = killerSid ? room.players.get(killerSid) : null;
  if (killer && killer.sid !== victim.sid) {
    killer.kills++;
    const ku = db.findUserById(killer.userId);
    if (ku) { ku.stats.kills = (ku.stats.kills || 0) + 1; db.save(); }
  }
  const vu = db.findUserById(victim.userId);
  if (vu) { vu.stats.deaths = (vu.stats.deaths || 0) + 1; db.save(); }
  io.to('room:' + room.id).emit('chat:msg', {
    system: true,
    text: `${killerName || 'Die Welt'} hat ${victim.username} ausgeschaltet.`
  });
}

// ---- Main tick --------------------------------------------------------------

function startLoop(room) {
  const dt = 1 / TICK_HZ;
  room.loop = setInterval(() => tick(room, dt), 1000 / TICK_HZ);
}

function tick(room, dt) {
  const now = Date.now();

  // Players
  for (const player of room.players.values()) {
    if (!player.alive) {
      if (now >= player.respawnAt) {
        const sp = spawnPoint();
        player.x = sp.x;
        player.y = sp.y;
        player.hp = MAX_HP;
        player.alive = true;
        player.weapon = 'pistol';
      }
      continue;
    }
    player.angle = player.input.angle;
    let dx = 0;
    let dy = 0;
    if (player.input.up) dy -= 1;
    if (player.input.down) dy += 1;
    if (player.input.left) dx -= 1;
    if (player.input.right) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      const nx = player.x + dx * PLAYER_SPEED * dt;
      const ny = player.y + dy * PLAYER_SPEED * dt;
      // Axis-separated movement so players slide along walls.
      if (!collidesWorld(nx, player.y)) player.x = nx;
      if (!collidesWorld(player.x, ny)) player.y = ny;
    }
    if (player.input.fire) fire(room, player, now);

    // Powerup pickups
    for (const p of room.powerups) {
      if (!p.active) continue;
      if (Math.hypot(player.x - p.x, player.y - p.y) < PLAYER_RADIUS + 14) {
        applyPowerup(player, p);
        p.active = false;
        p.respawnAt = now + POWERUP_RESPAWN_MS;
        io.to('room:' + room.id).emit('sfx', { type: 'pickup', x: p.x, y: p.y });
      }
    }
  }

  // Powerup respawn
  for (const p of room.powerups) {
    if (!p.active && now >= p.respawnAt) p.active = true;
  }

  // Bullets
  const alive = [];
  for (const b of room.bullets) {
    const nx = b.x + b.vx * dt;
    const ny = b.y + b.vy * dt;
    b.dist += Math.hypot(nx - b.x, ny - b.y);
    b.x = nx;
    b.y = ny;
    if (b.x < 0 || b.y < 0 || b.x > WORLD.w || b.y > WORLD.h || b.dist > b.range) continue;
    if (OBSTACLES.some((o) => pointInRect(b.x, b.y, o))) continue;
    let hit = false;
    for (const player of room.players.values()) {
      if (!player.alive || player.sid === b.owner) continue;
      if (Math.hypot(player.x - b.x, player.y - b.y) < PLAYER_RADIUS) {
        player.hp -= b.dmg;
        hit = true;
        if (player.hp <= 0) killPlayer(room, player, b.ownerName, b.owner);
        break;
      }
    }
    if (!hit) alive.push(b);
  }
  room.bullets = alive;

  broadcastState(room);
}

function collidesWorld(x, y) {
  if (x < PLAYER_RADIUS || y < PLAYER_RADIUS || x > WORLD.w - PLAYER_RADIUS || y > WORLD.h - PLAYER_RADIUS) {
    return true;
  }
  return OBSTACLES.some((o) => circleRectCollide(x, y, PLAYER_RADIUS, o));
}

function applyPowerup(player, p) {
  if (p.type === 'health') {
    player.hp = Math.min(MAX_HP, player.hp + 50);
  } else if (p.type === 'shotgun' || p.type === 'rifle') {
    player.weapon = p.type;
  }
}

// ---- Snapshots --------------------------------------------------------------

function broadcastState(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.sid,
      name: p.username,
      color: p.color,
      x: Math.round(p.x),
      y: Math.round(p.y),
      angle: +p.angle.toFixed(2),
      hp: Math.max(0, Math.round(p.hp)),
      weapon: p.weapon,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths
    });
  }
  const bullets = room.bullets.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) }));
  const powerups = room.powerups.filter((p) => p.active).map((p) => ({ x: p.x, y: p.y, type: p.type }));
  io.to('room:' + room.id).emit('state', { players, bullets, powerups, world: WORLD });
}

function roomMeta(room) {
  return {
    id: room.id,
    name: room.name,
    visibility: room.visibility,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    moderators: [...room.moderators],
    invited: [...room.invited],
    joinCode: room.joinCode,
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map((p) => ({ userId: p.userId, name: p.username, sid: p.sid }))
  };
}

function publicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.visibility !== 'public') continue;
    list.push({
      id: room.id,
      name: room.name,
      ownerName: room.ownerName,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      visibility: room.visibility
    });
  }
  return list;
}

/** Admins get every room, including private ones. */
function adminRoomList() {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    name: room.name,
    ownerName: room.ownerName,
    players: room.players.size,
    maxPlayers: room.maxPlayers,
    visibility: room.visibility,
    joinCode: room.joinCode
  }));
}

function broadcastRoomList() {
  if (!io) return;
  io.to('lobby').emit('lobby:rooms', publicRoomList());
  io.to('admins').emit('admin:rooms', adminRoomList());
}

function getRoom(id) {
  return rooms.get(Number(id));
}

module.exports = {
  init,
  createRoom,
  destroyRoom,
  getRoom,
  addPlayer,
  removePlayer,
  canManage,
  canJoin,
  roomMeta,
  publicRoomList,
  adminRoomList,
  broadcastRoomList,
  socketToRoom,
  rooms,
  WEAPONS,
  WORLD
};
