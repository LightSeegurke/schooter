/* Client-side rendering + input for the arena. Server is authoritative;
   this module draws snapshots and reports the local input state upstream. */
(function () {
  'use strict';

  const OBSTACLES = [
    { x: 380, y: 180, w: 180, h: 40 }, { x: 1040, y: 180, w: 180, h: 40 },
    { x: 720, y: 120, w: 160, h: 160 }, { x: 200, y: 430, w: 40, h: 200 },
    { x: 1360, y: 430, w: 40, h: 200 }, { x: 700, y: 620, w: 200, h: 40 },
    { x: 380, y: 680, w: 180, h: 40 }, { x: 1040, y: 680, w: 180, h: 40 },
    { x: 720, y: 400, w: 160, h: 120 }
  ];

  const Game = {
    canvas: null, ctx: null, world: { w: 1600, h: 900 },
    state: { players: [], bullets: [], powerups: [] },
    input: { up: false, down: false, left: false, right: false, fire: false, angle: 0 },
    mySid: null, running: false, onInput: null, mouse: { x: 0, y: 0 },
    flashes: [],

    start(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = opts.world || this.world;
      this.mySid = opts.mySid;
      this.onInput = opts.onInput;
      this.running = true;
      this._bind();
      this._lastSent = '';
      requestAnimationFrame(() => this._loop());
      this._inputTimer = setInterval(() => this._sendInput(), 1000 / 30);
    },

    stop() {
      this.running = false;
      this._unbind();
      clearInterval(this._inputTimer);
    },

    setState(s) { this.state = s; if (s.world) this.world = s.world; },
    setMySid(sid) { this.mySid = sid; },
    addFlash(x, y, color) { this.flashes.push({ x, y, color, t: performance.now() }); },

    _bind() {
      this._kd = (e) => this._key(e, true);
      this._ku = (e) => this._key(e, false);
      this._mm = (e) => this._move(e);
      this._md = () => { this.input.fire = true; };
      this._mu = () => { this.input.fire = false; };
      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup', this._ku);
      this.canvas.addEventListener('mousemove', this._mm);
      this.canvas.addEventListener('mousedown', this._md);
      window.addEventListener('mouseup', this._mu);
    },
    _unbind() {
      window.removeEventListener('keydown', this._kd);
      window.removeEventListener('keyup', this._ku);
      this.canvas.removeEventListener('mousemove', this._mm);
      this.canvas.removeEventListener('mousedown', this._md);
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
      else return;
      e.preventDefault();
    },

    _move(e) {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * this.world.w;
      const y = (e.clientY - r.top) / r.height * this.world.h;
      this.mouse = { x, y };
    },

    _me() { return this.state.players.find((p) => p.id === this.mySid); },

    _sendInput() {
      const me = this._me();
      if (me) this.input.angle = Math.atan2(this.mouse.y - me.y, this.mouse.x - me.x);
      const packed = JSON.stringify(this.input);
      if (packed !== this._lastSent && this.onInput) {
        this._lastSent = packed;
        this.onInput(this.input);
      } else if (this.input.fire && this.onInput) {
        this.onInput(this.input); // keep firing while held
      }
    },

    _loop() {
      if (!this.running) return;
      this._draw();
      requestAnimationFrame(() => this._loop());
    },

    _draw() {
      const ctx = this.ctx;
      const W = this.world.w, H = this.world.h;
      ctx.clearRect(0, 0, W, H);

      // floor grid
      ctx.fillStyle = '#10151f';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      // obstacles
      for (const o of OBSTACLES) {
        ctx.fillStyle = '#2b3245';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = '#455072';
        ctx.strokeRect(o.x + .5, o.y + .5, o.w - 1, o.h - 1);
      }

      // powerups
      for (const p of this.state.powerups) {
        this._powerup(p);
      }

      // bullets
      ctx.fillStyle = '#ffd94a';
      for (const b of this.state.bullets) {
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
      }

      // muzzle flashes
      const now = performance.now();
      this.flashes = this.flashes.filter((f) => now - f.t < 120);
      for (const f of this.flashes) {
        const a = 1 - (now - f.t) / 120;
        ctx.fillStyle = `rgba(255,200,80,${a})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, 22 * a, 0, Math.PI * 2); ctx.fill();
      }

      // players
      for (const p of this.state.players) this._player(p);
    },

    _powerup(p) {
      const ctx = this.ctx;
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 250);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(pulse, pulse);
      let color = '#2ecc71', label = '+';
      if (p.type === 'rifle') { color = '#4ea1ff'; label = 'R'; }
      else if (p.type === 'shotgun') { color = '#e67e22'; label = 'S'; }
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#0b0e14'; ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 1);
      ctx.restore();
    },

    _player(p) {
      const ctx = this.ctx;
      if (!p.alive) return;
      ctx.save();
      ctx.translate(p.x, p.y);

      // body
      ctx.rotate(p.angle);
      ctx.fillStyle = p.id === this.mySid ? '#ffffff' : p.color;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // gun barrel
      ctx.fillStyle = '#1a1f2b';
      ctx.fillRect(10, -4, 22, 8);
      ctx.restore();

      // name + hp bar
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = '#e6ebf5';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, 0, -30);
      // hp
      ctx.fillStyle = '#000';
      ctx.fillRect(-20, -26, 40, 5);
      ctx.fillStyle = p.hp > 50 ? '#2ecc71' : p.hp > 25 ? '#f1c40f' : '#e74c3c';
      ctx.fillRect(-20, -26, 40 * (p.hp / 100), 5);
      ctx.restore();
    }
  };

  window.SchooterGame = Game;
})();
