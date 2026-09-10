'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'schooter-dev-secret-change-me';
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: TOKEN_TTL
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'Benutzername und Passwort sind erforderlich.';
  }
  username = username.trim();
  if (username.length < 3 || username.length > 20) {
    return 'Benutzername muss zwischen 3 und 20 Zeichen lang sein.';
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
    return 'Benutzername darf nur Buchstaben, Zahlen, _ und - enthalten.';
  }
  if (password.length < 4 || password.length > 100) {
    return 'Passwort muss zwischen 4 und 100 Zeichen lang sein.';
  }
  return null;
}

async function register(username, password) {
  username = String(username || '').trim();
  const err = validateCredentials(username, password);
  if (err) return { error: err };
  if (db.findUserByName(username)) {
    return { error: 'Benutzername ist bereits vergeben.' };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = db.createUser({ username, passwordHash });
  return { user, token: signToken(user) };
}

async function login(username, password) {
  username = String(username || '').trim();
  const user = db.findUserByName(username);
  if (!user) return { error: 'Ungültiger Benutzername oder Passwort.' };
  if (user.banned) return { error: 'Dieser Account wurde gesperrt.' };
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return { error: 'Ungültiger Benutzername oder Passwort.' };
  return { user, token: signToken(user) };
}

/** Express middleware: requires a valid Bearer token. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Nicht authentifiziert.' });
  const user = db.findUserById(payload.uid);
  if (!user) return res.status(401).json({ error: 'Benutzer existiert nicht mehr.' });
  if (user.banned) return res.status(403).json({ error: 'Account gesperrt.' });
  req.user = user;
  next();
}

/** Express middleware: requires admin role (must run after requireAuth). */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Adminrechte erforderlich.' });
  }
  next();
}

module.exports = {
  JWT_SECRET,
  signToken,
  verifyToken,
  register,
  login,
  requireAuth,
  requireAdmin
};
