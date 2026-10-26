// 🎮 Scoop Stack: tap to drop the swinging scoop onto the tower. If it lands
// off-centre the overhang melts off, so the next scoop is narrower; miss it
// completely and you're brainless. Pure canvas, drawn in the same style as art.js.
// The page (app.js) owns the HUD, sounds and API; this only draws the game and
// reports what happened through onEvent(type, data).
(function () {
  const INK = '#5A3A2E';
  const BLUSH = '#FF8FB1';
  const LAYER = 30; // px between scoops
  const SCOOP_H = 42; // drawn height: the drips hang over the scoop below
  const PERFECT_PX = 8; // this close to centre counts as perfect (no melt)
  const GROW_PX = 14; // 3 perfects in a row grow the scoop back a little
  const SPAWN_LOCK_MS = 120; // a double tap can't drop two scoops at once
  const GRAVITY = 2600;
  const SPRINKLE_COLORS = ['#FF7FA8', '#7FD9C4', '#B79CFF', '#FFC94D', '#ffffff'];
  // Sky colour by tower height (in scoops): vanilla → strawberry milk → lavender → sky → night.
  const SKY = [[0, '#FFF6E5'], [15, '#FFE3EC'], [35, '#EFE6FF'], [60, '#D7EEFF'], [90, '#3B3570'], [130, '#1E1B40']];

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function skyAt(level) {
    if (level <= SKY[0][0]) return SKY[0][1];
    for (let i = 1; i < SKY.length; i++) {
      const [l1, c1] = SKY[i];
      const [l0, c0] = SKY[i - 1];
      if (level <= l1) {
        const k = (level - l0) / (l1 - l0);
        const a = hex(c0);
        const b = hex(c1);
        return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(',')})`;
      }
    }
    return SKY[SKY.length - 1][1];
  }
  // Small deterministic random numbers, so a scoop's sprinkles don't jump around.
  const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  window.ScoopStack = function (canvas, { flavours, marks = [], onEvent = () => {} }) {
    const ctx = canvas.getContext('2d');
    let W = 0;
    let H = 0;
    let cx = 0;
    let baseY = 0; // y of the cone's rim (world coordinates)
    let startW = 130;
    let range = 0; // how far the swinging scoop travels from the centre

    let mode = 'ready'; // ready → play ⇄ fall → miss → over
    let tower = []; // landed scoops, bottom first: { x, w, f, seed, squash }
    let mover = null; // the swinging/falling scoop
    let pieces = []; // melted-off overhangs and missed scoops, falling away
    let sparks = [];
    let flash = null;
    let camY = 0;
    let jiggle = 0;
    let shake = 0;
    let combo = 0;
    let side = 1;
    let t0 = 0;
    let spawnedAt = 0;
    let lastFlavour = null;
    let raf = 0;
    let last = 0;
    let time = 0;

    const score = () => tower.length;
    const topW = () => (tower.length ? tower[tower.length - 1].w : startW);
    const topX = () => (tower.length ? tower[tower.length - 1].x : cx);
    const speed = () => Math.min(110 + score() * 4, 320); // px per second
    const hoverY = () => baseY - score() * LAYER - LAYER * 2.4 - SCOOP_H; // top of the swinging scoop

    function pickFlavour() {
      let f;
      do f = flavours[Math.floor(Math.random() * flavours.length)];
      while (flavours.length > 1 && f === lastFlavour);
      lastFlavour = f;
      return f;
    }

    function spawn() {
      side = -side;
      mover = { x: cx + side * range, y: hoverY(), w: topW(), f: pickFlavour(), dir: -side, vy: 0, seed: (Math.random() * 1e9) | 0 };
      spawnedAt = performance.now();
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const oldCx = cx;
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2;
      startW = Math.min(160, Math.max(110, W * 0.4));
      baseY = H - startW * 0.95 - 26;
      range = Math.min(W * 0.5 - 14, 230);
      // Keep everything centred if the screen size changed mid-game.
      const shift = oldCx ? cx - oldCx : 0;
      tower.forEach((s) => { s.x += shift; });
      if (mover) mover.x += shift;
    }

    function reset() {
      tower = [];
      pieces = [];
      sparks = [];
      flash = null;
      combo = 0;
      camY = 0;
      jiggle = 0;
      shake = 0;
      spawn();
    }

    // ---- input ----
    function start() {
      reset();
      mode = 'play';
      t0 = performance.now();
    }

    function drop() {
      if (mode !== 'play' || performance.now() - spawnedAt < SPAWN_LOCK_MS) return false;
      mode = 'fall';
      mover.vy = 0;
      return true;
    }

    // ---- the moment a scoop lands ----
    function land() {
      const tw = topW();
      const tx = topX();
      const left = Math.max(mover.x - mover.w / 2, tx - tw / 2);
      const right = Math.min(mover.x + mover.w / 2, tx + tw / 2);
      const overlap = right - left;

      if (overlap <= 0) {
        // Missed the tower completely: it tumbles away.
        mode = 'miss';
        pieces.push({ ...mover, top: mover.y, vx: Math.sign(mover.x - tx) * 140, vy: 200, rot: 0, vr: Math.sign(mover.x - tx) * 4 });
        mover = null;
        shake = 1;
        combo = 0;
        const ms = Math.round(performance.now() - t0);
        onEvent('miss', { score: score() });
        setTimeout(() => {
          if (mode !== 'miss') return;
          mode = 'over';
          onEvent('over', { score: score(), ms });
        }, 1000);
        return;
      }

      const dx = mover.x - tx;
      const perfect = Math.abs(dx) <= PERFECT_PX;
      let x;
      let w;
      let grew = false;
      if (perfect) {
        combo++;
        x = tx;
        w = mover.w;
        if (combo >= 3 && w < startW) {
          w = Math.min(startW, w + GROW_PX);
          grew = true;
        }
        flash = { life: 1 };
        for (let i = 0; i < 10; i++) {
          const s = i % 2 ? 1 : -1;
          sparks.push({ x: x + s * (w / 2), y: baseY - (score() + 1) * LAYER, vx: s * (60 + Math.random() * 160), vy: -80 - Math.random() * 220, life: 1, c: SPRINKLE_COLORS[i % SPRINKLE_COLORS.length] });
        }
      } else {
        combo = 0;
        x = (left + right) / 2;
        w = overlap;
        // The overhang melts off and drips away.
        const cutW = mover.w - overlap;
        const cutX = dx > 0 ? right + cutW / 2 : left - cutW / 2;
        pieces.push({ x: cutX, w: cutW, f: mover.f, seed: mover.seed, top: baseY - (score() + 1) * LAYER - (SCOOP_H - LAYER), vx: Math.sign(dx) * 70, vy: 40, rot: 0, vr: Math.sign(dx) * 3 });
      }
      tower.push({ x, w, f: mover.f, seed: mover.seed, squash: 1 });
      jiggle = Math.min(1, 0.4 + Math.abs(dx) / 40);
      onEvent('land', { score: score(), perfect, combo, grew, mark: marks.find((m) => m.at === score()) || null });
      mover = null;
      mode = 'play';
      spawn();
    }

    // ---- per-frame update ----
    function update(dt) {
      time += dt;
      if (mover && (mode === 'play' || mode === 'ready')) {
        const v = mode === 'ready' ? 120 : speed();
        mover.x += mover.dir * v * dt;
        if (mover.x > cx + range) { mover.x = cx + range; mover.dir = -1; }
        if (mover.x < cx - range) { mover.x = cx - range; mover.dir = 1; }
        mover.y = hoverY() + Math.sin(time * 5) * 2;
      }
      if (mover && mode === 'fall') {
        mover.vy += GRAVITY * dt;
        mover.y += mover.vy * dt;
        const restTop = baseY - (score() + 1) * LAYER - (SCOOP_H - LAYER);
        if (mover.y >= restTop) {
          mover.y = restTop;
          land();
        }
      }
      pieces.forEach((p) => {
        p.vy += GRAVITY * 0.6 * dt;
        p.top += p.vy * dt;
        p.x += p.vx * dt;
        p.rot += p.vr * dt;
      });
      pieces = pieces.filter((p) => p.top + camY < H + 200);
      sparks.forEach((s) => {
        s.vy += 900 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt * 1.6;
      });
      sparks = sparks.filter((s) => s.life > 0);
      tower.forEach((s) => { s.squash = Math.max(0, s.squash - dt * 5); });
      if (flash) {
        flash.life -= dt * 2.5;
        if (flash.life <= 0) flash = null;
      }
      jiggle = Math.max(0, jiggle - dt * 1.8);
      shake = Math.max(0, shake - dt * 1.5);
      // Camera: keep the swinging scoop about a third of the way down the screen.
      const target = Math.max(0, H * 0.3 - (hoverY() - 0));
      camY += (target - camY) * Math.min(1, dt * 5);
    }

    // ---- drawing ----
    function scoopPath(x, top, w, h) {
      const l = x - w / 2;
      const r = x + w / 2;
      const bodyB = top + h * 0.7;
      const rad = Math.min(h * 0.62, w / 2);
      ctx.beginPath();
      ctx.moveTo(l, bodyB);
      ctx.lineTo(l, top + rad);
      ctx.arcTo(l, top, l + rad, top, rad);
      ctx.lineTo(r - rad, top);
      ctx.arcTo(r, top, r, top + rad, rad);
      ctx.lineTo(r, bodyB);
      // Drippy bottom edge, right to left.
      const n = Math.max(1, Math.round(w / 24));
      const step = w / n;
      for (let i = 0; i < n; i++) {
        const xa = r - i * step;
        const xb = xa - step;
        const deep = h * (i % 2 ? 0.2 : 0.32);
        ctx.bezierCurveTo(xa - step * 0.05, bodyB + deep, xb + step * 0.05, bodyB + deep, xb, bodyB);
      }
      ctx.closePath();
    }

    function drawScoop(s, top, { face, squash = 0 } = {}) {
      const { x, w, f } = s;
      const h = SCOOP_H;
      ctx.save();
      if (squash) {
        const py = top + h * 0.7;
        ctx.translate(x, py);
        ctx.scale(1 + 0.12 * squash, 1 - 0.18 * squash);
        ctx.translate(-x, -py);
      }
      scoopPath(x, top, w, h);
      ctx.fillStyle = f.color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK;
      ctx.stroke();
      // Shine.
      if (w > 18) {
        ctx.fillStyle = 'rgba(255,255,255,.65)';
        ctx.beginPath();
        ctx.ellipse(x - w / 2 + Math.min(w * 0.2, 16), top + 10, Math.min(w * 0.1, 8), 4, -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Sprinkles / specks, seeded so they stay put.
      const rnd = seeded(s.seed || 1);
      const n = Math.min(6, Math.floor(w / 18));
      if (f.sprinkles) {
        for (let i = 0; i < n; i++) {
          const px = x - w / 2 + 8 + rnd() * Math.max(0, w - 16);
          const py = top + 8 + rnd() * h * 0.42;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(rnd() * Math.PI);
          ctx.fillStyle = SPRINKLE_COLORS[i % SPRINKLE_COLORS.length];
          ctx.beginPath();
          ctx.roundRect(-3.5, -1.3, 7, 2.6, 1.3);
          ctx.fill();
          ctx.restore();
        }
      } else if (f.specks) {
        ctx.fillStyle = '#6B4433';
        for (let i = 0; i < n; i++) {
          ctx.beginPath();
          ctx.arc(x - w / 2 + 8 + rnd() * Math.max(0, w - 16), top + 8 + rnd() * h * 0.42, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (face && w > 46) drawFace(x, top + h * 0.38, Math.min(0.8, w / 120), face);
      ctx.restore();
    }

    function drawFace(x, y, s, expr) {
      const dx = 13 * s;
      ctx.save();
      ctx.fillStyle = BLUSH;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.ellipse(x - dx - 7 * s, y + 6 * s, 4.6 * s, 2.8 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(x + dx + 7 * s, y + 6 * s, 4.6 * s, 2.8 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = INK;
      ctx.strokeStyle = INK;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.6 * s;
      const blink = expr === 'happy' && time % 3.4 < 0.12;
      for (const ex of [x - dx, x + dx]) {
        ctx.beginPath();
        if (expr === 'closed' || expr === 'yum' || blink) {
          ctx.moveTo(ex - 4 * s, y + 2 * s);
          ctx.quadraticCurveTo(ex, y - 4 * s, ex + 4 * s, y + 2 * s);
          ctx.stroke();
        } else {
          const r = expr === 'shocked' ? 4.6 * s : 0;
          if (r) ctx.arc(ex, y, r, 0, Math.PI * 2);
          else ctx.ellipse(ex, y, 3.4 * s, 4.2 * s, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(ex + 1.3 * s, y - 1.7 * s, 1.3 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = INK;
        }
      }
      ctx.beginPath();
      if (expr === 'shocked') {
        ctx.ellipse(x, y + 9 * s, 3 * s, 3.8 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (expr === 'closed' || expr === 'yum') {
        ctx.moveTo(x - 5 * s, y + 6 * s);
        ctx.quadraticCurveTo(x, y + 12 * s, x + 5 * s, y + 6 * s);
        ctx.closePath();
        ctx.fill();
        if (expr === 'yum') {
          ctx.fillStyle = BLUSH;
          ctx.beginPath();
          ctx.ellipse(x + 2 * s, y + 9.5 * s, 2.2 * s, 2.4 * s, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.lineWidth = 2.2 * s;
        ctx.moveTo(x - 4 * s, y + 7 * s);
        ctx.quadraticCurveTo(x - 2 * s, y + 10 * s, x, y + 7.5 * s);
        ctx.quadraticCurveTo(x + 2 * s, y + 10 * s, x + 4 * s, y + 7 * s);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawCone() {
      const w = startW + 8;
      const h = startW * 0.95;
      const top = baseY + camY + 4;
      const l = cx - w / 2;
      const r = cx + w / 2;
      const tip = top + h;
      const outline = () => {
        ctx.beginPath();
        ctx.moveTo(l, top);
        ctx.quadraticCurveTo(cx, top - 7, r, top);
        ctx.lineTo(cx + 6, tip - 8);
        ctx.quadraticCurveTo(cx, tip + 4, cx - 6, tip - 8);
        ctx.closePath();
      };
      ctx.save();
      outline();
      ctx.fillStyle = '#F7CD96';
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(229,168,103,.55)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let d = -h; d < w + h; d += 15) {
        ctx.moveTo(l + d, top - 10);
        ctx.lineTo(l + d + h, tip + 10);
        ctx.moveTo(l + d + h, top - 10);
        ctx.lineTo(l + d, tip + 10);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#E5A867';
      ctx.beginPath();
      ctx.ellipse(cx, top + 1, w / 2 - 3, 5.5, 0, 0, Math.PI * 2);
      ctx.fill();
      outline();
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK;
      ctx.stroke();
      drawFace(cx, top + h * 0.33, 0.95, mode === 'miss' || mode === 'over' ? 'shocked' : 'happy');
    }

    function drawBackground() {
      const levelTop = (baseY + camY) / LAYER;
      const levelBottom = (baseY + camY - H) / LAYER;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, skyAt(levelTop));
      g.addColorStop(1, skyAt(Math.max(0, levelBottom)));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // Floating sprinkles (stars once it gets dark), with a little parallax.
      const night = Math.max(0, Math.min(1, (levelTop - 80) / 30));
      const tile = 170;
      const off = camY * 0.5;
      const first = Math.floor(-off / tile) - 1;
      for (let k = first; k < first + Math.ceil(H / tile) + 3; k++) {
        const rnd = seeded(Math.abs(k * 7919) + 13);
        for (let i = 0; i < 3; i++) {
          const x = rnd() * W;
          const y = k * tile + rnd() * tile + off;
          const rot = rnd() * Math.PI;
          ctx.save();
          ctx.translate(x, y);
          if (night > 0 && i < 2) {
            ctx.globalAlpha = 0.8 * night;
            ctx.fillStyle = '#FFF6C8';
            ctx.beginPath();
            ctx.arc(0, 0, 1.6 + rnd() * 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 0.45 * (1 - night);
          ctx.rotate(rot);
          ctx.fillStyle = SPRINKLE_COLORS[(k + i + 99) % 4];
          ctx.beginPath();
          ctx.roundRect(-7, -2.5, 14, 5, 2.5);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    function drawMarks() {
      ctx.save();
      ctx.font = '600 13px Fredoka, ui-rounded, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const m of marks) {
        const y = baseY - m.at * LAYER + camY;
        if (y < -20 || y > H + 20) continue;
        const reached = score() >= m.at;
        ctx.setLineDash([7, 7]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = reached ? 'rgba(127,217,196,.9)' : 'rgba(90,58,46,.35)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = reached ? `${m.label} ✓` : m.label;
        const tw = ctx.measureText(label).width + 18;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = INK;
        ctx.beginPath();
        ctx.roundRect(10, y - 13, tw, 26, 13);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK;
        ctx.fillText(label, 19, y + 1);
      }
      ctx.restore();
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      drawBackground();
      drawMarks();
      ctx.save();
      if (shake) ctx.translate(Math.sin(time * 50) * 7 * shake, 0);
      drawCone();
      tower.forEach((s, i) => {
        const top = baseY - (i + 1) * LAYER - (SCOOP_H - LAYER) + camY;
        if (top > H + 40 || top < -SCOOP_H - 20) return;
        const wob = jiggle * Math.sin(time * 22) * 5 * ((i + 1) / tower.length);
        const isTop = i === tower.length - 1;
        const face = isTop ? (mode === 'miss' || mode === 'over' ? 'shocked' : combo > 0 && flash ? 'yum' : 'closed') : null;
        drawScoop({ ...s, x: s.x + wob }, top, { face, squash: s.squash });
        if (isTop && flash) {
          ctx.save();
          ctx.globalAlpha = flash.life;
          scoopPath(s.x + wob, top, s.w, SCOOP_H);
          ctx.lineWidth = 6;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.restore();
        }
      });
      ctx.restore();
      if (mover) drawScoop(mover, mover.y + camY, { face: mode === 'fall' ? 'shocked' : 'happy' });
      pieces.forEach((p) => {
        ctx.save();
        const py = p.top + camY + SCOOP_H / 2;
        ctx.translate(p.x, py);
        ctx.rotate(p.rot);
        ctx.translate(-p.x, -py);
        drawScoop(p, p.top + camY);
        ctx.restore();
      });
      sparks.forEach((s) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.translate(s.x, s.y + camY);
        ctx.rotate(time * 6);
        ctx.fillStyle = s.c;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const r = i % 2 ? 2.5 : 7;
          const a = (i * Math.PI) / 4;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
    }

    function frame(t) {
      const dt = Math.min(0.05, (t - (last || t)) / 1000); // a background tab doesn't teleport the scoop
      last = t;
      update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    resize();
    reset();
    raf = requestAnimationFrame(frame);

    return {
      start,
      drop,
      resize,
      get mode() { return mode; },
      get score() { return score(); },
      // How far the swinging scoop is from the tower's centre (null when not swinging).
      get offset() { return mover && mode === 'play' ? mover.x - topX() : null; },
      destroy() { cancelAnimationFrame(raf); },
    };
  };
})();
