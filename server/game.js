'use strict';

/**
 * Live game layer: rooms, players, bots, weapons, projectiles, powerups,
 * game modes, the match/round system and the authoritative game loop.
 *
 * The server is authoritative for everything that affects the outcome. Clients
 * send their input state (movement + aim + fire) plus discrete actions (weapon
 * switch, reload, grenade, dash); the server integrates it and broadcasts a
 * compact snapshot to the room 30 times per second.
 */

const db = require('./db');
const maps = require('./maps');

const WORLD = maps.WORLD;
const TICK_HZ = 30;
const PLAYER_RADIUS = 18;
const BASE_SPEED = 255;         // px/sec
const MAX_HP = 100;
const RESPAWN_MS = 3000;
const POWERUP_RESPAWN_MS = 12000;
const DASH_SPEED = 720;
const DASH_MS = 160;
const DASH_COOLDOWN = 2200;
const GRENADE_FUSE = 1200;
const GRENADE_RADIUS = 145;
const GRENADE_DMG = 95;
const START_GRENADES = 3;

// Slots 1..7 map to these weapon keys (client mirrors this order).
const WEAPON_ORDER = ['knife', 'pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'rocket'];

const WEAPONS = {
  knife:   { name: 'Messer',        melee: true, damage: 55, fireRate: 420, range: 46, mag: 0, reserve: 0, reload: 0 },
  pistol:  { name: 'Pistole',       damage: 24, fireRate: 280, speed: 640, pellets: 1, spread: 0.02, range: 950,  auto: false, mag: 12, reserve: Infinity, reload: 900 },
  smg:     { name: 'MP',            damage: 12, fireRate: 75,  speed: 720, pellets: 1, spread: 0.09, range: 760,  auto: true,  mag: 30, reserve: 150, reload: 1400 },
  rifle:   { name: 'Gewehr',        damage: 20, fireRate: 128, speed: 820, pellets: 1, spread: 0.04, range: 1150, auto: true,  mag: 25, reserve: 125, reload: 1800 },
  shotgun: { name: 'Schrotflinte',  damage: 9,  fireRate: 720, speed: 600, pellets: 8, spread: 0.34, range: 560,  auto: false, mag: 6,  reserve: 36,  reload: 2100 },
  sniper:  { name: 'Scharfschütze', damage: 88, fireRate: 1200, speed: 1300, pellets: 1, spread: 0,   range: 2200, auto: false, mag: 5,  reserve: 25,  reload: 2400 },
  rocket:  { name: 'Raketen',       damage: 70, fireRate: 1050, speed: 520, pellets: 1, spread: 0,    range: 1600, auto: false, mag: 3,  reserve: 12,  reload: 2600, projectile: 'rocket', splash: 130, splashDmg: 80 }
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ff6ec7', '#00d2ff', '#c0f000', '#ff9ff3', '#54a0ff'];
const BOT_NAMES = ['Rex', 'Vex', 'Nova', 'Zap', 'Bolt', 'Ghost', 'Fang', 'Pixel', 'Blitz', 'Havoc', 'Talon', 'Drone'];

let io = null;
const rooms = new Map();
const socketToRoom = new Map();
let botCounter = 1;

function init(ioInstance) { io = ioInstance; }

// ---- Helpers ----------------------------------------------------------------

function rand(min, max) { return min + Math.random() * (max - min); }
function now() { return Date.now(); }

function circleRectCollide(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/** Sampled line-of-sight check: true if no obstacle blocks a->b. */
function hasLineOfSight(room, ax, ay, bx, by) {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.ceil(dist / 18);
  for (let i = 1; i < steps; i++) {
    const x = ax + (bx - ax) * (i / steps);
    const y = ay + (by - ay) * (i / steps);
    if (room.obstacles.some((o) => pointInRect(x, y, o))) return false;
  }
  return true;
}

function freshInventory() {
  const ammo = {};
  for (const key of WEAPON_ORDER) {
    const w = WEAPONS[key];
    ammo[key] = { mag: w.mag, reserve: w.reserve === Infinity ? Infinity : w.reserve };
  }
  return ammo;
}

// ---- Room lifecycle ---------------------------------------------------------

function createRoom({ owner, name, visibility, maxPlayers, mode, mapId, killLimit }) {
  const id = db.nextRoomId();
  const chosenMap = mapId && maps.MAPS[mapId] ? mapId : maps.randomMapId();
  const room = {
    id,
    name: String(name || `Raum ${id}`).slice(0, 30),
    visibility: visibility === 'private' ? 'private' : 'public',
    mode: mode === 'tdm' ? 'tdm' : 'ffa',
    mapId: chosenMap,
    ownerId: owner.id,
    ownerName: owner.username,
    moderators: new Set(),
    invited: new Set(),
    banned: new Set(),
    maxPlayers: Math.min(Math.max(parseInt(maxPlayers, 10) || 8, 2), 16),
    joinCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
    players: new Map(),
    bullets: [],
    grenades: [],
    powerups: [],
    events: [],           // transient events for the next snapshot (hits, explosions, kills)
    createdAt: now(),
    loop: null,
    match: null
  };
  loadMap(room);
  startMatch(room, killLimit);
  rooms.set(id, room);
  startLoop(room);
  broadcastRoomList();
  return room;
}

function loadMap(room) {
  const m = maps.getMap(room.mapId);
  room.obstacles = m.obstacles;
  room.powerups = m.powerups.map((s, i) => ({ id: i, x: s.x, y: s.y, type: s.type, active: true, respawnAt: 0 }));
  room.redSpawn = m.redSpawn;
  room.blueSpawn = m.blueSpawn;
}

function startMatch(room, killLimit) {
  const limit = Math.min(Math.max(parseInt(killLimit, 10) || 25, 5), 200);
  room.match = {
    state: 'playing',
    killLimit: limit,
    timeLimit: 5 * 60 * 1000,
    startedAt: now(),
    scores: { red: 0, blue: 0 },
    winner: null,
    resetAt: 0
  };
  for (const p of room.players.values()) {
    p.kills = 0; p.deaths = 0; p.streak = 0;
    respawn(room, p, true);
  }
}

function endMatch(room, winner) {
  const m = room.match;
  m.state = 'ended';
  m.winner = winner;
  m.resetAt = now() + 8000;
  // Award persistent wins/xp.
  if (room.mode === 'tdm') {
    for (const p of room.players.values()) {
      if (p.isBot) continue;
      if (p.team === winner) awardWin(p);
    }
  } else if (winner && winner.sid) {
    const wp = room.players.get(winner.sid);
    if (wp && !wp.isBot) awardWin(wp);
  }
  room.events.push({ t: 'matchEnd' });
  io.to('room:' + room.id).emit('match:end', matchResult(room));
}

function awardWin(player) {
  const u = db.findUserById(player.userId);
  if (u) { u.stats.wins = (u.stats.wins || 0) + 1; u.stats.xp = (u.stats.xp || 0) + 50; db.save(); }
}

function destroyRoom(room) {
  if (!room) return;
  if (room.loop) clearInterval(room.loop);
  for (const [sid, p] of room.players) {
    if (p.isBot) continue;
    socketToRoom.delete(sid);
    const s = io.sockets.sockets.get(sid);
    if (s) { s.leave('room:' + room.id); s.emit('room:closed', { roomId: room.id }); }
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
  if ([...room.players.values()].filter((p) => !p.isBot).length >= room.maxPlayers) {
    return { ok: false, reason: 'Der Raum ist voll.' };
  }
  if (room.visibility === 'public') return { ok: true };
  if (user.role === 'admin' || room.ownerId === user.id) return { ok: true };
  if (room.moderators.has(user.id) || room.invited.has(user.id)) return { ok: true };
  return { ok: false, reason: 'Dieser Raum ist einladungspflichtig.' };
}

// ---- Spawning / players -----------------------------------------------------

function teamSpawn(room, team) {
  const base = team === 'red' ? room.redSpawn : team === 'blue' ? room.blueSpawn : null;
  for (let i = 0; i < 40; i++) {
    const x = base ? base.x + rand(-90, 90) : rand(60, WORLD.w - 60);
    const y = base ? base.y + rand(-140, 140) : rand(60, WORLD.h - 60);
    const cx = Math.max(60, Math.min(WORLD.w - 60, x));
    const cy = Math.max(60, Math.min(WORLD.h - 60, y));
    if (!room.obstacles.some((o) => circleRectCollide(cx, cy, PLAYER_RADIUS + 8, o))) return { x: cx, y: cy };
  }
  return { x: WORLD.w / 2, y: WORLD.h / 2 };
}

function pickTeam(room) {
  let red = 0, blue = 0;
  for (const p of room.players.values()) { if (p.team === 'red') red++; else if (p.team === 'blue') blue++; }
  return red <= blue ? 'red' : 'blue';
}

function respawn(room, player, full) {
  const sp = teamSpawn(room, room.mode === 'tdm' ? player.team : null);
  player.x = sp.x; player.y = sp.y;
  player.hp = MAX_HP;
  player.shield = 0;
  player.alive = true;
  player.weapon = player.isBot && player.preferredWeapon ? player.preferredWeapon : 'pistol';
  player.reloadUntil = 0;
  player.dashUntil = 0;
  player.dashCdUntil = 0;
  player.buffs = { damage: 0, speed: 0 };
  if (full) {
    player.ammo = freshInventory();
    player.grenades = START_GRENADES;
  }
}

function addPlayer(room, socket, user) {
  const team = room.mode === 'tdm' ? pickTeam(room) : null;
  const color = team === 'red' ? '#e74c3c' : team === 'blue' ? '#4ea1ff' : COLORS[room.players.size % COLORS.length];
  const player = basePlayer({ sid: socket.id, userId: user.id, username: user.username, color, team });
  room.players.set(socket.id, player);
  respawn(room, player, true);
  socketToRoom.set(socket.id, room.id);
  socket.join('room:' + room.id);
  broadcastRoomList();
  return player;
}

function basePlayer({ sid, userId, username, color, team, isBot }) {
  return {
    sid, userId, username, color, team: team || null, isBot: !!isBot,
    x: WORLD.w / 2, y: WORLD.h / 2, angle: 0, hp: MAX_HP, shield: 0,
    weapon: 'pistol', alive: true, kills: 0, deaths: 0, streak: 0,
    lastShot: 0, reloadUntil: 0, dashUntil: 0, dashCdUntil: 0, dashDir: { x: 0, y: 0 },
    ammo: freshInventory(), grenades: START_GRENADES,
    buffs: { damage: 0, speed: 0 },
    input: { up: false, down: false, left: false, right: false, fire: false, angle: 0 },
    bot: isBot ? { target: null, wander: 0, nextGrenade: now() + rand(4000, 9000) } : null
  };
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
  if (player) sysMsg(room, `${player.username} hat den Raum verlassen.`);
  const humans = [...room.players.values()].filter((p) => !p.isBot).length;
  if (humans === 0) destroyRoom(room);
  else { emitMetaFor(room); broadcastRoomList(); }
}

// ---- Bots -------------------------------------------------------------------

function addBot(room) {
  const bots = [...room.players.values()].filter((p) => p.isBot).length;
  const name = '🤖 ' + BOT_NAMES[bots % BOT_NAMES.length] + (bots >= BOT_NAMES.length ? bots : '');
  const sid = 'bot_' + (botCounter++);
  const team = room.mode === 'tdm' ? pickTeam(room) : null;
  const color = team === 'red' ? '#e74c3c' : team === 'blue' ? '#4ea1ff' : COLORS[(room.players.size + 3) % COLORS.length];
  const bot = basePlayer({ sid, userId: -1, username: name, color, team, isBot: true });
  bot.preferredWeapon = Math.random() < 0.5 ? 'rifle' : 'smg';
  bot.weapon = bot.preferredWeapon;
  room.players.set(sid, bot);
  respawn(room, bot, true);
  broadcastRoomList();
  emitMetaFor(room);
  return bot;
}

function removeBot(room) {
  for (const [sid, p] of room.players) {
    if (p.isBot) { room.players.delete(sid); broadcastRoomList(); emitMetaFor(room); return true; }
  }
  return false;
}

function updateBot(room, bot, dt) {
  const b = bot.bot;
  if (!bot.alive) return;
  // Find nearest visible enemy.
  let target = null, best = Infinity;
  for (const p of room.players.values()) {
    if (p === bot || !p.alive) continue;
    if (room.mode === 'tdm' && p.team === bot.team) continue;
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d < best) { best = d; target = p; }
  }
  const inp = bot.input;
  inp.up = inp.down = inp.left = inp.right = inp.fire = false;
  if (target) {
    const ang = Math.atan2(target.y - bot.y, target.x - bot.x);
    inp.angle = ang + rand(-0.045, 0.045);
    bot.angle = inp.angle;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const w = WEAPONS[bot.weapon];
    const los = hasLineOfSight(room, bot.x, bot.y, target.x, target.y);
    if (!los) {
      // No shot: arc around obstacles (toward target + a committed sidestep)
      // instead of walking straight into the wall between us and the target.
      if (b.wander <= 0) { b.detour = Math.random() < 0.5 ? 1 : -1; b.wander = rand(0.5, 1.2); }
      b.wander -= dt;
      const mvx = dx * 0.55 + (-dy) * b.detour * 0.85;
      const mvy = dy * 0.55 + (dx) * b.detour * 0.85;
      inp.right = mvx > 0; inp.left = mvx < 0; inp.down = mvy > 0; inp.up = mvy < 0;
    } else {
      // Clear shot: fire and reposition to an aggressive mid-range.
      if (best < w.range) inp.fire = true;
      if (best > 230) { inp.right = dx > 0; inp.left = dx < 0; inp.down = dy > 0; inp.up = dy < 0; }
      else if (best < 130) { inp.right = dx < 0; inp.left = dx > 0; inp.down = dy < 0; inp.up = dy > 0; }
      else {
        if (b.wander <= 0) { b.strafe = Math.random() < 0.5 ? 1 : -1; b.wander = rand(0.4, 1.1); }
        const sx = -dy * b.strafe, sy = dx * b.strafe;
        inp.right = sx > 0; inp.left = sx < 0; inp.down = sy > 0; inp.up = sy < 0;
      }
      if (bot.grenades > 0 && now() > b.nextGrenade && best < GRENADE_RADIUS * 2.4 && best > 120) {
        throwGrenade(room, bot);
        b.nextGrenade = now() + rand(6000, 12000);
      }
    }
    b.wander -= dt;
  } else {
    // Wander toward center.
    if (b.wander <= 0) { b.dir = rand(0, Math.PI * 2); b.wander = rand(0.6, 1.6); }
    b.wander -= dt;
    inp.right = Math.cos(b.dir) > 0; inp.left = Math.cos(b.dir) < 0;
    inp.down = Math.sin(b.dir) > 0; inp.up = Math.sin(b.dir) < 0;
    inp.angle = b.dir; bot.angle = b.dir;
  }
}

// ---- Combat -----------------------------------------------------------------

function canReload(player) {
  const w = WEAPONS[player.weapon];
  if (w.melee) return false;
  const a = player.ammo[player.weapon];
  return a.mag < w.mag && (a.reserve === Infinity || a.reserve > 0);
}

function startReload(player) {
  if (player.reloadUntil > now()) return;
  if (!canReload(player)) return;
  player.reloadUntil = now() + WEAPONS[player.weapon].reload;
}

function finishReloads(room) {
  const t = now();
  for (const p of room.players.values()) {
    if (p.alive && p.reloadUntil && t >= p.reloadUntil) {
      p.reloadUntil = 0;
      const w = WEAPONS[p.weapon];
      const a = p.ammo[p.weapon];
      const need = w.mag - a.mag;
      if (a.reserve === Infinity) { a.mag = w.mag; }
      else { const take = Math.min(need, a.reserve); a.mag += take; a.reserve -= take; }
    }
    // Bots keep topped up so they stay aggressive.
    if (p.isBot && p.alive) { const a = p.ammo[p.weapon]; const w = WEAPONS[p.weapon]; if (a.mag <= 0) a.mag = w.mag; }
  }
}

function fire(room, player, t) {
  if (!player.alive) return;
  const w = WEAPONS[player.weapon];
  if (t - player.lastShot < w.fireRate) return;
  if (player.reloadUntil > t) return;

  if (w.melee) {
    player.lastShot = t;
    const tx = player.x + Math.cos(player.input.angle) * w.range;
    const ty = player.y + Math.sin(player.input.angle) * w.range;
    for (const victim of room.players.values()) {
      if (victim === player || !victim.alive) continue;
      if (room.mode === 'tdm' && victim.team === player.team) continue;
      if (Math.hypot(victim.x - tx, victim.y - ty) < PLAYER_RADIUS + 10) {
        dealDamage(room, victim, w.damage * dmgMult(player), player);
        room.events.push({ t: 'hit', x: victim.x, y: victim.y });
      }
    }
    room.events.push({ t: 'melee', x: player.x, y: player.y, a: +player.input.angle.toFixed(2) });
    return;
  }

  const a = player.ammo[player.weapon];
  if (!player.isBot && a.mag <= 0) { startReload(player); return; }
  player.lastShot = t;
  if (!player.isBot) a.mag = Math.max(0, a.mag - 1);

  const mult = dmgMult(player);
  for (let i = 0; i < w.pellets; i++) {
    const spread = (Math.random() - 0.5) * w.spread * 2;
    const ang = player.input.angle + spread;
    room.bullets.push({
      x: player.x + Math.cos(ang) * (PLAYER_RADIUS + 6),
      y: player.y + Math.sin(ang) * (PLAYER_RADIUS + 6),
      vx: Math.cos(ang) * w.speed, vy: Math.sin(ang) * w.speed,
      dmg: w.damage * mult, owner: player.sid, ownerName: player.username,
      team: player.team, dist: 0, range: w.range,
      kind: w.projectile === 'rocket' ? 'rocket' : 'bullet',
      splash: w.splash || 0, splashDmg: (w.splashDmg || 0) * mult
    });
  }
  room.events.push({ t: 'shot', weapon: player.weapon, x: player.x, y: player.y });
  if (!player.isBot && a.mag <= 0) startReload(player);
}

function dmgMult(player) { return player.buffs.damage > now() ? 1.8 : 1; }

function throwGrenade(room, player) {
  if (!player.alive || player.grenades <= 0) return;
  player.grenades--;
  const ang = player.input.angle;
  const power = 560;
  room.grenades.push({
    x: player.x + Math.cos(ang) * (PLAYER_RADIUS + 6),
    y: player.y + Math.sin(ang) * (PLAYER_RADIUS + 6),
    vx: Math.cos(ang) * power, vy: Math.sin(ang) * power,
    owner: player.sid, ownerName: player.username, team: player.team,
    explodeAt: now() + GRENADE_FUSE
  });
  room.events.push({ t: 'throw', x: player.x, y: player.y });
}

function dash(room, player) {
  if (!player.alive) return;
  const t = now();
  if (t < player.dashCdUntil) return;
  let dx = 0, dy = 0;
  if (player.input.up) dy -= 1; if (player.input.down) dy += 1;
  if (player.input.left) dx -= 1; if (player.input.right) dx += 1;
  if (dx === 0 && dy === 0) { dx = Math.cos(player.input.angle); dy = Math.sin(player.input.angle); }
  const len = Math.hypot(dx, dy) || 1;
  player.dashDir = { x: dx / len, y: dy / len };
  player.dashUntil = t + DASH_MS;
  player.dashCdUntil = t + DASH_COOLDOWN;
  room.events.push({ t: 'dash', x: player.x, y: player.y });
}

function dealDamage(room, victim, dmg, attacker) {
  if (!victim.alive) return;
  if (victim.shield > 0) {
    const absorbed = Math.min(victim.shield, dmg);
    victim.shield -= absorbed;
    dmg -= absorbed;
  }
  victim.hp -= dmg;
  if (victim.hp <= 0) killPlayer(room, victim, attacker);
}

function killPlayer(room, victim, attacker) {
  victim.alive = false;
  victim.deaths++;
  victim.streak = 0;
  victim.hp = 0;
  victim.respawnAt = now() + RESPAWN_MS;
  const du = db.findUserById(victim.userId);
  if (du && !victim.isBot) { du.stats.deaths = (du.stats.deaths || 0) + 1; db.save(); }

  let killerName = 'Die Welt';
  if (attacker && attacker.sid !== victim.sid && !(room.mode === 'tdm' && attacker.team === victim.team)) {
    attacker.kills++;
    attacker.streak++;
    killerName = attacker.username;
    if (room.mode === 'tdm') room.match.scores[attacker.team]++;
    const ku = db.findUserById(attacker.userId);
    if (ku && !attacker.isBot) {
      ku.stats.kills = (ku.stats.kills || 0) + 1;
      ku.stats.xp = (ku.stats.xp || 0) + 10;
      db.save();
    }
    if (attacker.streak === 3) sysMsg(room, `🔥 ${attacker.username} ist auf einer Killstreak (3)!`);
    else if (attacker.streak === 5) sysMsg(room, `💀 ${attacker.username} wütet! (5 Kills)`);
    else if (attacker.streak >= 8) sysMsg(room, `☠️ ${attacker.username} ist UNAUFHALTSAM (${attacker.streak})!`);
  }
  room.events.push({ t: 'kill', x: victim.x, y: victim.y });
  io.to('room:' + room.id).emit('killfeed', { killer: killerName, victim: victim.username, weapon: attacker ? attacker.weapon : null });
}

function explode(room, x, y, radius, dmg, owner, ownerName, team) {
  for (const victim of room.players.values()) {
    if (!victim.alive) continue;
    if (room.mode === 'tdm' && victim.team === team && victim.sid !== owner) continue;
    const d = Math.hypot(victim.x - x, victim.y - y);
    if (d < radius) {
      const falloff = 1 - d / radius;
      dealDamage(room, victim, dmg * falloff, room.players.get(owner));
    }
  }
  room.events.push({ t: 'explosion', x, y, r: radius });
}

// ---- Main tick --------------------------------------------------------------

function startLoop(room) {
  const dt = 1 / TICK_HZ;
  room.loop = setInterval(() => tick(room, dt), 1000 / TICK_HZ);
}

function tick(room, dt) {
  const t = now();
  const m = room.match;

  // Match flow
  if (m.state === 'playing') {
    if (room.mode === 'ffa') {
      let leader = null;
      for (const p of room.players.values()) if (!leader || p.kills > leader.kills) leader = p;
      if (leader && leader.kills >= m.killLimit) endMatch(room, { sid: leader.sid, name: leader.username });
    } else {
      if (m.scores.red >= m.killLimit) endMatch(room, 'red');
      else if (m.scores.blue >= m.killLimit) endMatch(room, 'blue');
    }
    if (m.state === 'playing' && t - m.startedAt > m.timeLimit) {
      if (room.mode === 'tdm') endMatch(room, m.scores.red >= m.scores.blue ? 'red' : 'blue');
      else { let l = null; for (const p of room.players.values()) if (!l || p.kills > l.kills) l = p; endMatch(room, l ? { sid: l.sid, name: l.username } : null); }
    }
  } else if (m.state === 'ended' && t >= m.resetAt) {
    startMatch(room, m.killLimit);
    io.to('room:' + room.id).emit('match:start', matchResult(room));
    sysMsg(room, '🔄 Neue Runde gestartet!');
  }

  const playing = m.state === 'playing';

  // Bots think
  if (playing) for (const p of room.players.values()) if (p.isBot) updateBot(room, p, dt);

  // Players
  for (const player of room.players.values()) {
    if (!player.alive) {
      if (playing && t >= player.respawnAt) respawn(room, player, false);
      continue;
    }
    if (!playing) continue;
    player.angle = player.input.angle;

    let speed = BASE_SPEED;
    if (player.buffs.speed > t) speed *= 1.55;
    let mx, my;
    if (player.dashUntil > t) {
      mx = player.dashDir.x * DASH_SPEED * dt;
      my = player.dashDir.y * DASH_SPEED * dt;
    } else {
      let dx = 0, dy = 0;
      if (player.input.up) dy -= 1; if (player.input.down) dy += 1;
      if (player.input.left) dx -= 1; if (player.input.right) dx += 1;
      if (dx || dy) { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }
      mx = dx * speed * dt; my = dy * speed * dt;
    }
    if (mx || my) {
      const nx = player.x + mx, ny = player.y + my;
      if (!collidesWorld(room, nx, player.y)) player.x = nx;
      if (!collidesWorld(room, player.x, ny)) player.y = ny;
    }
    if (player.input.fire) fire(room, player, t);

    // Powerup pickups
    for (const p of room.powerups) {
      if (!p.active) continue;
      if (Math.hypot(player.x - p.x, player.y - p.y) < PLAYER_RADIUS + 15) {
        applyPowerup(player, p);
        p.active = false; p.respawnAt = t + POWERUP_RESPAWN_MS;
        room.events.push({ t: 'pickup', x: p.x, y: p.y, type: p.type });
      }
    }
  }

  finishReloads(room);
  for (const p of room.powerups) if (!p.active && t >= p.respawnAt) p.active = true;

  // Bullets
  const keep = [];
  for (const b of room.bullets) {
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    b.dist += Math.hypot(nx - b.x, ny - b.y);
    b.x = nx; b.y = ny;
    let dead = false;
    if (b.x < 0 || b.y < 0 || b.x > WORLD.w || b.y > WORLD.h || b.dist > b.range) dead = true;
    else if (room.obstacles.some((o) => pointInRect(b.x, b.y, o))) dead = true;
    else {
      for (const victim of room.players.values()) {
        if (!victim.alive || victim.sid === b.owner) continue;
        if (room.mode === 'tdm' && victim.team === b.team) continue;
        if (Math.hypot(victim.x - b.x, victim.y - b.y) < PLAYER_RADIUS) {
          if (b.kind === 'rocket') break; // handled by explosion below
          dealDamage(room, victim, b.dmg, room.players.get(b.owner));
          room.events.push({ t: 'hit', x: b.x, y: b.y });
          dead = true; break;
        }
      }
      if (!dead && b.kind === 'rocket') {
        for (const victim of room.players.values()) {
          if (!victim.alive || victim.sid === b.owner) continue;
          if (room.mode === 'tdm' && victim.team === b.team) continue;
          if (Math.hypot(victim.x - b.x, victim.y - b.y) < PLAYER_RADIUS) { dead = true; break; }
        }
      }
    }
    if (dead) {
      if (b.kind === 'rocket') explode(room, b.x, b.y, b.splash, b.splashDmg, b.owner, b.ownerName, b.team);
      continue;
    }
    keep.push(b);
  }
  room.bullets = keep;

  // Grenades (bounce off walls, explode on fuse)
  const gkeep = [];
  for (const g of room.grenades) {
    g.vx *= 0.985; g.vy *= 0.985;
    const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
    if (nx < 12 || nx > WORLD.w - 12) g.vx *= -0.6; else g.x = nx;
    if (ny < 12 || ny > WORLD.h - 12) g.vy *= -0.6; else g.y = ny;
    if (room.obstacles.some((o) => circleRectCollide(g.x, g.y, 8, o))) { g.vx *= -0.5; g.vy *= -0.5; }
    if (t >= g.explodeAt) { explode(room, g.x, g.y, GRENADE_RADIUS, GRENADE_DMG, g.owner, g.ownerName, g.team); continue; }
    gkeep.push(g);
  }
  room.grenades = gkeep;

  broadcastState(room);
  room.events = [];
}

function collidesWorld(room, x, y) {
  if (x < PLAYER_RADIUS || y < PLAYER_RADIUS || x > WORLD.w - PLAYER_RADIUS || y > WORLD.h - PLAYER_RADIUS) return true;
  return room.obstacles.some((o) => circleRectCollide(x, y, PLAYER_RADIUS, o));
}

function applyPowerup(player, p) {
  const t = now();
  if (p.type === 'health') player.hp = Math.min(MAX_HP, player.hp + 55);
  else if (p.type === 'shield') player.shield = 100;
  else if (p.type === 'damage') player.buffs.damage = t + 9000;
  else if (p.type === 'speed') player.buffs.speed = t + 9000;
  else if (p.type === 'ammo') {
    for (const key of WEAPON_ORDER) {
      const w = WEAPONS[key]; const a = player.ammo[key];
      if (a.reserve !== Infinity) a.reserve = Math.min(w.reserve, a.reserve + Math.ceil(w.reserve / 2));
      a.mag = w.mag;
    }
    player.grenades = Math.min(START_GRENADES + 2, player.grenades + 2);
  }
}

// ---- Snapshots --------------------------------------------------------------

function broadcastState(room) {
  const t = now();
  const players = [];
  for (const p of room.players.values()) {
    const a = p.ammo[p.weapon] || { mag: 0, reserve: 0 };
    players.push({
      id: p.sid, name: p.username, color: p.color, team: p.team,
      x: Math.round(p.x), y: Math.round(p.y), angle: +p.angle.toFixed(2),
      hp: Math.max(0, Math.round(p.hp)), shield: Math.round(p.shield),
      weapon: p.weapon, alive: p.alive, kills: p.kills, deaths: p.deaths, streak: p.streak,
      bot: p.isBot,
      mag: a.mag === Infinity ? -1 : a.mag, reserve: a.reserve === Infinity ? -1 : a.reserve,
      grenades: p.grenades, reloading: p.reloadUntil > t,
      buffDamage: p.buffs.damage > t, buffSpeed: p.buffs.speed > t,
      dashReady: t >= p.dashCdUntil
    });
  }
  io.to('room:' + room.id).emit('state', {
    players,
    bullets: room.bullets.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), r: b.kind === 'rocket' })),
    grenades: room.grenades.map((g) => ({ x: Math.round(g.x), y: Math.round(g.y) })),
    powerups: room.powerups.filter((p) => p.active).map((p) => ({ x: p.x, y: p.y, type: p.type })),
    events: room.events,
    match: { state: room.match.state, mode: room.mode, killLimit: room.match.killLimit,
             scores: room.match.scores, timeLeft: Math.max(0, room.match.timeLimit - (t - room.match.startedAt)) }
  });
}

