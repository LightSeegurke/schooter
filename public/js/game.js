/* Client-side rendering, input, sound and effects.
   Server is authoritative; this module draws snapshots, plays feedback and
   reports local input state + discrete actions upstream. */
(function () {
  'use strict';

  // ---- Web Audio: tiny synthesized SFX (no asset files needed) ----
  const Sound = {
    ctx: null, enabled: true,
    ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.enabled = false; } } },
    blip(freq, dur, type, gain) {
      if (!this.enabled) return;
      this.ensure(); if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), t + dur);
      g.gain.setValueAtTime(gain || 0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + dur);
    },
    noise(dur, gain) {
      if (!this.enabled) return; this.ensure(); if (!this.ctx) return;
      const t = this.ctx.currentTime, n = this.ctx.sampleRate * dur;
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const g = this.ctx.createGain(); g.gain.value = gain || 0.12;
      src.connect(g); g.connect(this.ctx.destination); src.start();
    },
    shot(weapon) {
      const map = { pistol: 480, smg: 360, rifle: 300, shotgun: 180, sniper: 700, rocket: 120, knife: 900 };
      if (weapon === 'shotgun') { this.noise(0.14, 0.14); }
      else if (weapon === 'rocket') { this.blip(140, 0.25, 'sawtooth', 0.08); }
      else this.blip(map[weapon] || 400, weapon === 'sniper' ? 0.2 : 0.06, 'square', 0.045);
    },
    explosion() { this.noise(0.35, 0.2); this.blip(90, 0.35, 'sawtooth', 0.09); },
    hit() { this.blip(220, 0.05, 'square', 0.05); },
    pickup() { this.blip(660, 0.12, 'sine', 0.06); this.blip(990, 0.1, 'sine', 0.05); },
    kill() { this.blip(520, 0.1, 'triangle', 0.07); this.blip(780, 0.12, 'triangle', 0.06); },
    dash() { this.blip(300, 0.12, 'sine', 0.05); }
  };

  const Game = {
    canvas: null, ctx: null, mini: null, mctx: null,
    world: { w: 1600, h: 900 }, obstacles: [], mode: 'ffa',
    state: { players: [], bullets: [], grenades: [], powerups: [], events: [], match: {} },
    input: { up: false, down: false, left: false, right: false, fire: false, angle: 0 },
    mySid: null, running: false, onInput: null, onAct: null,
    mouse: { x: 0, y: 0 }, particles: [], floaters: [], shakes: 0, weaponOrder: [],

    start(canvas, mini, opts) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.mini = mini; this.mctx = mini ? mini.getContext('2d') : null;
      this.world = opts.world || this.world;
      this.obstacles = opts.obstacles || [];
      this.mode = opts.mode || 'ffa';
      this.weaponOrder = opts.weaponOrder || [];
      this.mySid = opts.mySid;
      this.onInput = opts.onInput;
      this.onAct = opts.onAct;
      this.running = true;
      this.particles = []; this.floaters = []; this.shakes = 0;
      this._prevHp = 100;
      this._bind();
      this._lastSent = '';
      Sound.ensure();
      requestAnimationFrame((ts) => this._loop(ts));
      this._inputTimer = setInterval(() => this._sendInput(), 1000 / 30);
    },

    stop() {
      this.running = false;
      this._unbind();
      clearInterval(this._inputTimer);
    },

    setState(s) {
      this.state = s;
      if (s.world) this.world = s.world;
      this._consumeEvents(s.events || []);
      const me = this._me();
      if (me) {
        if (me.hp < this._prevHp && me.alive) this.shakes = Math.min(10, this.shakes + (this._prevHp - me.hp) * 0.15);
        this._prevHp = me.alive ? me.hp : 100;
      }
    },
    setMySid(sid) { this.mySid = sid; },

    _consumeEvents(events) {
      for (const e of events) {
        if (e.t === 'shot') Sound.shot(e.weapon);
        else if (e.t === 'hit') { this._burst(e.x, e.y, '#ffd94a', 5); Sound.hit(); }
        else if (e.t === 'explosion') { this._explosion(e.x, e.y, e.r); Sound.explosion(); this.shakes = 12; }
        else if (e.t === 'kill') this._burst(e.x, e.y, '#e74c3c', 16);
        else if (e.t === 'pickup') { this._burst(e.x, e.y, this._puColor(e.type), 10); Sound.pickup(); }
        else if (e.t === 'melee') this._melee(e.x, e.y, e.a);
        else if (e.t === 'dash') { this._burst(e.x, e.y, '#4ea1ff', 8); Sound.dash(); }
        else if (e.t === 'throw') Sound.blip(300, 0.08, 'sine', 0.04);
      }
    },

    _puColor(t) {
      return { health: '#2ecc71', shield: '#4ea1ff', damage: '#e74c3c', speed: '#f1c40f', ammo: '#e67e22' }[t] || '#fff';
    },

    // ---- input ----
    _bind() {
      this._kd = (e) => this._key(e, true);
      this._ku = (e) => this._key(e, false);
      this._mm = (e) => this._move(e);
      this._md = (e) => { if (e.button === 0) this.input.fire = true; };
      this._mu = (e) => { if (e.button === 0) this.input.fire = false; };
      this._wheel = (e) => this._scroll(e);
      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup', this._ku);
      this.canvas.addEventListener('mousemove', this._mm);
      this.canvas.addEventListener('mousedown', this._md);
      this.canvas.addEventListener('wheel', this._wheel, { passive: true });
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('mouseup', this._mu);
    },
    _unbind() {
      window.removeEventListener('keydown', this._kd);
      window.removeEventListener('keyup', this._ku);
      this.canvas.removeEventListener('mousemove', this._mm);
      this.canvas.removeEventListener('mousedown', this._md);
      this.canvas.removeEventListener('wheel', this._wheel);
      window.removeEventListener('mouseup', this._mu);
      this.input = { up: false, down: false, left: false, right: false, fire: false, angle: 0 };
    },

    _key(e, down) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') this.input.up = down;
      else if (k === 's' || k === 'arrowdown') this.input.down = down;
      else if (k === 'a' || k === 'arrowleft') this.input.left = down;
      else if (k === 'd' || k === 'arrowright') this.input.right = down;
      else if (k === ' ') this.input.fire = down;
      else if (down && k === 'r') this.onAct && this.onAct({ a: 'reload' });
      else if (down && k === 'g') this.onAct && this.onAct({ a: 'grenade' });
      else if (down && (k === 'shift')) this.onAct && this.onAct({ a: 'dash' });
      else if (down && k === 'q') this._cycleWeapon(-1);
      else if (down && /^[1-7]$/.test(k)) { const w = this.weaponOrder[+k - 1]; if (w) this.onAct && this.onAct({ a: 'switch', w }); }
      else return;
      e.preventDefault();
    },
    _cycleWeapon(dir) {
      const me = this._me(); if (!me) return;
      let i = this.weaponOrder.indexOf(me.weapon);
      i = (i + dir + this.weaponOrder.length) % this.weaponOrder.length;
      this.onAct && this.onAct({ a: 'switch', w: this.weaponOrder[i] });
    },
    _scroll(e) { this._cycleWeapon(e.deltaY > 0 ? 1 : -1); },

    _move(e) {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - r.left) / r.width * this.world.w;
      this.mouse.y = (e.clientY - r.top) / r.height * this.world.h;
    },

    _me() { return this.state.players.find((p) => p.id === this.mySid); },

    _sendInput() {
      const me = this._me();
      if (me) this.input.angle = Math.atan2(this.mouse.y - me.y, this.mouse.x - me.x);
      const packed = JSON.stringify(this.input);
      if (packed !== this._lastSent && this.onInput) { this._lastSent = packed; this.onInput(this.input); }
      else if (this.input.fire && this.onInput) this.onInput(this.input);
    },

    // ---- effects ----
    _burst(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = Math.random() * 220 + 40;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color, size: Math.random() * 3 + 1 });
      }
    },
    _explosion(x, y, r) {
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, sp = Math.random() * 380 + 60;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: i % 2 ? '#ff8c00' : '#ffd94a', size: Math.random() * 5 + 2 });
      }
      this.floaters.push({ x, y, ring: true, r: 0, maxR: r, life: 1 });
    },
    _melee(x, y, a) {
      this.floaters.push({ x, y, arc: a, life: 1, slash: true });
    },
    addFloater(x, y, text, color) { this.floaters.push({ x, y, text, color, life: 1, vy: -40 }); },

    _loop(ts) {
      if (!this.running) return;
      const dt = this._last ? Math.min(0.05, (ts - this._last) / 1000) : 0.016;
      this._last = ts;
      this._step(dt);
      this._draw();
      if (this.mctx) this._drawMini();
      requestAnimationFrame((t) => this._loop(t));
    },

    _step(dt) {
      for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt * 2.2; }
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const f of this.floaters) { f.life -= dt * (f.ring ? 2.5 : f.slash ? 6 : 1.4); if (f.vy) f.y += f.vy * dt; if (f.ring) f.r += (f.maxR - f.r) * dt * 12; }
      this.floaters = this.floaters.filter((f) => f.life > 0);
      if (this.shakes > 0) this.shakes = Math.max(0, this.shakes - dt * 30);
    },

    _draw() {
      const ctx = this.ctx, W = this.world.w, H = this.world.h;
      ctx.save();
      if (this.shakes > 0) ctx.translate((Math.random() - 0.5) * this.shakes, (Math.random() - 0.5) * this.shakes);

      ctx.fillStyle = '#10151f'; ctx.fillRect(-20, -20, W + 40, H + 40);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      // team spawn tint
      if (this.mode === 'tdm') {
        ctx.fillStyle = 'rgba(231,76,60,0.05)'; ctx.fillRect(0, 0, 220, H);
        ctx.fillStyle = 'rgba(78,161,255,0.05)'; ctx.fillRect(W - 220, 0, 220, H);
      }

      for (const o of this.obstacles) {
        ctx.fillStyle = '#2b3245'; ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = '#455072'; ctx.strokeRect(o.x + .5, o.y + .5, o.w - 1, o.h - 1);
      }

      for (const p of this.state.powerups) this._powerup(p);

      // bullets
      for (const b of this.state.bullets) {
        if (b.r) { ctx.fillStyle = '#ff8c00'; ctx.shadowColor = '#ff8c00'; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, 7); ctx.fill(); ctx.shadowBlur = 0; }
        else { ctx.fillStyle = '#ffd94a'; ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, 7); ctx.fill(); }
      }
      // grenades
      for (const g of this.state.grenades) {
        ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(g.x, g.y, 7, 0, 7); ctx.fill();
        ctx.strokeStyle = '#0b0e14'; ctx.stroke();
      }

      for (const p of this.state.players) this._player(p);

      // particles
      for (const p of this.particles) {
        ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // floaters (rings, slashes, damage text)
      for (const f of this.floaters) {
        ctx.globalAlpha = Math.max(0, f.life);
        if (f.ring) { ctx.strokeStyle = '#ff8c00'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.stroke(); }
        else if (f.slash) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(f.x, f.y, 40, f.arc - 0.7, f.arc + 0.7); ctx.stroke(); }
        else if (f.text) { ctx.fillStyle = f.color || '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(f.text, f.x, f.y); }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    _powerup(p) {
      const ctx = this.ctx, pulse = 1 + 0.12 * Math.sin(performance.now() / 250);
      const color = this._puColor(p.type);
      const label = { health: '+', shield: '🛡', damage: '⚔', speed: '»', ammo: '▮' }[p.type] || '?';
      ctx.save(); ctx.translate(p.x, p.y); ctx.scale(pulse, pulse);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(0, 0, 14, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#0b0e14'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 1); ctx.restore();
    },

    _player(p) {
      const ctx = this.ctx;
      if (!p.alive) return;
      const mine = p.id === this.mySid;
      ctx.save(); ctx.translate(p.x, p.y);

      // buff aura
      if (p.buffSpeed) { ctx.strokeStyle = 'rgba(241,196,64,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 24, 0, 7); ctx.stroke(); }
      if (p.buffDamage) { ctx.strokeStyle = 'rgba(231,76,60,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 27, 0, 7); ctx.stroke(); }
      if (p.shield > 0) { ctx.strokeStyle = 'rgba(78,161,255,0.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 22, 0, 7); ctx.stroke(); }

      ctx.save();
      ctx.rotate(p.angle);
      ctx.fillStyle = mine ? '#ffffff' : p.color; ctx.strokeStyle = p.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1a1f2b'; ctx.fillRect(10, -4, 22, 8);
      ctx.restore();

      // name + hp bar
      ctx.fillStyle = p.bot ? '#ff9ff3' : (mine ? '#fff' : '#e6ebf5');
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(p.name, 0, -30);
      ctx.fillStyle = '#000'; ctx.fillRect(-20, -26, 40, 5);
      ctx.fillStyle = p.hp > 50 ? '#2ecc71' : p.hp > 25 ? '#f1c40f' : '#e74c3c';
      ctx.fillRect(-20, -26, 40 * (p.hp / 100), 5);
      if (p.reloading) { ctx.fillStyle = '#f1c40f'; ctx.font = '10px sans-serif'; ctx.fillText('Nachladen…', 0, 40); }
      ctx.restore();
    },

    _drawMini() {
      const ctx = this.mctx, w = this.mini.width, h = this.mini.height;
      const sx = w / this.world.w, sy = h / this.world.h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#2b3245';
      for (const o of this.obstacles) ctx.fillRect(o.x * sx, o.y * sy, o.w * sx, o.h * sy);
      for (const p of this.state.powerups) { ctx.fillStyle = this._puColor(p.type); ctx.fillRect(p.x * sx - 1.5, p.y * sy - 1.5, 3, 3); }
      for (const p of this.state.players) {
        if (!p.alive) continue;
        ctx.fillStyle = p.id === this.mySid ? '#fff' : p.color;
        ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, p.id === this.mySid ? 3 : 2, 0, 7); ctx.fill();
      }
    }
  };

  window.SchooterGame = Game;
})();
