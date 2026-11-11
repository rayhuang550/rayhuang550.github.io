/* ASCII model tiles.
   Markup: <div class="t ascii" data-model="assets/models/fcil.bin" role="img" aria-label="..."></div>
   Optional: data-font, data-size, data-weight, data-phrase, data-start, data-tilt,
   data-rock (degrees: sway back and forth around data-start instead of spinning, for flat things),
   data-exposure (brightens the lighting) and data-floor (lightest glyph a solid surface may use,
   1 to 3; lower lets white things like paper read as light).
   2D instead of a mesh: data-art="id" names an element whose text is the drawing; everything but
   the outline (| _ / \) types itself out the first time it scrolls into view.
   The model spins slowly. Hovering (or focusing) the enclosing link turns its glyphs into green
   letters repeating the phrase (default "explore"), in a scrambling wave that spreads from where
   the pointer came in. The text is fixed to the grid, so the still-spinning model acts as a window
   onto it; glyph opacity keeps the shading. Leaving turns them back.
   Mesh format is written by _notes/tools/stl2bin.py. */
(() => {
  const RAMP = ' .:-=+*#';
  const SCRAMBLE = '/\\|_-=+*<>[]{}?!#%&$01';
  const FRAME = '|_/\\';   // 2D drawings: outline glyphs, shown at once; everything else types out
  const INK = '#111', ACC = '#0A6847';
  const MORPH = 0.8;      // seconds for the whole morph
  const STAGGER = 0.6;    // share of the morph the wave takes to cross the tile
  const SHIFT = 3;        // each row of phrase text starts this many columns further along
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const meshes = new Map();

  function loadMesh(url) {
    if (!meshes.has(url)) meshes.set(url, fetch(url).then(r => r.arrayBuffer()).then(parse));
    return meshes.get(url);
  }

  function parse(buf) {
    const dv = new DataView(buf);
    const nv = dv.getUint32(4, true), nt = dv.getUint32(8, true), s = dv.getFloat32(12, true);
    const q = new Int16Array(buf.slice(16, 16 + nv * 6));
    const pos = new Float32Array(nv * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = q[i] * s;
    const off = 16 + nv * 6;
    const ib = nv > 65535 ? 4 : 2;
    const idx = ib === 4 ? new Uint32Array(buf.slice(off, off + nt * 12))
                         : new Uint16Array(buf.slice(off, off + nt * 6));
    // 'A3D2' adds a brightness per triangle (dark parts get denser glyphs)
    const alb = new Float32Array(nt).fill(1);
    if (dv.getUint8(3) === 50) {
      const a = new Uint8Array(buf, off + nt * 3 * ib, nt);
      for (let i = 0; i < nt; i++) alb[i] = a[i] / 255;
    }
    let zmax = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < nv; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1];
      zmax = Math.max(zmax, pos[3 * i + 2]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { pos, idx, alb, nv, nt, zmax, mid: [(x0 + x1) / 2, (y0 + y1) / 2] };
  }

  // radius of the spin sweep around axis (ax, ay)
  function sweep(m, ax, ay) {
    let r = 0;
    for (let i = 0; i < m.nv; i++) r = Math.max(r, Math.hypot(m.pos[3 * i] - ax, m.pos[3 * i + 1] - ay));
    return r;
  }

  class Tile {
    constructor(el) {
      this.el = el;
      const d = el.dataset;
      this.font = d.font || 'JetBrains Mono';
      this.size = +d.size || 9;              // font size, CSS px
      this.weight = d.weight || 400;
      this.squeeze = +d.squeeze || 0.86;     // cell width / glyph advance (tight, like the reference)
      this.lead = +d.lead || 1.0;            // cell height / font size
      this.tilt = (d.tilt != null ? +d.tilt : 8) * Math.PI / 180;
      this.axis = d.axis || 'center';        // 'center' of the footprint box, or 'base' (x=y=0)
      this.angle = this.base = (+d.start || 0) * Math.PI / 180;
      this.rock = (+d.rock || 0) * Math.PI / 180;
      this.exposure = +d.exposure || 1;
      this.floor = +d.floor || 3;
      this.phase = 0;
      this.speed = reduce ? 0 : (+d.speed || (this.rock ? 0.6 : 0.475));  // rad/s, about 13 s a turn
      if (d.art) {
        const lines = document.getElementById(d.art).textContent.replace(/\t/g, '  ').split('\n');
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
        this.art = lines.map(l => l.slice(indent).replace(/\s+$/, ''));
        this.artW = Math.max(...this.art.map(l => l.length));
        this.artH = this.art.length;
        this.typed = reduce ? Infinity : 0;   // letters typed so far
      }
      this.phrase = (d.phrase || 'explore').toLowerCase() + ' ';   // repeats with a space between
      this.M = 0;            // morph progress, 0 = model, 1 = letters
      this.goal = 0;
      this.entry = null;     // where the pointer crossed into the tile; the wave starts there
      this.visible = true;
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('aria-hidden', 'true');
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');

      const link = this.link = el.closest('a') || el;
      link.addEventListener('pointerenter', e => e.pointerType !== 'touch' && this.hover(1, e));
      link.addEventListener('pointerleave', e => e.pointerType !== 'touch' && this.hover(0, e));
      link.addEventListener('focus', () => this.hover(1));
      link.addEventListener('blur', () => this.hover(0));
    }

    async init() {
      if (!this.art) {
        this.mesh = await loadMesh(this.el.dataset.model);
        [this.ax, this.ay] = this.axis === 'base' ? [0, 0] : this.mesh.mid;
        this.r = sweep(this.mesh, this.ax, this.ay);
      }
      await document.fonts.load(`${this.weight} ${this.size}px "${this.font}"`).catch(() => {});
      this.layout();
      new ResizeObserver(() => this.layout()).observe(this.el);
      new IntersectionObserver(es => { this.visible = es[0].isIntersecting; }).observe(this.el);
      tiles.push(this);
      if (tiles.length === 1) requestAnimationFrame(loop);
      if (this.link.matches(':hover')) this.hover(1);   // pointer was already there at load
    }

    layout() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h || !(this.mesh || this.art)) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      const ctx = this.ctx;
      if (this.art) {
        // pick the font size that fits the drawing, with a cell of margin
        ctx.font = `${this.weight} 100px "${this.font}"`;
        const a = ctx.measureText('0').width / 100;
        this.size = Math.min(+this.el.dataset.size || 13,
          w / ((this.artW + 2) * a * this.squeeze), h / ((this.artH + 2) * this.lead));
      }
      ctx.font = `${this.weight} ${this.size}px "${this.font}"`;
      const adv = ctx.measureText('0').width;
      this.cw = adv * this.squeeze;
      this.ch = this.size * this.lead;
      this.cols = Math.floor(w / this.cw);
      this.rows = Math.floor(h / this.ch);
      this.ox = (w - this.cols * this.cw) / 2;
      this.oy = (h - this.rows * this.ch) / 2;
      this.sx = 2;
      this.sy = Math.max(2, Math.round(2 * this.ch / this.cw));
      this.W = this.cols * this.sx; this.H = this.rows * this.sy;
      if (this.mesh) {
        this.depth = new Float32Array(this.W * this.H);
        this.shade = new Float32Array(this.W * this.H);
        this.level = new Uint8Array(this.cols * this.rows);
        const nv = this.mesh.nv;
        this.vx = new Float32Array(nv); this.vy = new Float32Array(nv);
        this.vz = new Float32Array(nv); this.vd = new Float32Array(nv);
      } else {
        this.ac = Math.floor((this.cols - this.artW) / 2);
        this.ar = Math.floor((this.rows - this.artH) / 2);
      }

      // glyph atlas: one slot per character, two colours
      const chars = [...new Set(RAMP + SCRAMBLE + '_' + this.phrase + (this.art ? this.art.join('') : ''))];
      this.slot = new Map(chars.map((c, i) => [c, i]));
      this.sw = Math.ceil(adv * dpr) + 2;
      this.sh = Math.ceil(this.size * 1.5 * dpr);
      const atlas = document.createElement('canvas');
      atlas.width = this.sw * chars.length; atlas.height = this.sh * 2;
      const a = atlas.getContext('2d');
      a.font = `${this.weight} ${this.size * dpr}px "${this.font}"`;
      a.textAlign = 'center'; a.textBaseline = 'middle';
      chars.forEach((c, i) => {
        a.fillStyle = INK; a.fillText(c, (i + 0.5) * this.sw, this.sh * 0.5);
        a.fillStyle = ACC; a.fillText(c, (i + 0.5) * this.sw, this.sh * 1.5);
      });
      this.atlas = atlas;

      if (this.mesh && this.rock) this.fitRock(w, h);
      else if (this.mesh) {
        // fit the full spin sweep
        const m = this.mesh, ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
        const top = m.zmax * ct + this.r * st, bot = -this.r * st;
        const kx = (w * 0.94) / (2 * this.r), ky = (h * 0.94) / (top - bot);
        this.k = Math.min(kx, ky);
        this.cx = w / 2;
        this.cy = h / 2 + ((top + bot) / 2) * this.k;
      }

      this.jit = Float32Array.from({ length: this.cols * this.rows }, Math.random);   // wave jitter per cell
      this.draw(performance.now());
    }

    // swaying models: fit the screen box the model covers over the whole sway
    fitRock(w, h) {
      const { pos, nv } = this.mesh, ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
      let x0 = 1e9, x1 = -1e9, u0 = 1e9, u1 = -1e9;
      for (let s = 0; s <= 12; s++) {
        const a = this.base + this.rock * Math.sin((s / 12) * 2 * Math.PI - Math.PI / 2);
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0; i < nv; i++) {
          const x = pos[3 * i] - this.ax, y = pos[3 * i + 1] - this.ay, z = pos[3 * i + 2];
          const xr = x * ca - y * sa, up = z * ct + (x * sa + y * ca) * st;
          if (xr < x0) x0 = xr; if (xr > x1) x1 = xr;
          if (up < u0) u0 = up; if (up > u1) u1 = up;
        }
      }
      this.k = Math.min((w * 0.94) / (x1 - x0), (h * 0.94) / (u1 - u0));
      this.cx = w / 2 - ((x0 + x1) / 2) * this.k;
      this.cy = h / 2 + ((u0 + u1) / 2) * this.k;
    }

    // 2D drawing: glyphs of the current frame, typed letters only
    artCells() {
      const out = [];
      let n = 0, last = null;
      this.art.forEach((line, r) => {
        for (let c = 0; c < line.length; c++) {
          const g = line[c];
          if (g === ' ') continue;
          if (!FRAME.includes(g)) { if (n++ >= this.typed) continue; last = [c, r]; }
          out.push({ c: this.ac + c, r: this.ar + r, g });
        }
      });
      this.letters = n;
      // cursor while typing
      if (this.typed < n && last && (performance.now() / 250 | 0) % 2)
        out.push({ c: this.ac + last[0] + 1, r: this.ar + last[1], g: '_' });
      return out;
    }

    hover(on, e) {
      if (on === this.goal) return;
      this.goal = on;
      if (on && this.art) this.typed = Infinity;   // coming back from the letters, the page is fully written
      // a fresh wave starts where the pointer crossed the edge; mid-wave reversals keep their origin
      if (this.M === 0 || this.M === 1) {
        const r0 = this.el.getBoundingClientRect();
        this.entry = e && e.clientX != null ? [e.clientX - r0.left, e.clientY - r0.top] : null;
      }
    }

    raster() {
      const m = this.mesh, { pos, idx, alb, nv, nt } = m;
      const { W, H, depth, shade, vx, vy, vz, vd } = this;
      depth.fill(1e9); shade.fill(0);
      const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
      const ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
      const fx = this.k * this.sx / this.cw, fy = this.k * this.sy / this.ch;
      const cx = (this.cx - this.ox) * this.sx / this.cw, cy = (this.cy - this.oy) * this.sy / this.ch;
      for (let i = 0; i < nv; i++) {
        const x = pos[3 * i] - this.ax, y = pos[3 * i + 1] - this.ay, z = pos[3 * i + 2];
        const xr = x * ca - y * sa, yr = x * sa + y * ca;
        const up = z * ct + yr * st, d = yr * ct - z * st;   // camera looks along +d
        vx[i] = cx + xr * fx; vy[i] = cy - up * fy;
        vz[i] = up; vd[i] = d;
      }
      // light from upper left, slightly in front
      const lx = -0.45, lu = 0.62, ld = -0.64;
      for (let t = 0; t < nt; t++) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b], qx = vx[c], qy = vy[c];
        const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
        if (area === 0) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, qy)));
        if (x0 > x1 || y0 > y1) continue;
        // flat normal in view space (x right, up, d into screen), two-sided
        const e1x = (bx - ax) / fx, e1u = vz[b] - vz[a], e1d = vd[b] - vd[a];
        const e2x = (qx - ax) / fx, e2u = vz[c] - vz[a], e2d = vd[c] - vd[a];
        let nx = e1u * e2d - e1d * e2u, nu = e1d * e2x - e1x * e2d, nd = e1x * e2u - e1u * e2x;
        const nl = Math.hypot(nx, nu, nd) || 1;
        if (nd > 0) { nx = -nx; nu = -nu; nd = -nd; }
        const lam = Math.max(0, (nx * lx + nu * lu + nd * ld) / nl);
        const rim = Math.pow(1 - Math.abs(nd / nl), 3);
        const lit = Math.min(1, 0.18 + 0.82 * lam + 0.25 * rim) * alb[t] * this.exposure;
        const inv = 1 / area, da = vd[a], db = vd[b], dc = vd[c];
        for (let y = y0; y <= y1; y++) {
          const py = y + 0.5;
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const w0 = ((bx - px) * (qy - py) - (by - py) * (qx - px)) * inv;
            const w1 = ((qx - px) * (ay - py) - (qy - py) * (ax - px)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * da + w1 * db + w2 * dc;
            const o = y * W + x;
            if (z < depth[o]) { depth[o] = z; shade[o] = lit; }
          }
        }
      }
    }

    // ramp level per cell (0 = empty) from the sample buffers
    resolve() {
      const { cols, rows, sx, sy, W, depth, shade, level } = this;
      const L = RAMP.length - 1, n = sx * sy;
      for (let r = 0, i = 0; r < rows; r++)
        for (let c = 0; c < cols; c++, i++) {
          let cov = 0, sum = 0;
          for (let j = 0; j < sy; j++) {
            const row = (r * sy + j) * W + c * sx;
            for (let k = 0; k < sx; k++) if (depth[row + k] < 1e9) { cov++; sum += shade[row + k]; }
          }
          if (cov < 2) { level[i] = 0; continue; }
          const f = cov / n, dark = (0.3 + 0.7 * (1 - sum / cov)) * Math.sqrt(f);
          level[i] = Math.max(f > 0.5 ? this.floor : 1, Math.min(L, Math.round(dark * L)));
        }
    }

    glyph(g, col, alpha, x, y) {
      const { ctx, dpr, sw, sh } = this;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.atlas, this.slot.get(g) * sw, col * sh, sw, sh,
        Math.round((this.ox + (x + 0.5) * this.cw) * dpr - sw / 2),
        Math.round((this.oy + (y + 0.5) * this.ch) * dpr - sh / 2), sw, sh);
    }

    // glyphs of the current frame: cell, ramp glyph and shading (0 light to 1 dark)
    cells() {
      if (this.art) return this.artCells().map(p => ({ c: p.c, r: p.r, g: p.g, v: 1 }));
      this.raster();
      this.resolve();
      const out = [], L = RAMP.length - 1;
      for (let r = 0, i = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++, i++)
          if (this.level[i]) out.push({ c, r, g: RAMP[this.level[i]], v: this.level[i] / L });
      return out;
    }

    draw(now) {
      if (!this.cols) return;
      const { ctx, cols, rows, cw, ch, M, phrase: P } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const [ex, ey] = this.entry || [this.ox + cols * cw / 2, this.oy + rows * ch / 2];
      const far = Math.hypot(cols * cw, rows * ch), n = P.length;
      for (const p of this.cells()) {
        // this cell's own progress: the wave reaches it later the farther it is from the entry point
        let t = M;
        if (M > 0 && M < 1) {
          const near = Math.hypot(this.ox + (p.c + 0.5) * cw - ex, this.oy + (p.r + 0.5) * ch - ey) / far;
          const d = Math.min(1, near * 1.3 * 0.75 + (this.jit[p.r * cols + p.c] || 0) * 0.25);
          t = Math.max(0, Math.min(1, (M - d * STAGGER) / (1 - STAGGER)));
        }
        if (t === 0) this.glyph(p.g, 0, 1, p.c, p.r);
        else if (t === 1) {
          const g = P[(((p.c + p.r * SHIFT) % n) + n) % n];
          if (g === ' ') this.glyph('.', 1, 0.35, p.c, p.r);   // keeps the silhouette whole between words
          else this.glyph(g, 1, 0.25 + 0.75 * p.v, p.c, p.r);
        } else this.glyph(SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0], t > 0.5 ? 1 : 0, 1, p.c, p.r);
      }
      ctx.globalAlpha = 1;
    }

    // advance morph and spin; true while the morph is running, which wants 60 fps
    step(dt) {
      const morphing = this.M !== this.goal;
      if (morphing) this.M = reduce ? this.goal : Math.max(0, Math.min(1, this.M + (this.goal ? dt : -dt) / MORPH));
      if (this.art) {
        if (this.visible && this.typed < this.letters) this.typed += dt * 70;   // letters per second
        return morphing;
      }
      if (this.rock) {
        this.phase += this.speed * dt;
        this.angle = this.base + this.rock * Math.sin(this.phase);
      } else this.angle += this.speed * dt;
      return morphing;
    }
  }

  const tiles = window.asciiTiles = [];
  let last = performance.now(), fast = false;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!fast && now - last < 31) return;   // ~30 fps while idle, full rate while morphing
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    fast = false;
    for (const t of tiles) {
      if (t.step(dt)) fast = true;
      if (t.visible) t.draw(now);
    }
  }

  function start() { document.querySelectorAll('.ascii[data-model], .ascii[data-art]').forEach(el => new Tile(el).init()); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
