/* Schooter client app: auth, lobby, room management, admin panel, socket wiring. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const API = '';
  let token = localStorage.getItem('schooter_token') || null;
  let me = null;
  let socket = null;
  let authMode = 'login';
  let currentMeta = null;   // meta of the room we're in
  let myRoomRole = null;
  let CONFIG = { maps: [], weapons: {}, weaponOrder: [] };

  async function loadConfig() {
    try {
      const res = await fetch(API + '/api/config');
      CONFIG = await res.json();
    } catch (e) { /* non-fatal */ }
    const sel = $('new-room-map');
    if (sel) {
      sel.innerHTML = '<option value="">Zufällige Karte</option>' +
        CONFIG.maps.map((m) => '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>').join('');
    }
  }

  // ---------------- Screen helpers ----------------
  function show(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $('screen-' + screen).classList.add('active');
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------------- Auth ----------------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      authMode = tab.dataset.tab;
      $('auth-submit').textContent = authMode === 'login' ? 'Anmelden' : 'Registrieren';
      $('auth-error').textContent = '';
    });
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    $('auth-error').textContent = '';
    try {
      const res = await fetch(API + '/api/' + authMode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { $('auth-error').textContent = data.error || 'Fehler.'; return; }
      token = data.token;
      me = data.user;
      localStorage.setItem('schooter_token', token);
      enterLobby();
    } catch (err) {
      $('auth-error').textContent = 'Serverfehler.';
    }
  });

  $('btn-logout').addEventListener('click', logout);
  function logout() {
    localStorage.removeItem('schooter_token');
    token = null; me = null;
    if (socket) { socket.disconnect(); socket = null; }
    show('auth');
  }

  async function tryResume() {
    if (!token) { show('auth'); return; }
    try {
      const res = await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error();
      const data = await res.json();
      me = data.user;
      enterLobby();
    } catch (err) {
      logout();
    }
  }

  // ---------------- Socket ----------------
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect_error', (err) => {
      if (err.message === 'banned') { toast('Account gesperrt.'); logout(); }
    });

    socket.on('lobby:rooms', renderRooms);
    socket.on('admin:rooms', renderAdminRooms);

    socket.on('state', (s) => {
      SchooterGame.setState(s);
      updateHud(s);
    });
    socket.on('sfx', (d) => {
      if (d.type === 'shot') SchooterGame.addFlash(d.x, d.y, '#ffcc55');
    });
    socket.on('chat:msg', addChat);
    socket.on('killfeed', addKillfeed);
    socket.on('match:end', showMatchEnd);
    socket.on('match:start', () => { $('match-overlay').classList.add('hidden'); });
    socket.on('room:state:meta', (meta) => { currentMeta = meta; renderManage(); updateManageBtn(); });
    socket.on('room:kicked', (d) => { toast(d.banned ? 'Du wurdest verbannt.' : 'Du wurdest gekickt.'); backToLobby(); });
    socket.on('room:closed', () => { toast('Der Raum wurde geschlossen.'); backToLobby(); });
  }

  // ---------------- Lobby ----------------
  function enterLobby() {
    connectSocket();
    show('lobby');
    $('lobby-user').innerHTML = 'Angemeldet als <b>' + escapeHtml(me.username) + '</b>' +
      (me.role === 'admin' ? ' <span class="badge">ADMIN</span>' : '');
    $('btn-admin').classList.toggle('hidden', me.role !== 'admin');
  }

  $('btn-refresh').addEventListener('click', () => socket && socket.emit('lobby:list'));

  function renderRooms(rooms) {
    const list = $('room-list');
    if (!rooms || !rooms.length) {
      list.innerHTML = '<div class="empty">Noch keine öffentlichen Räume. Erstelle den ersten!</div>';
      return;
    }
    list.innerHTML = '';
    rooms.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'room-card';
      const modeLabel = r.mode === 'tdm' ? 'Team' : 'FFA';
      div.innerHTML =
        '<div><div class="rc-name">' + escapeHtml(r.name) + '</div>' +
        '<div class="rc-sub">von ' + escapeHtml(r.ownerName) + ' · ' + modeLabel +
        (r.bots ? ' · ' + r.bots + ' Bots' : '') + '</div></div>' +
        '<div class="spacer"></div>' +
        '<span class="badge">' + r.players + '/' + r.maxPlayers + '</span>' +
        '<button class="btn small primary">Beitreten</button>';
      div.querySelector('button').addEventListener('click', () => joinRoom({ roomId: r.id }));
      list.appendChild(div);
    });
  }

  $('btn-create').addEventListener('click', () => {
    const name = $('new-room-name').value.trim() || (me.username + 's Raum');
    const visibility = $('new-room-private').checked ? 'private' : 'public';
    const maxPlayers = parseInt($('new-room-max').value, 10) || 8;
    const mode = $('new-room-mode').value;
    const mapId = $('new-room-map').value;
    const killLimit = parseInt($('new-room-kills').value, 10) || 25;
    socket.emit('room:create', { name, visibility, maxPlayers, mode, mapId, killLimit }, onJoined);
  });

  $('btn-join-code').addEventListener('click', () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (!code) return;
    joinRoom({ code });
  });

  function joinRoom(payload) {
    $('lobby-error').textContent = '';
    socket.emit('room:join', payload, onJoined);
  }

  function onJoined(res) {
    if (!res || res.error) { $('lobby-error').textContent = (res && res.error) || 'Fehler.'; return; }
    currentMeta = res.meta;
    myRoomRole = res.you.role;
    enterGame(res);
  }

  // ---------------- Game screen ----------------
  function enterGame(res) {
    show('game');
    $('hud-roomname').textContent = currentMeta.name;
    $('chat-log').innerHTML = '';
    $('killfeed').innerHTML = '';
    $('match-overlay').classList.add('hidden');
    buildWeaponBar(res.weaponOrder || CONFIG.weaponOrder, res.weapons || CONFIG.weapons);
    SchooterGame.start($('canvas'), $('minimap'), {
      world: res.world,
      obstacles: res.obstacles || [],
      mode: res.mode || 'ffa',
      weaponOrder: res.weaponOrder || CONFIG.weaponOrder,
      mySid: socket.id,
      onInput: (input) => socket.emit('input', input),
      onAct: (a) => socket.emit('act', a)
    });
    SchooterGame.setMySid(socket.id);
    updateManageBtn();
  }

  function buildWeaponBar(order, weapons) {
    const bar = $('hud-weaponbar');
    bar.innerHTML = '';
    (order || []).forEach((key, i) => {
      const w = (weapons && weapons[key]) || {};
      const slot = document.createElement('div');
      slot.className = 'wslot'; slot.dataset.weapon = key;
      slot.innerHTML = '<span class="k">' + (i + 1) + '</span>' + escapeHtml((w.name || key).slice(0, 6));
      slot.onclick = () => socket.emit('act', { a: 'switch', w: key });
      bar.appendChild(slot);
    });
  }

  function backToLobby() {
    SchooterGame.stop();
    currentMeta = null;
    $('manage-modal').classList.add('hidden');
    show('lobby');
    socket.emit('lobby:list');
  }

  $('btn-leave').addEventListener('click', () => {
    socket.emit('room:leave');
    backToLobby();
  });

  function updateHud(s) {
    const me2 = s.players.find((p) => p.id === socket.id);
    // scoreboard
    const sb = $('scoreboard');
    const sorted = [...s.players].sort((a, b) => b.kills - a.kills);
    sb.innerHTML = sorted.map((p) =>
      '<div class="sb-row' + (p.id === socket.id ? ' me' : '') + '">' +
      '<span class="sb-dot" style="background:' + p.color + '"></span>' +
      '<span class="sb-name">' + escapeHtml(p.name) + '</span>' +
      '<span class="sb-kd">' + p.kills + '/' + p.deaths + '</span></div>'
    ).join('');
    if (me2) {
      const pct = Math.max(0, me2.hp);
      $('hud-hp').querySelector('.hp-fill').style.width = pct + '%';
      $('hud-hp').querySelector('.hp-text').textContent = 'HP ' + pct;
      const shieldEl = $('hud-shield');
      shieldEl.classList.toggle('hidden', !me2.shield);
      if (me2.shield) shieldEl.querySelector('.shield-fill').style.width = me2.shield + '%';
      // ammo
      const ammoTxt = me2.mag < 0 ? '∞' : (me2.reloading ? 'NACHLADEN' : me2.mag + ' / ' + (me2.reserve < 0 ? '∞' : me2.reserve));
      $('hud-ammo').textContent = '🔫 ' + ammoTxt;
      $('hud-nade').textContent = '💣 ' + me2.grenades;
      // weapon bar highlight
      document.querySelectorAll('.wslot').forEach((el) =>
        el.classList.toggle('active', el.dataset.weapon === me2.weapon));
      $('respawn-overlay').classList.toggle('hidden', me2.alive);
    }
    // match bar
    const m = s.match || {};
    const bar = $('hud-matchbar');
    const secs = Math.ceil((m.timeLeft || 0) / 1000);
    const time = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    if (m.mode === 'tdm') {
      bar.innerHTML = '<span class="score-red">🔴 ' + (m.scores ? m.scores.red : 0) + '</span>' +
        '<span class="timer">' + time + '</span>' +
        '<span class="score-blue">' + (m.scores ? m.scores.blue : 0) + ' 🔵</span>' +
        '<span class="timer">Ziel ' + m.killLimit + '</span>';
    } else {
      const lead = sorted[0];
      bar.innerHTML = '<span>👑 ' + (lead ? escapeHtml(lead.name) + ' (' + lead.kills + ')' : '—') + '</span>' +
        '<span class="timer">' + time + '</span><span class="timer">Ziel ' + m.killLimit + '</span>';
    }
  }

  function addKillfeed(k) {
    const feed = $('killfeed');
    const div = document.createElement('div');
    div.className = 'kf';
    const wn = k.weapon ? (CONFIG.weapons[k.weapon] || {}).name || k.weapon : '';
    div.innerHTML = '<span class="kf-k">' + escapeHtml(k.killer) + '</span>' +
      '<span class="kf-w">' + escapeHtml(wn) + ' ☠</span>' +
      '<span>' + escapeHtml(k.victim) + '</span>';
    feed.appendChild(div);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
    setTimeout(() => div.remove(), 5000);
  }

  function showMatchEnd(result) {
    const overlay = $('match-overlay');
    let title;
    if (result.mode === 'tdm') {
      title = result.winner === 'red' ? '🔴 Team Rot gewinnt!' : '🔵 Team Blau gewinnt!';
    } else {
      title = result.winner ? '👑 ' + result.winner.name + ' gewinnt!' : 'Runde beendet';
    }
    $('match-title').textContent = title;
    $('match-board').innerHTML = result.board.slice(0, 8).map((r, i) =>
      '<div class="mb-row"><span class="mb-rank">' + (i + 1) + '.</span>' +
      '<span>' + escapeHtml(r.name) + '</span><div class="spacer"></div>' +
      '<span>' + r.kills + ' K / ' + r.deaths + ' T</span></div>').join('');
    $('match-reset').textContent = 'Neue Runde in Kürze…';
    overlay.classList.remove('hidden');
  }

  // ---------------- Chat ----------------
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (text) socket.emit('chat:send', { text });
    input.value = '';
  });
  function addChat(m) {
    const log = $('chat-log');
    const div = document.createElement('div');
    div.className = 'msg' + (m.system ? ' system' : '');
    div.innerHTML = m.system ? escapeHtml(m.text) : '<b>' + escapeHtml(m.name) + ':</b> ' + escapeHtml(m.text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 60) log.removeChild(log.firstChild);
  }

  // ---------------- Room management modal ----------------
  function canManageRoom() {
    if (!currentMeta || !me) return false;
    return me.role === 'admin' || currentMeta.ownerId === me.id || currentMeta.moderators.includes(me.id);
  }
  function isOwner() { return currentMeta && (currentMeta.ownerId === me.id || me.role === 'admin'); }

  function updateManageBtn() {
    $('btn-manage').classList.toggle('hidden', !canManageRoom());
  }

  $('btn-manage').addEventListener('click', () => {
    if (!canManageRoom()) return;
    renderManage();
    $('manage-modal').classList.remove('hidden');
  });
  $('mg-dismiss').addEventListener('click', () => $('manage-modal').classList.add('hidden'));

  function renderManage() {
    if (!currentMeta) return;
    $('mg-name').value = currentMeta.name;
    $('mg-private').checked = currentMeta.visibility === 'private';
    $('mg-code').textContent = currentMeta.joinCode;
    $('mg-mode').textContent = currentMeta.mode === 'tdm' ? 'Team-Deathmatch' : 'Jeder gegen jeden';
    const wrap = $('mg-players');
    wrap.innerHTML = '';
    currentMeta.players.forEach((p) => {
      const isOwn = p.userId === currentMeta.ownerId;
      const isMod = currentMeta.moderators.includes(p.userId);
      const row = document.createElement('div');
      row.className = 'mg-player';
      row.innerHTML =
        '<span>' + escapeHtml(p.name) + '</span>' +
        (isOwn ? '<span class="tag owner">Eigentümer</span>' : isMod ? '<span class="tag mod">Moderator</span>' : '') +
        '<div class="spacer"></div>';
      if (!isOwn && p.userId !== me.id) {
        const kick = document.createElement('button');
        kick.className = 'btn small'; kick.textContent = 'Kick';
        kick.onclick = () => socket.emit('room:kick', { sid: p.sid }, ack);
        const ban = document.createElement('button');
        ban.className = 'btn small danger'; ban.textContent = 'Ban';
        ban.onclick = () => socket.emit('room:ban', { sid: p.sid }, ack);
        row.appendChild(kick); row.appendChild(ban);
        if (isOwner()) {
          const mod = document.createElement('button');
          mod.className = 'btn small'; mod.textContent = isMod ? 'Mod entfernen' : 'Mod';
          mod.onclick = () => socket.emit('room:setModerator', { username: p.name, enabled: !isMod }, ack);
          row.appendChild(mod);
        }
      }
      wrap.appendChild(row);
    });
    // owner-only controls
    $('mg-mod').style.display = isOwner() ? '' : 'none';
    $('mg-close-room').style.display = isOwner() ? '' : 'none';
  }

  function ack(res) {
    if (res && res.error) $('mg-msg').textContent = res.error;
    else { $('mg-msg').textContent = ''; if (res && res.message) toast(res.message); }
  }

  $('mg-save').addEventListener('click', () => {
    socket.emit('room:update', {
      name: $('mg-name').value.trim(),
      visibility: $('mg-private').checked ? 'private' : 'public'
    }, ack);
  });
  $('mg-invite').addEventListener('click', () => {
    const username = $('mg-invite-name').value.trim();
    if (username) socket.emit('room:invite', { username }, ack);
  });
  $('mg-mod').addEventListener('click', () => {
    const username = $('mg-invite-name').value.trim();
    if (username) socket.emit('room:setModerator', { username, enabled: true }, ack);
  });
  $('mg-close-room').addEventListener('click', () => {
    if (confirm('Raum wirklich schließen? Alle Spieler werden entfernt.')) {
      socket.emit('room:close', {}, (res) => { if (res && res.error) toast(res.error); });
    }
  });
  $('mg-addbot').addEventListener('click', () => socket.emit('room:addBot', {}, ack));
  $('mg-rmbot').addEventListener('click', () => socket.emit('room:removeBot', {}, ack));

  // ---------------- Leaderboard ----------------
  $('btn-leaderboard').addEventListener('click', async () => {
    $('lb-modal').classList.remove('hidden');
    $('lb-list').innerHTML = '<div class="empty">Lädt…</div>';
    try {
      const res = await fetch(API + '/api/leaderboard', { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (!data.leaderboard.length) { $('lb-list').innerHTML = '<div class="empty">Noch keine Statistiken.</div>'; return; }
      $('lb-list').innerHTML = data.leaderboard.map((u, i) =>
        '<div class="at-row"><span class="mb-rank">' + (i + 1) + '.</span>' +
        '<b>' + escapeHtml(u.username) + '</b>' +
        '<span class="badge">Lvl ' + u.stats.level + '</span>' +
        (u.role === 'admin' ? ' <span class="badge">ADMIN</span>' : '') +
        '<div class="spacer"></div>' +
        '<span class="muted">' + u.stats.kills + ' Kills · ' + u.stats.wins + ' Siege · K/D ' + u.stats.kd + '</span></div>'
      ).join('');
    } catch (e) { $('lb-list').innerHTML = '<div class="empty">Fehler beim Laden.</div>'; }
  });
  $('lb-dismiss').addEventListener('click', () => $('lb-modal').classList.add('hidden'));

  // ---------------- Admin panel ----------------
  $('btn-admin').addEventListener('click', openAdmin);
  $('btn-admin-back').addEventListener('click', () => show('lobby'));
  $('btn-admin-refresh').addEventListener('click', openAdmin);

  async function openAdmin() {
    show('admin');
    await Promise.all([loadAdminStats(), loadAdminUsers()]);
    socket.emit('lobby:list');
  }

  async function adminFetch(path, opts) {
    return fetch(API + path, Object.assign({
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, opts || {}));
  }

  async function loadAdminStats() {
    const res = await adminFetch('/api/admin/stats');
    const s = await res.json();
    $('admin-stats').innerHTML = [
      ['Benutzer', s.users], ['Admins', s.admins], ['Gesperrt', s.banned],
      ['Aktive Räume', s.rooms], ['Online-Spieler', s.players], ['Uptime (s)', s.uptime]
    ].map(([l, n]) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('');
  }

  async function loadAdminUsers() {
    const res = await adminFetch('/api/admin/users');
    const data = await res.json();
    const wrap = $('admin-users');
    wrap.innerHTML = '';
    data.users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'at-row';
      row.innerHTML =
        '<b>' + escapeHtml(u.username) + '</b>' +
        (u.role === 'admin' ? ' <span class="badge">ADMIN</span>' : '') +
        (u.banned ? ' <span class="badge" style="color:#e74c3c">GESPERRT</span>' : '') +
        '<span class="muted"> K/D ' + u.stats.kills + '/' + u.stats.deaths + '</span>' +
        '<div class="spacer"></div>';
      if (u.id !== me.id) {
        const roleBtn = document.createElement('button');
        roleBtn.className = 'btn small';
        roleBtn.textContent = u.role === 'admin' ? 'Admin entziehen' : 'Zum Admin';
        roleBtn.onclick = async () => {
          await adminFetch('/api/admin/users/' + u.id + '/role', {
            method: 'POST', body: JSON.stringify({ role: u.role === 'admin' ? 'user' : 'admin' })
          });
          loadAdminUsers();
        };
        row.appendChild(roleBtn);
        if (u.role !== 'admin') {
          const banBtn = document.createElement('button');
          banBtn.className = 'btn small ' + (u.banned ? '' : 'danger');
          banBtn.textContent = u.banned ? 'Entsperren' : 'Sperren';
          banBtn.onclick = async () => {
            await adminFetch('/api/admin/users/' + u.id + '/ban', {
              method: 'POST', body: JSON.stringify({ banned: !u.banned })
            });
            loadAdminUsers();
          };
          row.appendChild(banBtn);
        }
      }
      wrap.appendChild(row);
    });
  }

  function renderAdminRooms(rooms) {
    const wrap = $('admin-rooms');
    if (!wrap) return;
    if (!rooms || !rooms.length) { wrap.innerHTML = '<div class="empty">Keine aktiven Räume.</div>'; return; }
    wrap.innerHTML = '';
    rooms.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'at-row';
      row.innerHTML = '<b>' + escapeHtml(r.name) + '</b>' +
        ' <span class="badge">' + r.visibility + '</span>' +
        '<span class="muted"> von ' + escapeHtml(r.ownerName) + ' · ' + r.players + '/' + r.maxPlayers +
        ' · Code ' + r.joinCode + '</span><div class="spacer"></div>';
      const close = document.createElement('button');
      close.className = 'btn small danger'; close.textContent = 'Schließen';
      close.onclick = async () => {
        await adminFetch('/api/admin/rooms/' + r.id + '/close', { method: 'POST' });
        toast('Raum geschlossen.');
      };
      row.appendChild(close);
      wrap.appendChild(row);
    });
  }

  // ---------------- Utils ----------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- Boot ----------------
  loadConfig();
  tryResume();
})();
