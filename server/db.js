'use strict';

/**
 * Tiny JSON-file backed persistence layer.
 *
 * We deliberately avoid native modules (like better-sqlite3) so the project
 * installs and runs anywhere without a compiler toolchain. The whole dataset
 * is small (users + persistent room metadata), so keeping it in memory and
 * flushing to disk on change is perfectly adequate.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DATA = {
  users: [],   // { id, username, passwordHash, role, banned, createdAt, stats:{kills,deaths,wins} }
  rooms: [],   // persistent room metadata (see game.js for the live layer)
  meta: { nextUserId: 1, nextRoomId: 1 }
};

let data = null;
let flushTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      data = Object.assign({}, DEFAULT_DATA, JSON.parse(raw));
      data.meta = Object.assign({}, DEFAULT_DATA.meta, data.meta);
    } catch (err) {
      console.error('[db] Failed to parse db.json, starting fresh:', err.message);
      data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  } else {
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    flushNow();
  }
  return data;
}

function flushNow() {
  ensureDir();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** Debounced flush so a burst of writes only hits disk once. */
function save() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushNow();
    } catch (err) {
      console.error('[db] flush failed:', err.message);
    }
  }, 150);
}

// ----- Users -----------------------------------------------------------------

function getUsers() {
  return data.users;
}

function findUserByName(username) {
  const lower = String(username).toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === lower) || null;
}

function findUserById(id) {
  return data.users.find((u) => u.id === id) || null;
}

function createUser({ username, passwordHash }) {
  // The very first account ever created becomes the server admin.
  const role = data.users.length === 0 ? 'admin' : 'user';
  const user = {
    id: data.meta.nextUserId++,
    username,
    passwordHash,
    role,
    banned: false,
    createdAt: Date.now(),
    stats: { kills: 0, deaths: 0, wins: 0, xp: 0 }
  };
  data.users.push(user);
  save();
  return user;
}

function updateUser(id, patch) {
  const user = findUserById(id);
  if (!user) return null;
  Object.assign(user, patch);
  save();
  return user;
}

function nextRoomId() {
  const id = data.meta.nextRoomId++;
  save();
  return id;
}

/** Level curve: each level needs progressively more XP. */
function levelForXp(xp) {
  return Math.floor(0.5 + Math.sqrt(1 + (8 * (xp || 0)) / 100) / 2) || 1;
}

/** Public-safe projection of a user (no password hash). */
function publicUser(user) {
  if (!user) return null;
  const stats = Object.assign({ kills: 0, deaths: 0, wins: 0, xp: 0 }, user.stats || {});
  const kd = stats.deaths > 0 ? +(stats.kills / stats.deaths).toFixed(2) : stats.kills;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    banned: !!user.banned,
    createdAt: user.createdAt,
    stats: Object.assign(stats, { level: levelForXp(stats.xp), kd })
  };
}

module.exports = {
  load,
  save,
  flushNow,
  getUsers,
  findUserByName,
  findUserById,
  createUser,
  updateUser,
  nextRoomId,
  publicUser
};