function matchResult(room) {
  const board = [...room.players.values()].map((p) => ({ name: p.username, kills: p.kills, deaths: p.deaths, team: p.team, bot: p.isBot }))
    .sort((a, b) => b.kills - a.kills);
  return {
    mode: room.mode, state: room.match.state, winner: room.match.winner,
    scores: room.match.scores, board, resetIn: Math.max(0, room.match.resetAt - now())
  };
}

function roomMeta(room) {
  return {
    id: room.id, name: room.name, visibility: room.visibility, mode: room.mode, mapId: room.mapId,
    ownerId: room.ownerId, ownerName: room.ownerName,
    moderators: [...room.moderators], invited: [...room.invited], joinCode: room.joinCode,
    maxPlayers: room.maxPlayers, killLimit: room.match.killLimit,
    players: [...room.players.values()].map((p) => ({ userId: p.userId, name: p.username, sid: p.sid, bot: p.isBot, team: p.team }))
  };
}

function sysMsg(room, text) { io.to('room:' + room.id).emit('chat:msg', { system: true, text }); }
function emitMetaFor(room) { io.to('room:' + room.id).emit('room:state:meta', roomMeta(room)); }

function publicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.visibility !== 'public') continue;
    list.push({ id: room.id, name: room.name, ownerName: room.ownerName, mode: room.mode, mapId: room.mapId,
      players: [...room.players.values()].filter((p) => !p.isBot).length, bots: [...room.players.values()].filter((p) => p.isBot).length,
      maxPlayers: room.maxPlayers, visibility: room.visibility });
  }
  return list;
}

function adminRoomList() {
  return [...rooms.values()].map((room) => ({
    id: room.id, name: room.name, ownerName: room.ownerName, mode: room.mode,
    players: [...room.players.values()].filter((p) => !p.isBot).length,
    bots: [...room.players.values()].filter((p) => p.isBot).length,
    maxPlayers: room.maxPlayers, visibility: room.visibility, joinCode: room.joinCode
  }));
}

function broadcastRoomList() {
  if (!io) return;
  io.to('lobby').emit('lobby:rooms', publicRoomList());
  io.to('admins').emit('admin:rooms', adminRoomList());
}

function getRoom(id) { return rooms.get(Number(id)); }

module.exports = {
  init, createRoom, destroyRoom, getRoom, addPlayer, removePlayer,
  addBot, removeBot, canManage, canJoin, roomMeta, matchResult,
  publicRoomList, adminRoomList, broadcastRoomList, emitMetaFor,
  fire, throwGrenade, dash, startReload,
  socketToRoom, rooms, WEAPONS, WEAPON_ORDER, WORLD, MAPS: maps.MAP_LIST
};
