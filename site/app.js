(function () {
  const C = APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PALETTE = ['#FFB5C8', '#B8F2E6', '#CDB4FF', '#FFD97A', '#F58FAD', '#7FD9C4', '#ffffff'];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // The PIN lives only in memory, so every reload asks for it again.
  let pin = null;
  let state = null;
  let clockOffset = 0;
  let lastMine = null; // { at } of my last event, for the undo window
  let inFlight = false;
  let sheetOpen = false;
  let soundOn = store.get('sound') !== 'off';
  let appReady = false;
  let pollTimer = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const now = () => Date.now() + clockOffset;
  const isMyDevice = () => store.get('mine') === '1';

  // Fiza's visit log: while the page is on screen it checks in every poll, so the
  // admin page can show time spent. (Only set when the server logged this visit.)
  let openId = null;
  function pingOpen() {
    if (!openId || document.visibilityState !== 'visible') return;
    api(`/hello/${openId}`, 'POST', {}).then((r) => { openId = r.openId || openId; }).catch(() => {});
  }
  const isHim = () => state && state.me === C.HIM;

  // ---------- API ----------
  async function api(path, method = 'GET', body, pinOverride) {
    const res = await fetch(C.API_URL + path, {
      method,
      headers: { 'X-Pin': pinOverride || pin || '', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'http_' + res.status);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setState(s) {
    state = s;
    clockOffset = s.serverNow - Date.now();
  }

  // ---------- sound + haptics ----------
  let actx;
  function audio() {
    if (!soundOn) return null;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      // iOS uses 'interrupted' after switching apps, not just 'suspended'.
      if (actx.state !== 'running') actx.resume();
      return actx;
    } catch { return null; }
  }
  function tone(freq, dur, { type = 'sine', vol = 0.2, delay = 0, to } = {}) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  const sfx = {
    ding() { tone(1568, 1.5, { vol: 0.2 }); tone(2349, 1.0, { vol: 0.07 }); tone(3136, 0.6, { vol: 0.035 }); },
    plop() { tone(300, 0.13, { vol: 0.22, to: 760 }); },
    nom(d = 0) { tone(520, 0.09, { type: 'triangle', vol: 0.16, to: 260, delay: d }); tone(480, 0.09, { type: 'triangle', vol: 0.13, to: 240, delay: d + 0.13 }); },
    tap() { tone(880, 0.05, { vol: 0.07 }); },
    tick() { tone(1200, 0.03, { vol: 0.05 }); },
    nope() { tone(330, 0.15, { type: 'triangle', vol: 0.14, to: 220 }); tone(260, 0.2, { type: 'triangle', vol: 0.11, to: 180, delay: 0.15 }); },
    yay() { [784, 988, 1319].forEach((f, i) => tone(f, 0.28, { vol: 0.11, delay: i * 0.09 })); },
  };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

  // ---------- confetti (sprinkle-shaped) ----------
  let sprinkleShape;
  function shapes() {
    if (sprinkleShape === undefined) {
      try { sprinkleShape = confetti.shapeFromPath({ path: 'M2 0h10a2 2 0 0 1 0 4H2a2 2 0 0 1 0-4z' }); } catch { sprinkleShape = null; }
    }
    return sprinkleShape ? [sprinkleShape, sprinkleShape, 'circle'] : ['square', 'circle'];
  }
  function burst(el, opts = {}) {
    if (reduceMotion || !window.confetti || !el) return;
    const r = el.getBoundingClientRect();
    confetti({
      particleCount: 70, spread: 80, startVelocity: 30, gravity: 0.9, scalar: 1.1, ticks: 170,
      colors: PALETTE, shapes: shapes(), disableForReducedMotion: true,
      origin: { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 3) / innerHeight },
      ...opts,
    });
  }

  function sky() {
    const n = innerWidth > 720 ? 26 : 16;
    let h = '';
    for (let i = 0; i < n; i++) {
      h += `<i style="left:${rand(0, 100).toFixed(1)}%;top:${rand(0, 100).toFixed(1)}%;background:${pick(PALETTE.slice(0, 6))};--r:${rand(0, 180) | 0}deg;--x:${rand(-40, 40) | 0}px;--y:${rand(-60, 60) | 0}px;--d:${rand(14, 26).toFixed(1)}s"></i>`;
    }
    $('sky').innerHTML = h;
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(text, { sub, action, ms = 3200 } = {}) {
    const t = $('toast');
    t.innerHTML = `<div>${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>${action ? `<button class="btn">${esc(action.label)}</button>` : ''}`;
    if (action) t.querySelector('button').onclick = () => { hideToast(); action.fn(); };
    t.hidden = false;
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { $('toast').hidden = true; }

  function undoToast(text, sub) {
    const left = lastMine ? C.UNDO_MS - (Date.now() - lastMine.at) : 0;
    if (left > 2000) toast(text, { sub, action: { label: 'Undo', fn: doUndo }, ms: Math.min(left, 9000) });
    else toast(text, { sub });
  }

  function handleErr(e) {
    if (e && (e.status === 401 || (e.status === 429 && e.data.error === 'locked'))) return lockOut();
    toast('Uff, something went wrong 🥲', { sub: "Couldn't reach the parlour. Try again in a bit." });
  }

  // ---------- sheet ----------
  let onSheetClose = null;
  function openSheet(html, mount, onClose) {
    $('sheetBody').innerHTML = html;
    $('sheet').hidden = false;
    $('sheetBackdrop').hidden = false;
    sheetOpen = true;
    onSheetClose = onClose || null;
    hideToast();
    mount && mount($('sheetBody'));
  }
  function closeSheet(silent) {
    if (!sheetOpen) return;
    $('sheet').hidden = true;
    $('sheetBackdrop').hidden = true;
    sheetOpen = false;
    const cb = onSheetClose;
    onSheetClose = null;
    if (cb && !silent) cb();
  }
  $('sheetBackdrop').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- lock screen ----------
  let entered = '';
  let wrongCount = 0;
  let alooTimer;

  function showLock(msg) {
    $('lock').hidden = false;
    $('lock').classList.remove('melt');
    $('app').hidden = true;
    $('lockCone').innerHTML = Art.cone({ scoops: ['chocolate', 'strawberry'], expr: 'closed' });
    $('lockTitle').textContent = "Psst… what's the secret flavour?";
    $('lockMsg').textContent = msg || '';
    entered = '';
    dots();
  }
  function dots() {
    [...$('pinDots').children].forEach((d, i) => d.classList.toggle('on', i < entered.length));
  }
  function press(key) {
    if (entered.length === 4 && key !== 'back') return;
    sfx.tap();
    if (key === 'back') entered = entered.slice(0, -1);
    else entered += key;
    dots();
    if (entered.length === 4) tryPin(entered);
  }
  $('keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b || b.classList.contains('ghost')) return;
    press(b.dataset.key === 'back' ? 'back' : b.textContent.trim());
  });
  document.addEventListener('keydown', (e) => {
    if ($('lock').hidden) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
  });

  async function tryPin(p) {
    $('lockMsg').textContent = 'Checking…';
    try {
      const res = await api('/state', 'GET', null, p);
      pin = p;
      unlock(res.state);
    } catch (e) {
      if (e.status === 401) return wrongPin(e.data.triesLeft);
      if (e.status === 429 && e.data.error === 'locked') return lockedPin(e.data.retryAfter);
      $('lockMsg').textContent = "Can't reach the parlour 🥲 Is the server running?";
      entered = '';
      dots();
    }
  }

  function lockedPin(retryAfter) {
    const mins = Math.max(1, Math.ceil(retryAfter / 60));
    wrongPin();
    $('lockMsg').textContent = `Too many wrong tries. Try again in ${plural(mins, 'minute')} 🔒`;
    $('alooSays').textContent = 'FIA has locked the door 🔒';
  }

  function wrongPin(triesLeft) {
    wrongCount++;
    sfx.nope();
    buzz([40, 60, 40]);
    const d = $('pinDots');
    d.classList.remove('shake');
    void d.offsetWidth;
    d.classList.add('shake');
    entered = '';
    setTimeout(dots, 250);
    $('lockMsg').textContent = triesLeft <= 3 ? `Hmm, wrong flavour. ${plural(triesLeft, 'try')} left` : 'Hmm, wrong flavour.';
    $('alooSays').textContent =
      wrongCount >= 4 ? "Can't see anyone… bauni, is that you? 🔍"
        : wrongCount === 3 ? 'FIA has opened a file on you 📁'
          : wrongCount === 2 ? 'Aloo is very suspicious 🧐' : 'Aloo is suspicious 🤨';
    $('aloo').classList.add('show');
    $('lockStage').classList.add('suspect');
    clearTimeout(alooTimer);
    alooTimer = setTimeout(() => {
      $('aloo').classList.remove('show');
      $('lockStage').classList.remove('suspect');
    }, 3400);
  }

  function unlock(s) {
    setState(s);
    // Logging in as Muneeb marks this browser as his; logins with Fiza's PIN on his
    // browsers don't count as her opens. The flag never leaves this browser.
    if (s.me === C.HIM) store.set('mine', '1');
    openId = null;
    api('/hello', 'POST', { mine: isMyDevice() }).then((r) => { openId = r.openId || null; }).catch(() => {});
    syncPush().catch(() => {});
    wrongCount = 0;
    sfx.yay();
    clearTimeout(alooTimer);
    $('aloo').classList.remove('show');
    $('lockStage').classList.remove('suspect');
    $('lockCone').innerHTML = Art.cone({ scoops: ['chocolate', 'strawberry'], expr: 'happy' });
    $('lockTitle').textContent = s.me === C.HER ? `Hi ${C.HER}! 🍦` : `Hi ${C.HIM} 🙈`;
    $('lockMsg').textContent = '';
    setTimeout(() => {
      showApp();
      if (reduceMotion) { $('lock').hidden = true; return; }
      $('lock').classList.add('melt');
      setTimeout(() => { $('lock').hidden = true; }, 950);
    }, 750);
  }

  function lockOut() {
    openId = null;
    pin = null;
    clearInterval(pollTimer);
    closeSheet(true);
    hideToast();
    showLock();
  }

  // ---------- app shell ----------
  function showApp() {
    $('app').hidden = false;
    $('hello').textContent = isHim() ? `Hi ${C.HIM} 🙈` : `Hi ${C.HER} 👋`;
    if (!appReady) {
      appReady = true;
      $('shopSign').textContent = C.SHOP_NAME;
      $('bellArt').innerHTML = Art.bell();
      $('bellTitle').textContent = `${C.HIM} said baad mein bataonga! 🙄`;
      $('standEmpty').innerHTML = `${Art.cone({ scoops: [], expr: 'sleepy' })}<p>Stand's empty!</p>`;
      $('stool').insertAdjacentHTML('beforeend', Art.stool());
      $('alooId').innerHTML = `${Art.aloo()}<div><div class="id-title">FIA AGENT ID</div><dl>
        <dt>Name:</dt> <dd>Agent Aloo</dd>
        <dt>Agency:</dt> <dd>Fiza Investigation Aloo</dd>
        <dt>Specialty:</dt> <dd>catching “baad mein bataonga”</dd>
        <dt>Height:</dt> <dd>taller than ${esc(C.HER)}</dd></dl></div>`;
      buildDecor();
      initWheel();
      initMap();
      setInterval(updateBell, 1000);
    }
    coneSig = null;
    renderAll({ intro: true });
    setTimeout(maybeLetters, 1700);
    $('adminBtn').hidden = !isHim();
    showView(viewFromHash(), false);
    if (/#post-\d+/.test(location.hash)) openDeepLink(location.hash);
    if (pendingPost) { const id = pendingPost; pendingPost = null; setTimeout(() => openPhoto(id), 300); }
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') { refresh(); pingOpen(); } }, C.POLL_MS);
  }

  async function refresh() {
    if (inFlight || !pin) return;
    try {
      const prev = state;
      const res = await api('/state');
      setState(res.state);
      const prevMax = Math.max(0, ...prev.events.map((e) => e.id));
      const fresh = state.events.filter((e) => e.id > prevMax && e.by !== state.me);
      const changed = prev.totals.pending !== state.totals.pending;
      renderAll({ animate: changed }).then(() => {
        if (state.totals.owed > prev.totals.owed) maybeLetters();
      });
      const last = fresh[0];
      if (last) {
        if (last.type === 'owe') toast(`${last.by} just rang the bell 🔔`, { sub: '+2 ice creams' });
        else toast(`${last.by} logged ${plural(last.qty, 'ice cream')} eaten 😋`);
      }
    } catch (e) {
      if (e.status === 401 || (e.status === 429 && e.data.error === 'locked')) lockOut();
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state) { refresh(); pingOpen(); } });

  $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
  $('soundBtn').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set('sound', soundOn ? 'on' : 'off');
    $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
    $('soundBtn').setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
    if (soundOn) sfx.tap();
  });
  $('lockBtn').addEventListener('click', lockOut);

  // ---------- rendering ----------
  let standQueue = Promise.resolve();
  function renderAll(opts = {}) {
    const p = state.totals.pending;
    $('pillNum').textContent = p;
    applyUpgrades();
    renderLabels();
    renderShops();
    updateBell();
    if (!$('viewCases').hidden) renderCases();
    renderAdmin();
    renderScrapbook();
    renderPhotoSocial();
    const mode = opts.intro ? 'intro' : opts.animate ? 'animate' : 'instant';
    standQueue = standQueue.then(() => drawStand(p, mode)).then(() => setTally(state.totals.pending));
    return standQueue;
  }

  function renderLabels() {
    const { pending, owed, eaten } = state.totals;
    $('tallyLabel').textContent = pending === 0 ? 'All clear… for now 👀' : `${pending === 1 ? 'ice cream' : 'ice creams'}, owed by ${C.HIM}`;
    $('tallySub').textContent = `${owed} total · ${eaten} eaten`;

    const next = nextMilestone();
    if (isHim()) {
      const sealed = (letterRow(next) || {}).note;
      $('nextSurprise').innerHTML = `<button class="next-surprise" data-letter="${next}">🎁 next surprise at ${next} · ${sealed ? 'note sealed ✉️' : 'write a note ✍️'}</button>`;
    } else {
      $('nextSurprise').innerHTML = `<div class="next-surprise">🎁 next surprise at ${next} · ${next - owed} to go</div>`;
    }
  }
  $('nextSurprise').addEventListener('click', (e) => {
    const b = e.target.closest('[data-letter]');
    if (b) openLetterEditor(+b.dataset.letter);
  });

  let shownNum = null;
  function setTally(p) {
    const el = $('tallyNum');
    if (shownNum === null || reduceMotion) { el.textContent = p; shownNum = p; return; }
    if (p === shownNum) return;
    const from = shownNum;
    const t0 = performance.now();
    shownNum = p;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 450);
      el.textContent = Math.round(from + (p - from) * k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // ---------- the cone stand ----------
  // One cone per "baad mein bataonga" (2 scoops). Cone k counts from the oldest,
  // so colours stay put as new cones arrive at the front.
  const stand = $('stand');
  const coneEls = new Map();
  let shownPending = null;

  const layout = (p) => {
    const count = Math.ceil(p / 2);
    return Array.from({ length: count }, (_, k) => (k === count - 1 && p % 2 ? 1 : 2));
  };
  const scoopKey = (k, i) => C.SCOOP_PATTERN[(k * 2 + i) % C.SCOOP_PATTERN.length];
  const FACES = ['happy', 'happy', 'closed', 'happy', 'sleepy', 'happy', 'closed'];
  const faceFor = (k) => FACES[(k * 5 + 2) % FACES.length];
  let coneOpts = {};
  const coneHTML = (k, n, classes = []) =>
    Art.cone({ scoops: Array.from({ length: n }, (_, i) => scoopKey(k, i)), expr: faceFor(k), scoopClasses: classes, ...coneOpts });

  function setFace(el, expr) {
    const f = el && el.querySelector('.cone-body .face');
    if (f) f.outerHTML = Art.face(expr, 60, 130);
  }

  function flipRecord() {
    const m = new Map();
    coneEls.forEach((el, k) => m.set(k, el.getBoundingClientRect()));
    return m;
  }
  function flipPlay(before) {
    if (reduceMotion) return;
    coneEls.forEach((el, k) => {
      const b = before.get(k);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (!dx && !dy) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 480, easing: 'cubic-bezier(.3, 1.3, .5, 1)',
      });
    });
  }

  function nomBubble(el, delay) {
    setTimeout(() => {
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.className = 'nom';
      b.textContent = pick(['nom!', 'yum!', 'nom nom']);
      b.style.left = r.left + r.width / 2 + scrollX + 'px';
      b.style.top = r.top + scrollY + 'px';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 1000);
    }, delay * 1000);
  }

  // Newest scoops get eaten first; empty cones hop away.
  function eatAnim(prev, target) {
    let j = 0;
    for (let k = prev.length - 1; k >= 0; k--) {
      const had = prev[k];
      const keep = target[k] || 0;
      const el = coneEls.get(k);
      if (had === keep || !el) continue;
      const scoops = [...el.querySelectorAll('.scoop')];
      setFace(el, 'yum');
      for (let i = had - 1; i >= keep; i--) {
        const d = j * 0.32;
        scoops[i].style.setProperty('--delay', d + 's');
        scoops[i].classList.add('eat');
        const ch = i === had - 1 && el.querySelector('.cherry');
        if (ch) { ch.style.setProperty('--delay', d + 's'); ch.classList.add('eat'); }
        nomBubble(el, d);
        sfx.nom(d);
        j++;
      }
      if (keep === 0) setTimeout(() => el.classList.add('leave'), (j * 0.32 + 0.15) * 1000);
    }
    return new Promise((res) => setTimeout(res, j * 320 + 650));
  }

  function drawStand(p, mode) {
    const target = layout(p);
    const prev = shownPending == null ? [] : layout(shownPending);
    const growing = mode === 'animate' && shownPending != null && p > shownPending && !reduceMotion;
    const shrinking = mode === 'animate' && shownPending != null && p < shownPending && !reduceMotion;
    shownPending = p;

    return (shrinking ? eatAnim(prev, target) : Promise.resolve()).then(() => {
      const before = flipRecord();
      const fresh = [];
      const drops = [];

      const intro = mode === 'intro' && !reduceMotion;
      target.forEach((n, k) => {
        let el = coneEls.get(k);
        const had = el ? +el.dataset.n : 0;
        if (el && had === n && !intro && !el.classList.contains('leave')) return;
        if (!el) {
          el = document.createElement('div');
          el.className = 'cone-slot';
          el.style.setProperty('--blink', ((k * 1.37) % 4).toFixed(2) + 's');
          el.style.setProperty('--sway', (-((k * 0.53) % 3.4)).toFixed(2) + 's');
          coneEls.set(k, el);
          if (growing) fresh.push(el);
        }
        el.classList.remove('leave');
        const classes = Array.from({ length: n }, (_, i) => (intro || (growing && i >= had) ? 'drop' : ''));
        el.dataset.n = n;
        el.innerHTML = coneHTML(k, n, classes);
        if (growing) el.querySelectorAll('.scoop.drop').forEach((s) => drops.push({ s, el }));
      });
      [...coneEls.keys()].forEach((k) => {
        if (k >= target.length) { coneEls.get(k).remove(); coneEls.delete(k); }
      });
      for (let k = target.length - 1; k >= 0; k--) stand.appendChild(coneEls.get(k));

      stand.hidden = p === 0;
      $('standEmpty').hidden = p !== 0;
      // Bauni easter egg: once there are 3+ shelves, a stool shows up for Fiza.
      const rows = new Set([...stand.children].map((c) => c.offsetTop)).size;
      $('stool').classList.toggle('show', p > 0 && rows >= 3);

      // On load the cones pop onto the shelves and their scoops fall in, quietly.
      if (intro) {
        [...stand.children].forEach((el, i) => {
          const d = Math.min(i, 20) * 0.06;
          el.style.setProperty('--delay', d + 's');
          el.classList.add('pop-in');
          el.querySelectorAll('.scoop.drop').forEach((s, j) => s.style.setProperty('--delay', d + 0.3 + j * 0.2 + 's'));
          const ch = el.querySelector('.cherry.drop');
          if (ch) ch.style.setProperty('--delay', d + 0.75 + 's');
        });
        flipPlay(before);
        return;
      }
      flipPlay(before);
      if (!drops.length) return;

      fresh.forEach((el) => {
        el.classList.add('enter');
        el.addEventListener('animationend', function done(e) {
          if (e.target === el) { el.classList.remove('enter'); el.removeEventListener('animationend', done); }
        });
      });
      const base = fresh.length ? 0.4 : 0.05;
      const gap = 0.42;
      drops.forEach(({ s, el }, j) => {
        const d = base + j * gap;
        s.style.setProperty('--delay', d + 's');
        const ch = el.querySelector('.cherry.drop');
        if (ch) ch.style.setProperty('--delay', d + 0.3 + 's');
        setTimeout(() => {
          sfx.plop();
          buzz(15);
          el.classList.remove('squish');
          void el.offsetWidth;
          el.classList.add('squish');
        }, (d + 0.6 * 0.66) * 1000);
      });
      const last = drops[drops.length - 1].el;
      return new Promise((res) =>
        setTimeout(() => {
          burst(last);
          setFace(last, 'shocked');
          setTimeout(() => setFace(last, faceFor(+[...coneEls].find(([, v]) => v === last)?.[0] || 0)), 2600);
          res();
        }, (base + (drops.length - 1) * gap + 0.6) * 1000)
      );
    });
  }

  // One-shot animation classes come off when they finish. Otherwise they replay
  // whenever a view is shown again (display:none → block restarts CSS animations).
  const ONE_SHOT = ['drop', 'enter', 'pop-in', 'hop', 'bump', 'pop', 'thunk', 'shake'];
  document.addEventListener('animationend', (e) => {
    const t = e.target;
    if (!t.classList) return;
    ONE_SHOT.forEach((c) => t.classList.remove(c));
    if (e.animationName === 'squish') t.closest('.cone-slot')?.classList.remove('squish');
    if (e.animationName === 'ring') t.closest('.bell-btn')?.classList.remove('ring');
    if (e.animationName === 'shake') t.closest('.bell-btn')?.classList.remove('nope');
  });

  // Tap a cone and it hops and smiles.
  stand.addEventListener('click', (e) => {
    const el = e.target.closest('.cone-slot');
    if (!el || el.classList.contains('enter') || el.classList.contains('leave')) return;
    el.classList.remove('hop');
    void el.offsetWidth;
    el.classList.add('hop');
    sfx.plop();
    setFace(el, 'closed');
    clearTimeout(el._faceTimer);
    el._faceTimer = setTimeout(() => {
      const k = [...coneEls].find(([, v]) => v === el)?.[0] || 0;
      setFace(el, faceFor(k));
    }, 1200);
  });

  // ---------- the bell ----------
  const RING_LEN = 2 * Math.PI * 92;
  $('ringProgress').style.strokeDasharray = RING_LEN;
  const cooldownLeft = () => (state && state.cooldownUntil ? Math.max(0, state.cooldownUntil - now()) : 0);
  const fmtLeft = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function updateBell() {
    if (!state) return;
    const left = cooldownLeft();
    const btn = $('bellBtn');
    const frozen = left > 0;
    btn.classList.toggle('frozen', frozen);
    $('ringProgress').style.strokeDashoffset = RING_LEN * (1 - left / C.COOLDOWN_MS);
    $('bellHint').textContent = frozen ? `Bell is frozen ❄️ ${fmtLeft(left)}` : 'tap the bell · +2 ice creams';
    updateAdminBell();
    btn.setAttribute('aria-label', frozen
      ? `Bell is frozen for ${fmtLeft(left)}`
      : `Ring the bell: ${C.HIM} said baad mein bataonga, add 2 ice creams`);
  }

  $('bellBtn').addEventListener('click', async () => {
    if (inFlight || !state) return;
    const btn = $('bellBtn');
    const left = cooldownLeft();
    if (left > 0) {
      btn.classList.remove('nope');
      void btn.offsetWidth;
      btn.classList.add('nope');
      sfx.nope();
      toast(`Sabar! The bell unfreezes in ${fmtLeft(left)} ❄️`, { sub: `One report every ${C.COOLDOWN_MS / 60000} minutes` });
      return;
    }
    inFlight = true;
    btn.classList.remove('ring');
    void btn.offsetWidth;
    btn.classList.add('ring');
    // The frozen shiver takes over mid-ring, so animationend never fires; clear it by time.
    setTimeout(() => btn.classList.remove('ring'), 1000);
    sfx.ding();
    buzz(30);
    try {
      const res = await api('/owe', 'POST', {});
      lastMine = { at: Date.now() };
      setState(res.state);
      await renderAll({ animate: true });
      openNoteSheet(res.event, { fresh: true });
    } catch (e) {
      if (e.status === 429) {
        state.cooldownUntil = e.data.cooldownUntil;
        updateBell();
        toast('Someone just rang it! ❄️', { sub: 'The bell is frozen for a bit' });
      } else handleErr(e);
    } finally {
      inFlight = false;
    }
  });

  async function doUndo() {
    try {
      const res = await api('/undo', 'POST', {});
      lastMine = null;
      setState(res.state);
      closeSheet(true);
      renderAll();
      toast('Undone ↩️');
    } catch (e) {
      if (e.status === 409) toast("Too late to undo 🙈", { sub: "It's been over a minute" });
      else handleErr(e);
    }
  }

  // ---------- milestones: parlour upgrades + sealed letters ----------
  // Every 10 ice creams owed (all-time) unlocks an envelope for Fiza. Up to 100,
  // each also adds an upgrade, which she sees once she has opened its envelope.
  const UP = C.UPGRADES;
  const upgradeAt = (at) => UP.find((u) => u.at === at);
  const letterRow = (at) => (state.milestones || []).find((m) => m.at === at);
  const isOpened = (at) => !!(letterRow(at) || {}).openedAt;
  const nextMilestone = () =>
    Math.max(C.MILESTONE_FIRST, (Math.floor(state.totals.owed / C.MILESTONE_STEP) + 1) * C.MILESTONE_STEP);
  function reachedMilestones() {
    const out = [];
    for (let at = C.MILESTONE_FIRST; at <= state.totals.owed; at += C.MILESTONE_STEP) out.push(at);
    return out;
  }
  const pendingLetters = () => (isHim() ? [] : reachedMilestones().filter((at) => !isOpened(at)));
  function upgradeOn(key) {
    const u = UP.find((x) => x.key === key);
    return !!u && state.totals.owed >= u.at && (isHim() || isOpened(u.at));
  }

  function buildDecor() {
    const colors = ['#FFB5C8', '#B8F2E6', '#CDB4FF', '#FFD97A'];
    const mk = (cls, html, parent, before) => {
      const d = document.createElement('div');
      d.className = 'decor ' + cls;
      d.innerHTML = html;
      parent.insertBefore(d, before || null);
      d.addEventListener('animationend', (e) => { if (e.target === d) d.classList.remove('reveal'); });
    };
    const wide = innerWidth >= 720;
    const zone = document.querySelector('.bell-zone');
    mk('decor-lights', Array.from({ length: wide ? 26 : 14 }, (_, i) => `<i style="--c:${colors[i % 4]};--d:${(i % 5) * 0.35}s"></i>`).join(''), document.querySelector('.awning'));
    mk('decor-bunting', Array.from({ length: wide ? 28 : 13 }, (_, i) => Art.flag(colors[i % 4])).join(''), $('parlour'), $('shopSign'));
    mk('decor-open', 'OPEN', $('parlour'));
    mk('decor-cat', Art.cat(), $('shopSign'));
    mk('decor-pot pot-l', Art.pot('#FFB5C8'), zone);
    mk('decor-pot pot-r', Art.pot('#CDB4FF'), zone);
    mk('decor-balloon', Art.balloon(), zone);
    mk('decor-crown', Art.crown(), $('bellBtn'));
  }

  let coneSig = null;
  function applyUpgrades() {
    UP.forEach((u) => $('parlour').classList.toggle('up-' + u.key, upgradeOn(u.key)));
    coneOpts = { cherry: upgradeOn('cherry'), rainbow: upgradeOn('rainbow'), golden: upgradeOn('golden') };
    const sig = JSON.stringify(coneOpts);
    if (coneSig !== null && sig !== coneSig) coneEls.forEach((el) => { el.dataset.n = 'x'; }); // redraw every cone
    coneSig = sig;
  }

  function revealUpgrade(u) {
    if (!u) return;
    $('parlour').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => {
      if (['cherry', 'rainbow', 'golden'].includes(u.key)) renderAll({ intro: true });
      else applyUpgrades();
      const sel = { flowers: '.decor-pot', golden: '.decor-crown' }[u.key] || '.decor-' + u.key;
      document.querySelectorAll(sel).forEach((el) => {
        el.classList.remove('reveal');
        void el.offsetWidth;
        el.classList.add('reveal');
        burst(el, { particleCount: 40, spread: 60 });
      });
      sfx.yay();
    }, reduceMotion ? 0 : 450);
  }

  let lettering = false;
  function maybeLetters() {
    if (lettering || sheetOpen || !state || $('app').hidden) return;
    const queue = pendingLetters();
    if (queue.length) showEnvelope(queue[0]);
  }
  function closeLetter() {
    $('letter').hidden = true;
    lettering = false;
  }

  function showEnvelope(at) {
    lettering = true;
    hideToast();
    const stage = $('letterStage');
    stage.className = 'letter-stage';
    stage.innerHTML = `<button class="envelope-btn" id="envBtn" aria-label="Open your surprise">${Art.envelope()}</button>
      <div class="letter-hint">You unlocked something ✉️<br><small style="font-weight:500">tap to open</small></div>`;
    $('letter').hidden = false;
    sfx.yay();
    buzz([20, 40, 20]);
    $('envBtn').onclick = async () => {
      $('envBtn').onclick = null;
      stage.classList.add('opening');
      sfx.tap();
      try {
        const res = await api(`/milestones/${at}/open`, 'POST', {});
        setState(res.state);
      } catch (e) {
        closeLetter();
        return handleErr(e);
      }
      setTimeout(() => showLetter(at, { fresh: true }), reduceMotion ? 0 : 450);
    };
  }

  // fresh: just opened (reveals the upgrade after). note: preview text for Muneeb's editor.
  function showLetter(at, { fresh, note } = {}) {
    lettering = true;
    const u = upgradeAt(at);
    const text = note !== undefined ? note.trim() : (letterRow(at) || {}).note;
    const intro = u ? 'Look what just arrived in the parlour:' : `${at}?! ${C.HIM} is in so much trouble 😳`;
    $('letterStage').className = 'letter-stage';
    $('letterStage').innerHTML = `<div class="letter-card">
        <h3>${at} ice creams! 🎉</h3>
        ${text ? `<div class="letter-note">${esc(text)}</div><div class="letter-sign">— ${esc(C.HIM)}</div>` : `<p class="muted">${esc(intro)}</p>`}
        ${u ? `<div class="letter-new">${u.emoji} New: ${esc(u.name)}</div>` : ''}
        <div><button class="btn" id="letterOk">${fresh ? 'Yayyy 🎉' : 'Close'}</button></div>
      </div>`;
    $('letter').hidden = false;
    if (fresh) burst($('letterStage'));
    $('letterOk').focus();
    $('letterOk').onclick = () => {
      closeLetter();
      if (!fresh) return;
      revealUpgrade(u);
      setTimeout(maybeLetters, 1400);
    };
  }

  function openLetterEditor(at) {
    if (!isHim()) return;
    const row = letterRow(at) || {};
    const u = upgradeAt(at);
    const status = row.openedAt
      ? `${C.HER} opened this on ${fmtDate(row.openedAt)} ✓`
      : state.totals.owed >= at ? `Unlocked, ${C.HER} hasn't opened it yet 👀` : `Sealed until ${at} ice creams 🔒`;
    openSheet(
      `<h3>Note for ${at} ice creams ✉️</h3>
       <p>${esc(status)}${u ? `<br>Also unlocks: ${u.emoji} ${esc(u.name)}` : ''}</p>
       <label for="letterIn">Your note (optional)</label>
       <textarea id="letterIn" rows="6" maxlength="1000" placeholder="Write something sweet… she'll read it when she hits ${at}">${esc(row.note || '')}</textarea>
       <div class="sheet-actions">
         <button class="link-btn" data-act="preview">Preview</button><span class="spacer"></span>
         <button class="btn btn-plain" data-act="cancel">Cancel</button>
         <button class="btn" data-act="save">Seal it ✉️</button>
       </div>`,
      (root) => {
        const input = root.querySelector('#letterIn');
        root.querySelector('[data-act="cancel"]').onclick = () => closeSheet();
        root.querySelector('[data-act="preview"]').onclick = () => showLetter(at, { note: input.value });
        root.querySelector('[data-act="save"]').onclick = async (e) => {
          e.target.disabled = true;
          try {
            const res = await api(`/milestones/${at}`, 'PATCH', { note: input.value.trim() || null });
            setState(res.state);
            closeSheet(true);
            renderAll();
            toast(input.value.trim() ? 'Sealed ✉️' : 'Note removed');
          } catch (err) {
            e.target.disabled = false;
            handleErr(err);
          }
        };
      }
    );
  }

  function renderSurprises() {
    const owed = state.totals.owed;
    const last = Math.max(100, nextMilestone() + 20);
    let chips = '';
    for (let at = C.MILESTONE_FIRST; at <= last; at += C.MILESTONE_STEP) {
      const row = letterRow(at) || {};
      if (isHim()) {
        chips += `<button class="chip${owed >= at ? '' : ' locked'}" data-letter="${at}">${row.note ? '✉️' : '✍️'} ${at}${row.openedAt ? ' <small>opened</small>' : ''}</button>`;
      } else if (owed < at) {
        chips += `<button class="chip locked" data-letter="${at}">🔒 ${at}</button>`;
      } else if (!row.openedAt) {
        chips += `<button class="chip fresh" data-letter="${at}">✉️ ${at} new!</button>`;
      } else {
        chips += `<button class="chip" data-letter="${at}">✉️ ${at}</button>`;
      }
    }
    $('surprises').innerHTML = isHim()
      ? `<h2>✉️ Your sealed notes</h2><p class="muted" style="margin:0 0 10px;font-size:14px">${esc(C.HER)} only sees each one when she reaches it.</p><div class="chips">${chips}</div>`
      : `<h2>✉️ Surprises</h2><div class="chips">${chips}</div>`;
  }
  $('surprises').addEventListener('click', (e) => {
    const c = e.target.closest('[data-letter]');
    if (!c) return;
    const at = +c.dataset.letter;
    if (isHim()) return openLetterEditor(at);
    if (state.totals.owed < at) return toast(`Locked until ${at} 🍦`, { sub: `${at - state.totals.owed} more to go` });
    if (!isOpened(at)) return showEnvelope(at);
    showLetter(at);
  });

  // ---------- admin page (Muneeb only; the server enforces it too) ----------
  function renderAdmin() {
    if (!isHim() || $('viewAdmin').hidden) return;
    // Don't wipe the number he's typing when a background refresh lands.
    if (document.activeElement && document.activeElement.id === 'archivesIn') return;
    const { pending, owed, eaten } = state.totals;
    const archives = state.events.find((e) => e.by === 'system' && e.type === 'owe');
    const rows = state.events.filter((e) => e.by !== 'system');
    const shopName = (id) => (state.shops.find((s) => s.id === id) || {}).name;
    const letters = [];
    for (let at = C.MILESTONE_FIRST; at <= Math.max(nextMilestone(), ...(state.milestones || []).map((m) => m.at)); at += C.MILESTONE_STEP) {
      letters.push({ at, ...(letterRow(at) || {}) });
    }

    // Fiza's opens per day, bucketed in Karachi time.
    const opens = state.opens || [];
    const pkDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const perDay = Array.from({ length: 7 }, (_, i) => {
      const t = now() - i * 86400000;
      return { t, i, n: opens.filter((o) => pkDay(o.at) === pkDay(t)).length };
    });
    const maxN = Math.max(1, ...perDay.map((d) => d.n));

    // One collapsible folder per day (Karachi time), newest first; today starts open.
    const spent = (o) => Math.max(0, (o.lastSeen || o.at) - o.at);
    const fmtSpent = (ms) => {
      const m = Math.round(ms / 60000);
      return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
    };
    const regionName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
    const country = (cc) => (cc && /^[A-Z]{2}$/.test(cc)
      ? `${String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)))} ${esc((regionName && regionName.of(cc)) || cc)}`
      : '🌐 Unknown');
    const byDay = new Map();
    opens.forEach((o) => {
      const k = pkDay(o.at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(o);
    });
    const todayKey = pkDay(now());
    const yesterdayKey = pkDay(now() - 86400000);

    // Summary stats over the last 7 days (Karachi time).
    const week = opens.filter((o) => o.at > now() - 7 * 86400000);
    const weekTime = week.reduce((s, o) => s + spent(o), 0);
    const hours = {};
    week.forEach((o) => {
      const h = Number(new Date(o.at).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Karachi' })) % 24;
      hours[h] = (hours[h] || 0) + 1;
    });
    const busiest = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
    const hourLabel = (h) => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' }).toLowerCase();
    let streak = 0;
    while (byDay.has(pkDay(now() - streak * 86400000))) streak++;
    const visitStats = [
      [(week.length / 7).toFixed(1), 'visits a day'],
      [week.length ? fmtSpent(weekTime / week.length) : '—', 'average visit'],
      [fmtSpent(weekTime), 'total this week'],
      [busiest ? `${hourLabel(+busiest[0])}–${hourLabel((+busiest[0] + 1) % 24)}` : '—', 'busiest hour'],
      [plural(streak, 'day'), 'in a row'],
    ];
    const dayFolders = [...byDay.entries()].map(([k, list]) => {
      const label = k === todayKey ? 'Today' : k === yesterdayKey ? 'Yesterday'
        : new Date(list[0].at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' });
      const total = list.reduce((s, o) => s + spent(o), 0);
      return `<details class="day-folder"${k === todayKey ? ' open' : ''}>
        <summary>📁 <b>${label}</b> · ${plural(list.length, 'visit')} · ${fmtSpent(total)}</summary>
        <ul class="admin-list">
          ${list.map((o) => `<li>
            <span>${new Date(o.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Karachi' }).toLowerCase()} · ${country(o.country)} · ${fmtSpent(spent(o))}</span>
            <button class="link-btn" data-not-her="${o.id}">That was me</button>
          </li>`).join('')}
        </ul>
      </details>`;
    }).join('');
    const dayName = (d) => (d.i === 0 ? 'Today' : d.i === 1 ? 'Yesterday'
      : new Date(d.t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Karachi' }));

    $('admin').innerHTML = `
      <section class="admin-card">
        <h2>👀 ${esc(C.HER)}'s visits</h2>
        <p><b>${perDay[0].n}</b> today · ${perDay[1].n} yesterday · ${perDay.reduce((s, d) => s + d.n, 0)} in the last 7 days</p>
        <ul class="opens-bars">
          ${perDay.map((d) => `<li><span>${dayName(d)}</span><i style="--w:${(d.n / maxN) * 100}%"></i><b>${d.n}</b></li>`).join('')}
        </ul>
        <div class="visit-stats">
          ${visitStats.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}
        </div>
        <h3 class="opens-h">Visits by day</h3>
        ${dayFolders || '<p class="muted small">No visits yet.</p>'}
        <div class="admin-row device-row">
          <span>${isMyDevice() ? '📱 This device: <b>yours ✓</b>' : '📱 This device: <b>not marked</b>'}</span>
          <button class="btn btn-small btn-plain" data-admin="mine">${isMyDevice() ? 'Unmark' : 'This device is mine'}</button>
        </div>
        <p class="muted small">Counts logins with her PIN, except on devices marked as yours. Saves the time, country and time spent (Karachi time). Country follows her VPN.</p>
      </section>

      <section class="admin-card">
        <h2>🍦 Count</h2>
        <p><b>${pending}</b> pending · ${owed} owed in total · ${eaten} eaten</p>
        <label for="archivesIn">Starting count (The Archives)</label>
        <div class="admin-row">
          <input type="number" id="archivesIn" min="0" max="999" inputmode="numeric" value="${archives ? archives.qty : 0}">
          <button class="btn btn-small" data-admin="archives">Save</button>
        </div>
        <p class="muted small">Everything from before the website. Changing it moves the total up or down.</p>
      </section>

      <section class="admin-card">
        <h2>🔔 Bell</h2>
        <p id="adminBell"></p>
        <button class="btn btn-small" data-admin="unfreeze" id="adminUnfreeze">Unfreeze now</button>
      </section>

      <section class="admin-card admin-wide">
        <h2>📜 Rings & ice creams</h2>
        <p class="muted small">Delete anything that shouldn't be there, e.g. an accidental ring. Tap Delete twice to confirm.</p>
        <ul class="admin-list">
          ${rows.map((e) => `<li>
            <span><b>${e.type === 'owe' ? '🔔 +2' : `😋 −${e.qty}`}</b> · ${esc(e.by)} · ${fmtDate(e.createdAt)}${e.type === 'paid' && shopName(e.shopId) ? ` · ${esc(shopName(e.shopId))}` : ''}${e.note ? `<br><span class="muted">“${esc(e.note)}”</span>` : ''}</span>
            <button class="link-btn danger" data-del="${e.id}">Delete</button>
          </li>`).join('') || '<li class="muted">Nothing yet.</li>'}
        </ul>
      </section>

      <section class="admin-card">
        <h2>✉️ Envelopes</h2>
        <ul class="admin-list">
          ${letters.map((l) => `<li>
            <span><b>${l.at}</b> · ${l.note ? 'note written' : 'no note'} · ${l.openedAt ? `opened ${fmtDate(l.openedAt)}` : owed >= l.at ? 'not opened yet' : 'locked'}</span>
            <span class="admin-actions">
              <button class="link-btn" data-letter-edit="${l.at}">Edit</button>
              ${l.openedAt ? `<button class="link-btn" data-reseal="${l.at}">Re-seal</button>` : ''}
            </span>
          </li>`).join('') || '<li class="muted">No envelopes yet.</li>'}
        </ul>
        <p class="muted small">Re-seal makes the envelope pop up for ${esc(C.HER)} again next time she opens the site.</p>
      </section>

      <section class="admin-card">
        <h2>🔑 PINs</h2>
        <p class="muted small">The old PIN stops working right away.</p>
        <div class="admin-row" style="flex-wrap:wrap">
          <button class="btn btn-small btn-plain" data-admin="pin-me">Change my PIN</button>
          <button class="btn btn-small btn-plain" data-admin="pin">Reset ${esc(C.HER)}'s PIN</button>
        </div>
      </section>`;
    updateAdminBell();
  }

  function updateAdminBell() {
    const el = $('adminBell');
    if (!el) return;
    const left = cooldownLeft();
    el.textContent = left > 0 ? `Frozen for another ${fmtLeft(left)} ❄️` : 'Ready to ring';
    $('adminUnfreeze').disabled = left <= 0;
  }

  async function adminCall(path, method, body, done) {
    try {
      const res = await api(path, method, body);
      setState(res.state);
      renderAll();
      toast(done);
    } catch (err) {
      if (err.status === 409 && err.data.error === 'would_go_negative') {
        toast("Can't do that 🙈", { sub: 'Eaten would end up higher than owed' });
      } else if (err.status === 400) {
        toast('Hmm, that number looks off', { sub: err.data.message });
      } else handleErr(err);
    }
  }

  $('admin').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.admin === 'archives') {
      const qty = Number($('archivesIn').value);
      return adminCall('/admin/archives', 'PATCH', { qty }, `Starting count set to ${qty}`);
    }
    if (t.dataset.admin === 'unfreeze') return adminCall('/admin/unfreeze', 'POST', {}, 'Bell unfrozen 🔔');
    if (t.dataset.admin === 'pin') return openPinChange('fiza');
    if (t.dataset.admin === 'pin-me') return openPinChange('muneeb');
    if (t.dataset.admin === 'mine') {
      if (isMyDevice()) store.del('mine');
      else store.set('mine', '1');
      renderAdmin();
      return toast(isMyDevice() ? 'This device is marked as yours ✓' : 'This device is no longer marked');
    }
    if (t.dataset.notHer) return adminCall(`/admin/opens/${t.dataset.notHer}`, 'DELETE', null, 'Removed from her opens');
    if (t.dataset.letterEdit) return openLetterEditor(+t.dataset.letterEdit);
    if (t.dataset.reseal) return adminCall(`/admin/milestones/${t.dataset.reseal}/reseal`, 'POST', {}, 'Envelope re-sealed ✉️');
    if (t.dataset.del) {
      if (t.dataset.sure !== '1') {
        t.dataset.sure = '1';
        t.textContent = 'Sure? Tap again';
        setTimeout(() => { if (t.isConnected) { t.dataset.sure = ''; t.textContent = 'Delete'; } }, 3000);
        return;
      }
      return adminCall(`/admin/events/${t.dataset.del}`, 'DELETE', null, 'Deleted 🗑️');
    }
  });

  // who: 'fiza' (reset hers) or 'muneeb' (change his own, typed twice).
  function openPinChange(who) {
    const mine = who === 'muneeb';
    const digits = (id, label, ph) => `<label for="${id}">${label}</label>
       <input type="${mine ? 'password' : 'text'}" id="${id}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="${ph}">`;
    openSheet(
      `<h3>${mine ? 'Change my PIN 🔑' : `New PIN for ${esc(C.HER)} 🔑`}</h3>
       <p>${mine ? 'Your old PIN stops working right away. Pick one you won\'t forget!' : "Her old PIN stops working right away. Don't forget to tell her!"}</p>
       ${digits('newPin', mine ? 'New PIN (4 digits)' : '4 digits', mine ? '••••' : 'e.g. 0214')}
       ${mine ? digits('newPin2', 'Type it again', '••••') : ''}
       <p class="muted" id="pinErr" style="min-height:22px;margin:8px 0 0"></p>
       <div class="sheet-actions">
         <button class="btn btn-plain" data-act="cancel">Cancel</button>
         <button class="btn" data-act="save">Set PIN</button>
       </div>`,
      (root) => {
        const inputs = [...root.querySelectorAll('input')];
        inputs.forEach((i) => i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 4); }));
        root.querySelector('[data-act="cancel"]').onclick = () => closeSheet();
        root.querySelector('[data-act="save"]').onclick = async (e) => {
          const pinErr = root.querySelector('#pinErr');
          const value = inputs[0].value;
          if (!/^\d{4}$/.test(value)) { pinErr.textContent = 'Needs exactly 4 digits'; return; }
          if (mine && inputs[1].value !== value) { pinErr.textContent = "Those don't match"; return; }
          e.target.disabled = true;
          try {
            const res = await api(`/pin/${who}`, 'POST', { pin: value });
            if (mine) pin = value; // keep this session working with the new PIN
            setState(res.state);
            closeSheet(true);
            if (mine) toast('Your new PIN is set 🔑', { sub: "Don't forget it 🙈", ms: 5000 });
            else toast(`${C.HER}'s new PIN is set 🔑`, { sub: 'Tell her before she gets locked out 🙈', ms: 5000 });
          } catch (err) {
            e.target.disabled = false;
            if (err.status === 400) {
              pinErr.textContent = /different/.test(err.data.message)
                ? (mine ? `That's ${C.HER}'s PIN 🙈 pick another` : "That's your PIN 🙈 pick another")
                : 'Needs exactly 4 digits';
            } else handleErr(err);
          }
        };
      }
    );
  }

  // Bauni easter egg: tap the shop sign 5 times.
  let signTaps = 0;
  let signTimer;
  $('shopSign').addEventListener('click', () => {
    const s = $('shopSign');
    s.classList.remove('tapped');
    void s.offsetWidth;
    s.classList.add('tapped');
    sfx.tap();
    clearTimeout(signTimer);
    signTimer = setTimeout(() => { signTaps = 0; }, 2000);
    if (++signTaps < 5) return;
    signTaps = 0;
    toast('Bauni detected 🔍', { sub: 'Lowering the shelves…' });
    const wrap = document.querySelector('.stand-wrap');
    wrap.classList.add('lowered');
    setTimeout(() => { wrap.classList.remove('lowered'); sfx.plop(); }, 3200);
  });
  $('shopSign').addEventListener('animationend', (e) => {
    if (e.animationName === 'sign-boing') $('shopSign').classList.remove('tapped');
  });

  // ---------- case numbers ----------
  function chronological() {
    return [...state.events].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }
  function caseInfo() {
    let eatenLeft = state.totals.eaten;
    let no = 0;
    const out = [];
    for (const e of chronological()) {
      if (e.type !== 'owe') { out.push({ e }); continue; }
      const archive = e.by === 'system';
      const n = archive ? Math.max(1, Math.round(e.qty / 2)) : 1;
      const from = no + 1;
      no += n;
      const paid = Math.min(eatenLeft, e.qty);
      eatenLeft -= paid;
      out.push({
        e, archive, from, to: no, left: e.qty - paid,
        status: paid >= e.qty ? 'closed' : paid > 0 ? 'partial' : 'pending',
      });
    }
    return out;
  }
  const caseNoOf = (id) => (caseInfo().find((c) => c.e.id === id) || {}).from;

  // ---------- note sheet ----------
  function openNoteSheet(ev, { fresh } = {}) {
    if (!ev) return;
    const owe = ev.type === 'owe';
    const no = caseNoOf(ev.id);
    const title = fresh
      ? (isHim() ? 'Self-report? Respect 🫡' : 'Yayyy! +2 ice creams 🍦🍦')
      : owe ? `Case #${no}` : 'Ice cream note 😋';
    const sub = fresh ? `📁 Case #${no} filed with FIA` : '';
    const ph = owe
      ? (isHim() ? 'e.g. what I was supposed to tell her…' : 'e.g. what he was supposed to tell me…')
      : 'e.g. best one yet';
    const label = owe ? 'Report to FIA (optional): kya baat thi?' : 'Note (optional)';

    const afterClose = () => {
      if (!fresh) return;
      if (pendingLetters().length) maybeLetters();
      else undoToast('+2 ice creams 🍦🍦', '📁 filed with FIA');
    };
    openSheet(
      `<h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}
       <label for="noteIn">${esc(label)}</label>
       <textarea id="noteIn" rows="3" maxlength="280" placeholder="${esc(ph)}">${esc(ev.note || '')}</textarea>
       <div class="sheet-actions">
         ${fresh ? '<button class="link-btn" data-act="undo">Oops, undo</button><span class="spacer"></span>' : ''}
         <button class="btn btn-plain" data-act="skip">${fresh ? 'Skip' : 'Cancel'}</button>
         <button class="btn" data-act="save">${fresh ? 'File it 📁' : 'Save'}</button>
       </div>`,
      (root) => {
        root.querySelector('[data-act="skip"]').onclick = () => closeSheet();
        const u = root.querySelector('[data-act="undo"]');
        if (u) u.onclick = doUndo;
        root.querySelector('[data-act="save"]').onclick = async (e) => {
          e.target.disabled = true;
          const note = root.querySelector('#noteIn').value.trim() || null;
          try {
            const res = await api(`/events/${ev.id}`, 'PATCH', { note });
            setState(res.state);
            closeSheet(true);
            renderAll();
            if (fresh && pendingLetters().length) maybeLetters();
            else if (fresh) undoToast('Filed 📁', 'FIA is on it');
            else toast('Saved 📁');
          } catch (err) {
            e.target.disabled = false;
            handleErr(err);
          }
        };
      },
      afterClose
    );
  }

  // ---------- 📸 scrapbook: post an ice cream ----------
  // The original photo is uploaded untouched (full resolution); the phone also makes
  // a small preview for the polaroid wall. Photo required; everything else optional.
  const THUMB_MAX = 720;

  async function makeThumb(file) {
    let img;
    try {
      img = await createImageBitmap(file);
    } catch {
      img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = URL.createObjectURL(file);
      });
    }
    const w = img.width;
    const h = img.height;
    const k = Math.min(1, THUMB_MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return { blob, width: w, height: h };
  }

  // XHR (not fetch) so we can show upload progress for big originals.
  function uploadPost(form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', C.API_URL + '/posts');
      xhr.setRequestHeader('X-Pin', pin || '');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error(data.error || 'http_' + xhr.status);
        err.status = xhr.status;
        err.data = data;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(form);
    });
  }

  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.hidden = true;
  document.body.appendChild(photoInput);
  $('openEat').addEventListener('click', () => {
    if (!state) return;
    photoInput.value = '';
    photoInput.click();
  });
  photoInput.addEventListener('change', () => {
    const file = photoInput.files && photoInput.files[0];
    if (file) openPostSheet(file);
  });

  const cones = (n, max = 5) =>
    Array.from({ length: max }, (_, i) => `<span class="${i < n ? 'on' : ''}">🍦</span>`).join('');

  function openPostSheet(file) {
    const pending = state.totals.pending;
    const preview = URL.createObjectURL(file);
    let rating = null;
    let flavour = null;
    let shopId = (state.shops.find((s) => s.isNext) || {}).id || null;
    let paid = false;
    let qty = Math.min(2, pending);
    const chips = (items, attr, selected) =>
      items.map((it) => `<button class="chip" data-${attr}="${esc(it.id)}" aria-pressed="${it.id === selected}">${esc(it.label)}</button>`).join('');

    openSheet(
      `<h3>Ice cream! 📸</h3>
       <div class="post-preview"><img src="${preview}" alt="Your photo"></div>
       <label>Rate it (optional)</label>
       <div class="rate" id="rate">${Array.from({ length: 5 }, (_, i) => `<button class="rate-cone" data-rate="${i + 1}" aria-label="${i + 1} out of 5">🍦</button>`).join('')}</div>
       <label for="postNote">Note (optional)</label>
       <textarea id="postNote" rows="2" maxlength="280" placeholder="e.g. best one yet"></textarea>
       ${state.shops.length ? `<label>Where? (optional)</label><div class="chips" id="shopChips">${chips(state.shops.map((s) => ({ id: s.id, label: s.name })), 'shop', shopId)}</div>` : ''}
       <label>Flavour (optional)</label>
       <div class="chips" id="flavChips">${chips(C.FLAVOURS.map((f) => ({ id: f.key, label: `${f.emoji} ${f.name}` })), 'flav')}</div>
       ${pending > 0 ? `
       <div class="paid-toggle">
         <button class="chip" id="paidChip" aria-pressed="false">🍦 Counts toward the debt</button>
         <div class="stepper" id="paidStepper" hidden>
           <button class="btn" data-step="-1" aria-label="One less">−</button>
           <output id="qtyOut">${qty}</output>
           <button class="btn" data-step="1" aria-label="One more">+</button>
         </div>
       </div>` : ''}
       <div class="upload-bar" id="uploadBar" hidden><i></i><span>Uploading…</span></div>
       <div class="sheet-actions">
         <button class="btn btn-plain" data-act="cancel">Cancel</button>
         <button class="btn btn-mint" data-act="save">Post it 📸</button>
       </div>`,
      (root) => {
        root.querySelector('#rate').addEventListener('click', (e) => {
          const b = e.target.closest('[data-rate]');
          if (!b) return;
          rating = rating === +b.dataset.rate ? null : +b.dataset.rate;
          root.querySelectorAll('.rate-cone').forEach((c) => c.classList.toggle('on', rating !== null && +c.dataset.rate <= rating));
          sfx.tap();
        });
        const single = (box, set) => box && box.addEventListener('click', (e) => {
          const c = e.target.closest('.chip');
          if (!c) return;
          const on = c.getAttribute('aria-pressed') !== 'true';
          box.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
          c.setAttribute('aria-pressed', String(on));
          set(on ? c : null);
        });
        single(root.querySelector('#flavChips'), (c) => { flavour = c ? c.dataset.flav : null; });
        single(root.querySelector('#shopChips'), (c) => { shopId = c ? +c.dataset.shop : null; });
        const paidChip = root.querySelector('#paidChip');
        if (paidChip) {
          paidChip.onclick = () => {
            paid = !paid;
            paidChip.setAttribute('aria-pressed', String(paid));
            root.querySelector('#paidStepper').hidden = !paid;
          };
          root.querySelectorAll('[data-step]').forEach((b) => {
            b.onclick = () => {
              qty = Math.max(1, Math.min(pending, qty + +b.dataset.step));
              root.querySelector('#qtyOut').textContent = qty;
              sfx.tap();
            };
          });
        }
        root.querySelector('[data-act="cancel"]').onclick = () => closeSheet();
        root.querySelector('[data-act="save"]').onclick = async (e) => {
          const btn = e.target;
          btn.disabled = true;
          const bar = root.querySelector('#uploadBar');
          bar.hidden = false;
          const setBar = (f) => {
            bar.querySelector('i').style.width = Math.round(f * 100) + '%';
            bar.querySelector('span').textContent = f < 1 ? `Uploading… ${Math.round(f * 100)}%` : 'Almost there…';
          };
          setBar(0);
          try {
            const thumb = await makeThumb(file);
            const form = new FormData();
            form.append('photo', file, file.name || 'photo.jpg');
            form.append('thumb', thumb.blob, 'thumb.jpg');
            form.append('width', thumb.width);
            form.append('height', thumb.height);
            if (rating) form.append('rating', rating);
            const note = root.querySelector('#postNote').value.trim();
            if (note) form.append('note', note);
            if (shopId) form.append('shopId', shopId);
            if (flavour) form.append('flavour', flavour);
            if (paid) form.append('paidQty', qty);
            const res = await uploadPost(form, setBar);
            setState(res.state);
            closeSheet(true);
            URL.revokeObjectURL(preview);
            freshPostId = res.post.id;
            if (paid && res.post.paidQty) {
              lastMine = { at: Date.now() };
              $('parlour').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
              await renderAll({ animate: true });
              undoToast(`Posted 📸 · ${plural(res.post.paidQty, 'ice cream')} paid off`);
            } else {
              renderAll();
              toast('Posted 📸', { sub: 'Added to the scrapbook' });
            }
            sfx.yay();
            $('scrapbook').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
          } catch (err) {
            btn.disabled = false;
            bar.hidden = true;
            if (err.status === 400) toast("Couldn't post that 🥲", { sub: err.data.message });
            else if (err.message === 'network') toast('Upload failed 🥲', { sub: 'Check your connection and try again' });
            else if (err.status === 401) handleErr(err);
            else toast("Couldn't read that photo 🥲", { sub: 'Try another one' });
          }
        };
      },
      () => URL.revokeObjectURL(preview)
    );
  }

  // ---------- 📸 scrapbook: polaroid wall + full-size viewer ----------
  const photoUrls = new Map(); // `${id}:${size}` → object URL (photos never change)
  let freshPostId = null;
  let scrapShown = 6;

  async function photoUrl(id, size) {
    const key = `${id}:${size}`;
    if (photoUrls.has(key)) return photoUrls.get(key);
    const res = await fetch(`${C.API_URL}/posts/${id}/photo?size=${size}`, { headers: { 'X-Pin': pin || '' } });
    if (!res.ok) throw new Error('photo_' + res.status);
    const url = URL.createObjectURL(await res.blob());
    photoUrls.set(key, url);
    return url;
  }

  const flagOf = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '');
  const countryName = (cc) => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { return cc; }
  };
  const tiltOf = (id) => ((id * 37) % 7) - 3; // stable little tilt per polaroid

  function polaroidHTML(p) {
    const d = new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<button class="polaroid${p.id === freshPostId ? ' fresh' : ''}" data-post="${p.id}" style="--tilt:${tiltOf(p.id)}deg" aria-label="Photo by ${esc(p.by)}">
      <span class="pol-photo"><img alt="" data-thumb="${p.id}"></span>
      <span class="pol-caption">
        ${p.rating ? `<span class="pol-rating">${cones(p.rating)}</span>` : ''}
        ${p.note ? `<span class="pol-note">“${esc(p.note)}”</span>` : ''}
        <span class="pol-meta">${esc(p.by)} · ${d}${p.country ? ' · ' + flagOf(p.country) : ''}</span>
        ${(p.reactions || []).length || (p.comments || []).length ? `<span class="pol-social">${(p.reactions || []).map((r) => r.emoji).join('')}${(p.comments || []).length ? ` 💬 ${p.comments.length}` : ''}</span>` : ''}
      </span>
    </button>`;
  }

  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const img = en.target;
      thumbObserver.unobserve(img);
      photoUrl(+img.dataset.thumb, 'thumb').then((u) => { img.src = u; }).catch(() => img.classList.add('broken'));
    });
  }, { rootMargin: '300px' });

  function renderScrapbook() {
    const posts = state.posts || [];
    const list = posts.slice(0, scrapShown);
    $('scrapCount').textContent = posts.length ? `${posts.length}` : '';
    $('scrapWall').innerHTML = list.length
      ? list.map(polaroidHTML).join('')
      : `<p class="scrap-empty">No polaroids yet. Next ice cream, tap <b>📸 Ice cream!</b></p>`;
    $('scrapMore').hidden = posts.length <= scrapShown;
    $('scrapWall').querySelectorAll('img[data-thumb]').forEach((img) => thumbObserver.observe(img));
    freshPostId = null;
  }
  $('scrapMore').addEventListener('click', () => { scrapShown += 12; renderScrapbook(); });
  $('scrapWall').addEventListener('click', (e) => {
    const b = e.target.closest('[data-post]');
    if (b) openPhoto(+b.dataset.post);
  });

  function openPhoto(id) {
    const p = (state.posts || []).find((x) => x.id === id);
    if (!p) return;
    const shop = (state.shops.find((s) => s.id === p.shopId) || {}).name;
    const f = p.flavour ? Art.flavour(p.flavour) : null;
    const when = new Date(p.createdAt);
    const canDelete = p.by === state.me || isHim();
    const tag = (t) => `<span class="pv-tag">${t}</span>`;
    const tags = [
      tag(`🕐 ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`),
      p.country ? tag(`${flagOf(p.country)} ${esc(countryName(p.country))}`) : '',
      shop ? tag(`📍 ${esc(shop)}`) : '',
      f && f.key === p.flavour ? tag(`${f.emoji} ${esc(f.name)}`) : '',
      p.paidQty ? tag(`🍦 −${p.paidQty} off the debt`) : '',
    ].join('');
    $('photoView').hidden = false;
    document.documentElement.style.overflow = 'hidden'; // the page behind shouldn't scroll
    $('photoView').scrollTop = 0;
    $('photoView').innerHTML = `
      <button class="pv-close" data-pv="close" aria-label="Close">✕</button>
      <article class="pv-card">
        <figure class="pv-polaroid" style="--tilt:${tiltOf(id) / 2}deg">
          <div class="pv-photo"><img id="pvImg" alt="Ice cream photo by ${esc(p.by)}"><span class="pv-loading" id="pvLoading">loading full size…</span></div>
          <figcaption>
            ${p.rating ? `<span class="pol-rating pv-rating">${cones(p.rating)}</span>` : ''}
            ${p.note ? `<span class="pv-note">“${esc(p.note)}”</span>` : ''}
            <span class="pv-by">${esc(p.by)} · ${when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </figcaption>
        </figure>
        <div class="pv-tags">${tags}</div>
        <div id="pvSocial"></div>
        <form class="pv-comment" id="pvCommentForm">
          <textarea id="pvCommentIn" rows="1" maxlength="500" placeholder="Say something…"></textarea>
          <button class="btn btn-small" type="submit">Send</button>
        </form>
        <div class="pv-actions">
          <button class="btn btn-small btn-plain" data-pv="save">💾 Save photo</button>
          ${canDelete ? '<button class="link-btn danger" data-pv="delete">Delete</button>' : ''}
        </div>
      </article>`;
    openPhotoId = id;
    renderPhotoSocial();
    const commentIn = $('pvCommentIn');
    commentIn.addEventListener('input', () => { commentIn.style.height = 'auto'; commentIn.style.height = Math.min(commentIn.scrollHeight, 120) + 'px'; });
    $('pvCommentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = commentIn.value.trim();
      if (!text) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        const res = await api(`/posts/${id}/comments`, 'POST', { text });
        setState(res.state);
        commentIn.value = '';
        commentIn.style.height = '';
        renderAll();
        sfx.tap();
        const list = $('pvSocial').querySelector('.pv-thread');
        if (list) list.scrollTop = list.scrollHeight;
      } catch (err) { handleErr(err); }
      btn.disabled = false;
    });
    const img = $('pvImg');
    photoUrl(id, 'thumb').then((u) => { if (!img.src) img.src = u; }).catch(() => {});
    photoUrl(id, 'full')
      .then((u) => { img.src = u; $('pvLoading').hidden = true; })
      .catch(() => { $('pvLoading').textContent = "Couldn't load the full photo"; });

    $('photoView').onclick = async (e) => {
      const react = e.target.closest('[data-react]');
      if (react) return setReaction(id, react.dataset.react);
      const delC = e.target.closest('[data-del-comment]');
      if (delC) {
        if (delC.dataset.sure !== '1') { delC.dataset.sure = '1'; delC.textContent = 'delete?'; return; }
        try {
          const res = await api(`/posts/${id}/comments/${delC.dataset.delComment}`, 'DELETE');
          setState(res.state);
          renderAll();
        } catch (err) { handleErr(err); }
        return;
      }
      const act = e.target.closest('[data-pv]')?.dataset.pv;
      if (act === 'close' || e.target === $('photoView')) return closePhoto();
      if (act === 'save') return savePhoto(id);
      if (act === 'delete') {
        const b = e.target.closest('[data-pv]');
        if (b.dataset.sure !== '1') {
          b.dataset.sure = '1';
          b.textContent = p.paidQty ? 'Sure? This also undoes the pay-off' : 'Sure? Tap again';
          return;
        }
        try {
          const res = await api(`/posts/${id}`, 'DELETE');
          setState(res.state);
          closePhoto();
          renderAll({ animate: true });
          toast('Polaroid deleted');
        } catch (err) { handleErr(err); }
      }
    };
  }
  function closePhoto() {
    openPhotoId = null;
    document.documentElement.style.overflow = '';
    $('photoView').hidden = true;
    $('photoView').innerHTML = '';
  }

  // Reactions + comments under the open photo (re-rendered when state refreshes;
  // the comment box itself is left alone so a half-typed message survives).
  const REACTIONS = ['🍦', '🍨', '🍧', '😋', '😂', '🔥', '👀', '😭', '🫡', '❤️', '🩷', '💛', '🤍'];
  let openPhotoId = null;

  function renderPhotoSocial() {
    const box = $('pvSocial');
    const p = openPhotoId && (state.posts || []).find((x) => x.id === openPhotoId);
    if (!box || !p) return;
    const mine = (p.reactions || []).find((r) => r.who === state.me);
    const theirs = (p.reactions || []).filter((r) => r.who !== state.me);
    const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    box.innerHTML = `
      <h4 class="pv-h">React</h4>
      <div class="pv-reacts">
        ${REACTIONS.map((e) => `<button class="react${mine && mine.emoji === e ? ' on' : ''}" data-react="${e}" aria-pressed="${!!(mine && mine.emoji === e)}">${e}</button>`).join('')}
      </div>
      ${theirs.length ? `<div class="pv-reacted">${theirs.map((r) => `${esc(r.who)} reacted ${r.emoji}`).join(' · ')}</div>` : ''}
      <h4 class="pv-h">💬 Chat</h4>
      ${(p.comments || []).length ? `<ul class="pv-thread">
        ${p.comments.map((c) => `<li class="cm${c.by === state.me ? ' mine' : ''}">
          <span class="cm-text">${esc(c.text)}</span>
          <span class="cm-meta">${c.by === state.me ? '' : esc(c.by) + ' · '}${day(c.createdAt)} ${time(c.createdAt)}
            ${c.by === state.me || isHim() ? `<button class="cm-del" data-del-comment="${c.id}" aria-label="Delete comment">×</button>` : ''}</span>
        </li>`).join('')}
      </ul>` : '<p class="pv-empty">No messages yet. Say something about it 👇</p>'}`;
    const list = box.querySelector('.pv-thread');
    if (list) list.scrollTop = list.scrollHeight;
  }

  async function setReaction(id, emoji) {
    const p = (state.posts || []).find((x) => x.id === id);
    const mine = p && (p.reactions || []).find((r) => r.who === state.me);
    const next = mine && mine.emoji === emoji ? null : emoji; // tap your own reaction again to remove it
    sfx.tap();
    buzz(10);
    try {
      const res = await api(`/posts/${id}/reaction`, 'PUT', { emoji: next });
      setState(res.state);
      renderAll();
      if (next) {
        const b = $('pvSocial').querySelector(`[data-react="${next}"]`);
        if (b) burst(b, { particleCount: 18, spread: 50, startVelocity: 18, scalar: 0.7 });
      }
    } catch (err) { handleErr(err); }
  }

  // Deep links from notifications: #post-<id> opens that photo once logged in.
  let pendingPost = null;
  function openDeepLink(url) {
    const m = /#post-(\d+)/.exec(url || '');
    if (!m) return false;
    pendingPost = +m[1];
    history.replaceState(null, '', location.pathname);
    if (state && !$('app').hidden) {
      showView('main', false);
      openPhoto(pendingPost);
      pendingPost = null;
    }
    return true;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open') openDeepLink(e.data.url);
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('photoView').hidden) closePhoto(); });

  // On iPhone the share sheet has "Save Image"; elsewhere fall back to a download.
  async function savePhoto(id) {
    try {
      const url = await photoUrl(id, 'full');
      const blob = await (await fetch(url)).blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const file = new File([blob], `ice-cream-${id}.${ext}`, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') toast("Couldn't save it 🥲");
    }
  }

  // ---------- case files view ----------
  const fmtDate = (ms) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()}`;
  };
  const fmtGap = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1 min';
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h`;
    return `${Math.round(h / 24)} days`;
  };

  let prevStatus = new Map();
  function renderCases() {
    const info = caseInfo();
    const { pending, eaten } = state.totals;
    const counts = info.reduce((n, c) => n + (c.e.type === 'owe' ? c.to - c.from + 1 : 0), 0);

    $('wanted').innerHTML = `
      <h2>WANTED</h2>
      ${Art.mugshot()}
      <div class="name">${esc(C.HIM.toUpperCase())}</div>
      <div class="crime">for <b>${counts}</b> counts of “baad mein bataonga”</div>
      <div class="reward">${pending ? `Reward: ${plural(pending, 'ice cream')} 🍦` : 'Paid in full… for now 👀'}</div>`;

    const real = chronological().filter((e) => e.type === 'owe' && e.by !== 'system');
    const lastOwe = real[real.length - 1];
    const days = lastOwe ? Math.floor((now() - lastOwe.createdAt) / 86400000) : null;
    const months = {};
    real.forEach((e) => {
      const k = new Date(e.createdAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      months[k] = (months[k] || 0) + 1;
    });
    const worst = Object.entries(months).sort((a, b) => b[1] - a[1])[0];
    let fastest = null;
    for (let i = 1; i < real.length; i++) {
      const g = real[i].createdAt - real[i - 1].createdAt;
      if (fastest === null || g < fastest) fastest = g;
    }
    const selfReports = real.filter((e) => e.by === C.HIM).length;
    const stats = [
      [days === null ? '—' : days === 0 ? 'Today' : plural(days, 'day'), days === 0 ? 'last “baad mein bataonga”' : 'since the last one'],
      [counts, 'times said, all time'],
      [eaten, 'ice creams eaten 😋'],
      [worst ? worst[0].split(' ')[0] : '—', worst ? `worst month (${worst[1]}×)` : 'worst month'],
      [fastest === null ? '—' : fmtGap(fastest), 'fastest repeat'],
      [selfReports, `self-reports by ${C.HIM} 🫡`],
    ];
    renderSurprises();
    $('stats').innerHTML = stats.map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');

    const shopName = (id) => (state.shops.find((s) => s.id === id) || {}).name;
    const next = new Map();
    $('cases').innerHTML = info
      .slice()
      .reverse()
      .map((c) => {
        const e = c.e;
        const noteHTML = e.note && !c.archive ? `<div class="case-note">“${esc(e.note)}”</div>` : '';
        const edit = c.archive ? '' : `<button class="case-edit" data-id="${e.id}">${e.note ? 'Edit note' : '+ Add note'}</button>`;
        if (e.type === 'paid') {
          const f = e.flavour ? Art.flavour(e.flavour) : null;
          const where = shopName(e.shopId);
          return `<li class="case paid">
            <div class="case-head"><span class="case-no">😋 Ice cream time</span><span class="case-date">${fmtDate(e.createdAt)}</span></div>
            <div class="case-body" style="padding-right:0">
              <div>${plural(e.qty, 'ice cream')} eaten${where ? ` at ${esc(where)}` : ''}${f && f.key === e.flavour ? ` · ${f.emoji} ${esc(f.name)}` : ''}</div>
              <div class="muted" style="font-size:14px">Logged by ${esc(e.by)}</div>
              ${noteHTML}${edit}
            </div></li>`;
        }
        next.set(e.id, c.status);
        const thunk = prevStatus.has(e.id) && prevStatus.get(e.id) !== c.status ? ' thunk' : '';
        const stamp = c.status === 'closed' ? 'CASE<br>CLOSED 🍦' : c.status === 'partial' ? `${c.left} LEFT` : 'PENDING';
        const head = c.archive
          ? `<span class="case-no">📦 The Archives</span><span class="case-date">Cases #${c.from}–${c.to}</span>`
          : `<span class="case-no">Case #${c.from}</span><span class="case-date">${fmtDate(e.createdAt)}</span>`;
        const body = c.archive
          ? `<div>${plural(e.qty, 'ice cream')} from before this website existed</div>`
          : `<div>Offence: said “baad mein bataonga” · 2 🍦</div><div class="muted" style="font-size:14px">Filed by ${esc(e.by)}</div>`;
        return `<li class="case${c.archive ? ' archive' : ''}">
          <div class="case-head">${head}</div>
          <div class="case-body">${body}${noteHTML}${edit}</div>
          <div class="stamp ${c.status}${thunk}">${stamp}</div></li>`;
      })
      .join('') || '<li class="cases-empty">No cases yet 🕵️</li>';
    prevStatus = next;
  }

  $('cases').addEventListener('click', (e) => {
    const b = e.target.closest('.case-edit');
    if (!b) return;
    const ev = state.events.find((x) => x.id === +b.dataset.id);
    openNoteSheet(ev);
  });

  // Views: main parlour, #cases, and #admin (Muneeb only).
  function showView(name, push = true) {
    if (name === 'admin' && !isHim()) name = 'main';
    $('viewMain').hidden = name !== 'main';
    $('viewCases').hidden = name !== 'cases';
    $('viewAdmin').hidden = name !== 'admin';
    $('countPill').classList.remove('show');
    if (name === 'cases') renderCases();
    if (name === 'admin') renderAdmin();
    scrollTo(0, 0);
    if (name === 'main' && map) setTimeout(() => map.invalidateSize(), 60);
    if (push && name !== 'main') history.pushState({ v: name }, '', '#' + name);
  }
  const showCases = (push) => showView('cases', push);
  const viewFromHash = () => ({ '#cases': 'cases', '#admin': 'admin' })[location.hash] || 'main';
  $('openCases').addEventListener('click', () => showView('cases'));
  $('adminBtn').addEventListener('click', () => showView('admin'));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
    if (history.state && history.state.v) history.back();
    else { history.replaceState(null, '', location.pathname); showView('main'); }
  }));
  addEventListener('popstate', () => showView(viewFromHash(), false));

  // Sticky count pill once the bell scrolls away.
  new IntersectionObserver(([entry]) => {
    $('countPill').classList.toggle('show', !entry.isIntersecting && !$('viewMain').hidden && !$('app').hidden);
  }).observe(document.querySelector('.bell-zone'));
  $('countPill').addEventListener('click', () => $('parlour').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }));

  // ---------- flavour wheel ----------
  let wheelRot = 0;
  let spinning = false;
  let slices = [];
  function initWheel() {
    const F = C.FLAVOURS;
    const total = F.reduce((s, f) => s + f.weight, 0);
    const cx = 150, cy = 150, R = 138;
    const pt = (a, r) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
    let a0 = 0;
    let svg = '';
    slices = F.map((f) => {
      const a1 = a0 + (f.weight / total) * 360;
      const [x0, y0] = pt(a0, R);
      const [x1, y1] = pt(a1, R);
      const mid = (a0 + a1) / 2;
      const [ex, ey] = pt(mid, R * 0.8);
      const label = f.short || f.name;
      const long = label.length > 8;
      svg += `<path d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${f.color}" stroke="#5A3A2E" stroke-width="2.5" stroke-linejoin="round"/>`;
      svg += `<text x="${ex.toFixed(1)}" y="${ey.toFixed(1)}" font-size="${f.weight > 1 ? 26 : 20}" text-anchor="middle" dominant-baseline="central">${f.emoji}</text>`;
      // Labels run along the radius; flip the left half so nothing reads upside down.
      const left = mid > 180;
      svg += `<text transform="rotate(${(left ? mid + 90 : mid - 90).toFixed(1)} ${cx} ${cy})" x="${left ? cx - R * 0.47 : cx + R * 0.47}" y="${cy}" font-size="${long ? 11 : 13}" font-weight="600" fill="#5A3A2E" text-anchor="middle" dominant-baseline="central" font-family="Fredoka, sans-serif">${esc(label)}</text>`;
      if (f.sparkle) {
        const [sx, sy] = pt(mid + (a1 - a0) * 0.28, R * 0.62);
        svg += `<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" font-size="13" text-anchor="middle" dominant-baseline="central">✨</text>`;
      }
      const s = { f, a0, a1 };
      a0 = a1;
      return s;
    });
    let bulbs = '';
    for (let i = 0; i < 24; i++) {
      const [bx, by] = pt(i * 15, R + 7);
      bulbs += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="3.4" fill="${i % 2 ? '#FFB5C8' : '#fff'}" stroke="#5A3A2E" stroke-width="1.5"/>`;
    }
    $('wheel').innerHTML =
      `<circle cx="${cx}" cy="${cy}" r="${R + 7}" fill="#FFF1D9" stroke="#5A3A2E" stroke-width="4"/>` +
      `<g class="wheel-spin" id="wheelSpin">${svg}</g>` +
      bulbs +
      `<circle cx="${cx}" cy="${cy}" r="27" fill="#FFFBF3" stroke="#5A3A2E" stroke-width="3.5"/>` +
      Art.face('closed', cx, cy - 3, 0.85);
    $('wheelPointer').innerHTML = Art.cone({ scoops: ['strawberry'], expr: 'happy' });
  }

  $('spinBtn').addEventListener('click', () => {
    if (spinning) return;
    spinning = true;
    $('spinBtn').disabled = true;
    $('wheelResult').textContent = '';
    // Pick by angle, so bigger slices (her favourites) come up more often.
    const target = Math.random() * 360;
    const slice = slices.find((s) => target >= s.a0 && target < s.a1) || slices[0];
    const inSlice = slice.a0 + (slice.a1 - slice.a0) * (0.2 + Math.random() * 0.6);
    const current = ((wheelRot % 360) + 360) % 360;
    wheelRot += 360 * 5 + ((360 - inSlice - current + 720) % 360);
    $('wheelSpin').style.transform = `rotate(${wheelRot}deg)`;

    if (!reduceMotion) {
      let gap = 50;
      let t = 0;
      while (t < 3800) { setTimeout(sfx.tick, t); t += gap; gap *= 1.09; }
    }
    setTimeout(() => {
      spinning = false;
      $('spinBtn').disabled = false;
      $('spinBtn').textContent = 'Spin again';
      const f = slice.f;
      const fav = f.sparkle ? (isHim() ? ' · her fav ⭐' : ' · your fav ⭐') : '';
      const r = $('wheelResult');
      r.textContent = `Aaj ka flavour: ${f.name} ${f.emoji}${fav}`;
      r.classList.remove('pop');
      void r.offsetWidth;
      r.classList.add('pop');
      sfx.yay();
      burst($('wheel'), { colors: [f.color, '#ffffff', '#FFB5C8', '#CDB4FF'], particleCount: 50 });
      api('/spin', 'POST', { flavour: f.key, name: f.name, emoji: f.emoji }).catch(() => {});
    }, reduceMotion ? 50 : 4300);
  });

  // ---------- map ----------
  let map = null;
  let markers = null;
  let markerById = new Map();
  let shopsSig = '';
  let picking = false;
  let fitted = false;

  function initMap() {
    if (!window.L) {
      $('map').innerHTML = '<p style="padding:16px;text-align:center">The map couldn\'t load 🥲</p>';
      return;
    }
    map = L.map('map', { scrollWheelZoom: false }).setView(C.MAP_CENTER, C.MAP_ZOOM);
    // Esri's street map: free, no key, and English labels for Karachi (OSM's are mostly Urdu script).
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    markers = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (!picking) return;
      stopPicking();
      openShopSheet(null, e.latlng);
    });
    $('map').addEventListener('click', (e) => {
      const b = e.target.closest('[data-shop-edit]');
      if (b) openShopSheet(state.shops.find((s) => s.id === +b.dataset.shopEdit));
    });
  }

  // Average polaroid rating per shop; the best-rated (2+ ratings, or the only rated
  // shop) gets a crown.
  function shopRatings() {
    const r = new Map();
    (state.posts || []).forEach((p) => {
      if (!p.shopId || !p.rating) return;
      const x = r.get(p.shopId) || { sum: 0, n: 0 };
      x.sum += p.rating;
      x.n += 1;
      r.set(p.shopId, x);
    });
    let best = null;
    r.forEach((x, id) => {
      x.avg = x.sum / x.n;
      if (!best || x.avg > r.get(best).avg || (x.avg === r.get(best).avg && x.n > r.get(best).n)) best = id;
    });
    return { r, best };
  }
  const ratingTag = (x) => (x ? `🍦 ${x.avg.toFixed(1)}<small> (${x.n})</small>` : '');

  function popupHTML(s, rating, crowned) {
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
    return `<b>${crowned ? '👑 ' : ''}${esc(s.name)}</b>${s.isNext ? ' ⭐' : ''}${s.visited ? ' ✅' : ''}
      ${s.area ? `<div style="color:#8A6A5C">${esc(s.area)}</div>` : ''}
      ${rating ? `<div style="margin-top:4px">${ratingTag(rating)}${crowned ? ' · our #1 spot' : ''}</div>` : ''}
      ${s.note ? `<div style="margin-top:4px">“${esc(s.note)}”</div>` : ''}
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="link-btn" style="padding:0" data-shop-edit="${s.id}">Edit</button>
        <a class="link-btn" style="padding:0" href="${dir}" target="_blank" rel="noopener">Directions 🧭</a>
      </div>`;
  }

  function renderShops() {
    const { r: ratings, best } = shopRatings();
    const sig = JSON.stringify([state.shops, [...ratings]]);
    if (sig === shopsSig) return;
    shopsSig = sig;
    // The ⭐ next spot is the top priority, so it leads the list.
    const shops = [...state.shops].sort((a, b) => b.isNext - a.isNext);

    $('spotList').innerHTML = shops.length
      ? shops.map((s) => `
        <li class="spot${s.isNext ? ' is-next' : ''}" data-id="${s.id}" tabindex="0">
          <span class="spot-icon">${Art.cone({ scoops: ['strawberry'], expr: s.isNext ? 'closed' : 'happy' })}</span>
          <span class="spot-main"><span class="spot-name">${s.id === best ? '👑 ' : ''}${esc(s.name)}</span><span class="spot-area" style="display:block">${esc(s.area || s.address || '')}</span></span>
          <span class="spot-tags">${ratingTag(ratings.get(s.id))}${s.isNext ? ' ⭐' : ''}${s.visited ? '✅' : ''}</span>
        </li>`).join('')
      : '<li class="muted" style="text-align:center">No spots yet. Add your favourite! 📍</li>';

    if (!map) return;
    markers.clearLayers();
    markerById = new Map();
    shops.forEach((s) => {
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: Art.pin(s.isNext), iconSize: [30, 50], iconAnchor: [15, 48], popupAnchor: [0, -46] }),
        title: s.name,
        zIndexOffset: s.isNext ? 1000 : 0, // the ⭐ next spot sits on top of nearby pins
      }).bindPopup(popupHTML(s, ratings.get(s.id), s.id === best));
      m.addTo(markers);
      markerById.set(s.id, m);
    });
    if (!fitted && shops.length) {
      fitted = true;
      map.fitBounds(L.latLngBounds(shops.map((s) => [s.lat, s.lng])), { padding: [40, 40], maxZoom: 14 });
    }
  }

  function focusSpot(id) {
    const m = markerById.get(id);
    if (!m || !map) return;
    $('map').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    map.flyTo(m.getLatLng(), 15, { duration: reduceMotion ? 0 : 0.8 });
    setTimeout(() => m.openPopup(), reduceMotion ? 0 : 850);
  }
  $('spotList').addEventListener('click', (e) => {
    const li = e.target.closest('.spot');
    if (li) focusSpot(+li.dataset.id);
  });
  $('spotList').addEventListener('keydown', (e) => {
    const li = e.target.closest('.spot');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusSpot(+li.dataset.id); }
  });

  function stopPicking() {
    picking = false;
    $('map').classList.remove('picking');
    $('addSpotBtn').textContent = '+ Add a spot';
    $('mapHint').textContent = 'Tap a spot for details';
  }
  $('addSpotBtn').addEventListener('click', () => {
    if (!map) return;
    if (picking) return stopPicking();
    picking = true;
    $('map').classList.add('picking');
    $('addSpotBtn').textContent = 'Cancel';
    $('mapHint').textContent = 'Tap the map where it is 👆';
    $('map').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  });

  function openShopSheet(shop, latlng) {
    const isNew = !shop;
    const s = shop || { name: '', area: '', note: '', isNext: false, visited: false };
    openSheet(
      `<h3>${isNew ? 'New ice cream spot 📍' : esc(s.name)}</h3>
       ${s.address ? `<p>${esc(s.address)}</p>` : ''}
       <label for="shopName">Name</label>
       <input type="text" id="shopName" maxlength="80" value="${esc(s.name)}" placeholder="e.g. Soft Swirl">
       <label for="shopArea">Area (optional)</label>
       <input type="text" id="shopArea" maxlength="80" value="${esc(s.area || '')}" placeholder="e.g. Gulshan-e-Iqbal">
       <label for="shopNote">Note (optional)</label>
       <textarea id="shopNote" rows="2" maxlength="280" placeholder="e.g. the brownie sundae 🤤">${esc(s.note || '')}</textarea>
       <div class="chips" style="margin-top:14px">
         <button class="chip" id="tNext" aria-pressed="${!!s.isNext}">⭐ Next spot</button>
         <button class="chip" id="tVisited" aria-pressed="${!!s.visited}">✅ Been here</button>
       </div>
       <div class="sheet-actions">
         ${isNew ? '' : '<button class="link-btn danger" data-act="del">Remove</button><span class="spacer"></span>'}
         <button class="btn btn-plain" data-act="cancel">Cancel</button>
         <button class="btn" data-act="save">Save</button>
       </div>`,
      (root) => {
        ['tNext', 'tVisited'].forEach((id) => {
          const c = root.querySelector('#' + id);
          c.onclick = () => c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true'));
        });
        root.querySelector('[data-act="cancel"]').onclick = () => closeSheet();
        const del = root.querySelector('[data-act="del"]');
        if (del) del.onclick = async () => {
          if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Sure? Tap again'; return; }
          try {
            const res = await api(`/shops/${s.id}`, 'DELETE');
            setState(res.state);
            closeSheet(true);
            renderAll();
            toast('Spot removed');
          } catch (err) { handleErr(err); }
        };
        root.querySelector('[data-act="save"]').onclick = async (e) => {
          const name = root.querySelector('#shopName').value.trim();
          if (!name) { root.querySelector('#shopName').focus(); return; }
          e.target.disabled = true;
          const fields = {
            name,
            area: root.querySelector('#shopArea').value.trim() || null,
            note: root.querySelector('#shopNote').value.trim() || null,
          };
          const isNext = root.querySelector('#tNext').getAttribute('aria-pressed') === 'true';
          const visited = root.querySelector('#tVisited').getAttribute('aria-pressed') === 'true';
          try {
            let res;
            if (isNew) {
              res = await api('/shops', 'POST', { ...fields, lat: latlng.lat, lng: latlng.lng });
              if (isNext || visited) res = await api(`/shops/${res.shop.id}`, 'PATCH', { isNext, visited });
            } else {
              res = await api(`/shops/${s.id}`, 'PATCH', { ...fields, isNext, visited });
            }
            setState(res.state);
            closeSheet(true);
            renderAll();
            if (map) map.closePopup();
            toast(isNew ? 'New spot added 📍' : 'Saved ✨');
          } catch (err) {
            e.target.disabled = false;
            handleErr(err);
          }
        };
      }
    );
  }

  // ---------- 🔔 notifications (Home Screen app only on iPhone) ----------
  const pushSupported = () =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:';

  const b64urlToBytes = (s64) => {
    const b = atob(s64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s64.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };

  // Must be called straight from a tap: iOS only shows the permission prompt then.
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm;
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/push/key', 'GET');
    const key = b64urlToBytes(publicKey);
    let sub;
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (err) {
      const old = await reg.pushManager.getSubscription(); // e.g. made with an older key
      if (!old) throw err;
      await old.unsubscribe();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await api('/push/subscribe', 'POST', sub.toJSON());
    return 'granted';
  }

  // After each login: re-register an existing subscription (so it follows whoever is
  // logged in on this phone), or offer the banner if notifications aren't on yet.
  async function syncPush() {
    $('notifBanner').hidden = true;
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && Notification.permission === 'granted') {
      api('/push/subscribe', 'POST', sub.toJSON()).catch(() => {});
      return;
    }
    if (Notification.permission === 'denied' || store.get('notifDismissed') === '1') return;
    $('notifBanner').hidden = false;
  }
  $('notifOn').addEventListener('click', async () => {
    try {
      const res = await enablePush();
      $('notifBanner').hidden = true;
      if (res === 'granted') toast('Notifications on 🔔', { sub: "You'll hear about the other one's ice creams" });
      else toast('Notifications are off', { sub: 'You can allow them later in Settings → Notifications' });
    } catch {
      toast("Couldn't turn them on 🥲", { sub: 'Open the site from the Home Screen icon and try again' });
    }
  });
  $('notifLater').addEventListener('click', () => {
    store.set('notifDismissed', '1');
    $('notifBanner').hidden = true;
  });

  // ---------- boot ----------
  sky();
  $('alooArt').innerHTML = Art.aloo();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  store.del('pin'); // clear PINs saved by the earlier version
  showLock();
})();
