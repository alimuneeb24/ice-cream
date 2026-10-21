// Hand-drawn SVG art. One style everywhere: soft chocolate outlines,
// pastel fills, round kawaii faces with blush.
(function () {
  const INK = '#5A3A2E';
  const BLUSH = '#FF8FB1';
  let uid = 0;

  const flavour = (key) =>
    APP_CONFIG.FLAVOURS.find((f) => f.key === key) || APP_CONFIG.FLAVOURS[0];

  // ---------- faces ----------
  function face(expr, cx, cy, s = 1) {
    const dx = 13 * s;
    let eyes;
    let mouth;
    const dot = (x) =>
      `<ellipse cx="${x}" cy="${cy}" rx="${3.4 * s}" ry="${4.2 * s}" fill="${INK}"/>` +
      `<circle cx="${x + 1.2 * s}" cy="${cy - 1.6 * s}" r="${1.2 * s}" fill="#fff"/>`;
    const arc = (x, up) =>
      `<path d="M${x - 4 * s} ${cy + (up ? 2 : -1) * s} Q${x} ${cy + (up ? -4 : 3) * s} ${x + 4 * s} ${cy + (up ? 2 : -1) * s}" fill="none" stroke="${INK}" stroke-width="${2.6 * s}" stroke-linecap="round"/>`;

    switch (expr) {
      case 'shocked':
        eyes =
          `<circle cx="${cx - dx}" cy="${cy}" r="${4.6 * s}" fill="${INK}"/><circle cx="${cx - dx + 1.5 * s}" cy="${cy - 1.8 * s}" r="${1.6 * s}" fill="#fff"/>` +
          `<circle cx="${cx + dx}" cy="${cy}" r="${4.6 * s}" fill="${INK}"/><circle cx="${cx + dx + 1.5 * s}" cy="${cy - 1.8 * s}" r="${1.6 * s}" fill="#fff"/>`;
        mouth = `<ellipse cx="${cx}" cy="${cy + 9 * s}" rx="${3 * s}" ry="${3.8 * s}" fill="${INK}"/>`;
        break;
      case 'closed': // happy ^ ^
        eyes = arc(cx - dx, true) + arc(cx + dx, true);
        mouth = `<path d="M${cx - 5 * s} ${cy + 6 * s} Q${cx} ${cy + 12 * s} ${cx + 5 * s} ${cy + 6 * s}" fill="${INK}" stroke="${INK}" stroke-width="${1.6 * s}" stroke-linejoin="round"/>`;
        break;
      case 'sleepy':
        eyes = arc(cx - dx, false) + arc(cx + dx, false);
        mouth = `<path d="M${cx - 3 * s} ${cy + 8 * s} Q${cx} ${cy + 10 * s} ${cx + 3 * s} ${cy + 8 * s}" fill="none" stroke="${INK}" stroke-width="${2.2 * s}" stroke-linecap="round"/>`;
        break;
      case 'cold':
        eyes = arc(cx - dx, false) + arc(cx + dx, false);
        mouth = `<path d="M${cx - 6 * s} ${cy + 9 * s} l${3 * s} ${-2 * s} l${3 * s} ${2 * s} l${3 * s} ${-2 * s} l${3 * s} ${2 * s}" fill="none" stroke="${INK}" stroke-width="${2 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      case 'yum':
        eyes = arc(cx - dx, true) + arc(cx + dx, true);
        mouth =
          `<path d="M${cx - 5 * s} ${cy + 6 * s} Q${cx} ${cy + 11 * s} ${cx + 5 * s} ${cy + 6 * s}" fill="none" stroke="${INK}" stroke-width="${2.4 * s}" stroke-linecap="round"/>` +
          `<ellipse cx="${cx + 3 * s}" cy="${cy + 10 * s}" rx="${2.4 * s}" ry="${2.8 * s}" fill="${BLUSH}" stroke="${INK}" stroke-width="${1.4 * s}"/>`;
        break;
      default: // happy
        eyes = dot(cx - dx) + dot(cx + dx);
        mouth = `<path d="M${cx - 4 * s} ${cy + 7 * s} Q${cx - 2 * s} ${cy + 10 * s} ${cx} ${cy + 7.5 * s} Q${cx + 2 * s} ${cy + 10 * s} ${cx + 4 * s} ${cy + 7 * s}" fill="none" stroke="${INK}" stroke-width="${2.2 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    const cheeks =
      `<ellipse cx="${cx - dx - 7 * s}" cy="${cy + 6 * s}" rx="${4.6 * s}" ry="${2.8 * s}" fill="${BLUSH}" opacity=".5"/>` +
      `<ellipse cx="${cx + dx + 7 * s}" cy="${cy + 6 * s}" rx="${4.6 * s}" ry="${2.8 * s}" fill="${BLUSH}" opacity=".5"/>`;

    return `<g class="face face-${expr}"><g class="eyes" style="transform-origin:${cx}px ${cy}px">${eyes}</g>${cheeks}<g class="mouth">${mouth}</g></g>`;
  }

  // ---------- scoop ----------
  const SCOOP =
    'M-37 4 C-39 -24 -20 -38 0 -38 C20 -38 39 -24 37 4 C36 12 31 13 27 11 C25 19 19 21 15 15 C12 22 4 23 1 16 C-3 21 -10 21 -12 14 C-16 19 -24 19 -26 11 C-31 14 -36 11 -37 4 Z';
  const SPRINKLES = [
    [-14, -16, 30, '#FF7FA8'], [8, -26, -20, '#7FD9C4'], [19, -10, 62, '#B79CFF'],
    [-24, -2, -48, '#FFC94D'], [2, -8, 12, '#ffffff'], [-4, -28, 80, '#7FD9C4'],
  ];

  function scoop(key, cls = '') {
    const [base, extra] = key.split(':');
    const f = flavour(base);
    let deco = '';
    if (f.sprinkles || extra === 'rainbow') {
      deco += SPRINKLES.map(
        ([x, y, r, c]) =>
          `<rect x="${x - 3.5}" y="${y - 1.3}" width="7" height="2.6" rx="1.3" fill="${c}" transform="rotate(${r} ${x} ${y})"/>`
      ).join('');
    }
    if (f.specks) {
      deco += [[-14, -14], [10, -22], [18, -4], [-22, 0], [0, -4], [-4, -26], [24, -18]]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4" fill="#6B4433"/>`)
        .join('');
    }
    return (
      `<g class="scoop ${cls}" data-flavour="${f.key}">` +
      `<path d="${SCOOP}" fill="${f.color}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<ellipse cx="-17" cy="-21" rx="8" ry="4.5" transform="rotate(-35 -17 -21)" fill="#fff" opacity=".65"/>` +
      `<circle cx="-6" cy="-29" r="2" fill="#fff" opacity=".65"/>` +
      deco +
      `</g>`
    );
  }

  // ---------- cone ----------
  const CONE = 'M20 100 Q60 92 100 100 L65 186 Q60 196 55 186 Z';

  function waffle() {
    let out = '';
    for (let d = -100; d <= 200; d += 15) {
      out += `<line x1="${d}" y1="90" x2="${d + 100}" y2="195"/><line x1="${d + 100}" y1="90" x2="${d}" y2="195"/>`;
    }
    return out;
  }

  // A cherry that sits on the top scoop (unlocked at 40).
  function cherry(cls = '') {
    return (
      `<g class="cherry ${cls}">` +
      `<path d="M2 -12 Q6 -26 16 -30" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>` +
      `<circle cx="0" cy="-4" r="9" fill="#FF6B81" stroke="${INK}" stroke-width="2.6"/>` +
      `<circle cx="-3" cy="-7" r="2.6" fill="#fff" opacity=".8"/>` +
      `</g>`
    );
  }

  // scoops: array of flavour keys (bottom first). scoopClasses: per-scoop extra classes.
  // Upgrades: cherry (40), rainbow sprinkles (90), golden cone (100).
  function cone({ scoops = [], expr = 'happy', scoopClasses = [], cherry: withCherry, rainbow, golden } = {}) {
    const id = 'cw' + ++uid;
    const scoopEls = scoops
      .map((k, i) => {
        const f = flavour(k);
        const key = rainbow && !f.sprinkles && !f.specks ? k + ':rainbow' : k;
        return `<g transform="translate(60 ${i ? 60 : 94})${i ? ' scale(.92)' : ''}">${scoop(key, scoopClasses[i] || '')}</g>`;
      })
      .join('');
    const top = scoops.length ? (scoops.length > 1 ? 60 - 35 : 94 - 38) : null;
    const cherryEl = withCherry && top !== null
      ? `<g transform="translate(62 ${top + 6})">${cherry(scoopClasses[scoops.length - 1] || '')}</g>`
      : '';
    const fill = golden ? '#FFD86B' : '#F7CD96';
    const lines = golden ? '#E8B23A' : '#E5A867';
    return (
      `<svg class="cone-svg${golden ? ' golden' : ''}" viewBox="0 0 120 200" aria-hidden="true">` +
      `<defs><clipPath id="${id}"><path d="${CONE}"/></clipPath></defs>` +
      `<g class="cone-body">` +
      `<path d="${CONE}" fill="${fill}"/>` +
      `<g clip-path="url(#${id})" stroke="${lines}" stroke-width="2.4" opacity=".55">${waffle()}</g>` +
      `<ellipse cx="60" cy="99" rx="39" ry="5.5" fill="${lines}"/>` +
      (golden ? `<path d="M34 112 L40 104 M84 150 l4 -6" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>` : '') +
      `<path d="${CONE}" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      face(expr, 60, 130) +
      `</g>` +
      `<g class="scoops">${scoopEls}${cherryEl}</g>` +
      `</svg>`
    );
  }

  // ---------- counter bell ----------
  function bell() {
    return (
      `<svg class="bell-svg" viewBox="0 0 180 160" aria-hidden="true">` +
      `<g class="bell-waves" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round">` +
      `<path class="wave wave-l" d="M22 70 Q12 82 22 94"/><path class="wave wave-l2" d="M10 62 Q-4 82 10 102"/>` +
      `<path class="wave wave-r" d="M158 70 Q168 82 158 94"/><path class="wave wave-r2" d="M170 62 Q184 82 170 102"/>` +
      `</g>` +
      `<g class="bell-body">` +
      `<g class="bell-plunger"><rect x="83" y="22" width="14" height="22" rx="5" fill="#E8C3FF" stroke="${INK}" stroke-width="3"/>` +
      `<circle cx="90" cy="20" r="11" fill="#FFB0C6" stroke="${INK}" stroke-width="3"/><circle cx="86" cy="16" r="3" fill="#fff" opacity=".8"/></g>` +
      `<path class="bell-dome" d="M34 122 C34 72 58 44 90 44 C122 44 146 72 146 122 Z" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<path d="M52 104 C52 80 64 62 82 56" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".7"/>` +
      `<g class="bell-face">${face('closed', 90, 96, 1.25)}</g>` +
      `<g class="bell-cold">${face('cold', 90, 96, 1.25)}</g>` +
      `<g class="bell-frost" fill="#fff">` +
      `<path d="M34 122 C34 72 58 44 90 44 C122 44 146 72 146 122 Z" fill="#E3F6FF" opacity=".55"/>` +
      `<text x="56" y="80" font-size="16">❄</text><text x="112" y="72" font-size="13">❄</text><text x="122" y="108" font-size="11">❄</text>` +
      `</g>` +
      `<rect x="20" y="118" width="140" height="26" rx="13" fill="#CDB4FF" stroke="${INK}" stroke-width="3.5"/>` +
      `<rect x="34" y="124" width="40" height="6" rx="3" fill="#fff" opacity=".55"/>` +
      `</g>` +
      `</svg>`
    );
  }

  // ---------- Agent Aloo (FIA) ----------
  function aloo() {
    return (
      `<svg class="aloo-svg" viewBox="0 0 160 170" aria-hidden="true">` +
      // magnifying glass
      `<g class="aloo-glass"><line x1="132" y1="104" x2="150" y2="128" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>` +
      `<circle cx="124" cy="94" r="16" fill="#E3F6FF" stroke="${INK}" stroke-width="4"/><path d="M116 88 Q120 82 126 82" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></g>` +
      // potato
      `<path d="M30 92 C26 56 52 40 80 42 C112 44 132 64 128 100 C124 140 100 160 74 158 C44 156 34 128 30 92 Z" fill="#E9C48F" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<g fill="#C99A62" opacity=".7"><ellipse cx="48" cy="122" rx="4" ry="3"/><ellipse cx="106" cy="134" rx="3.5" ry="2.6"/><ellipse cx="60" cy="146" rx="3" ry="2.2"/><ellipse cx="114" cy="112" rx="3" ry="2.4"/></g>` +
      `<path d="M44 74 C46 64 56 58 64 58" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".55"/>` +
      // arm holding glass
      `<path d="M120 110 Q130 106 128 98" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>` +
      // sunglasses + suspicious brow
      `<g class="aloo-shades"><rect x="46" y="82" width="28" height="16" rx="8" fill="${INK}"/><rect x="82" y="82" width="28" height="16" rx="8" fill="${INK}"/>` +
      `<rect x="72" y="86" width="12" height="4" rx="2" fill="${INK}"/><rect x="51" y="85" width="9" height="3" rx="1.5" fill="#fff" opacity=".5"/><rect x="87" y="85" width="9" height="3" rx="1.5" fill="#fff" opacity=".5"/></g>` +
      `<path class="aloo-brow" d="M84 74 L106 68" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>` +
      `<path d="M70 114 Q80 110 90 113" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>` +
      `<ellipse cx="50" cy="106" rx="6" ry="3.5" fill="${BLUSH}" opacity=".5"/><ellipse cx="110" cy="106" rx="6" ry="3.5" fill="${BLUSH}" opacity=".5"/>` +
      // FIA badge
      `<g transform="translate(56 132) rotate(-8)"><path d="M0 -12 L12 -8 L12 4 Q12 12 0 16 Q-12 12 -12 4 L-12 -8 Z" fill="#FFD77A" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<text x="0" y="5" text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="700" font-size="8.5" fill="${INK}">FIA</text></g>` +
      // fedora
      `<g class="aloo-hat"><ellipse cx="80" cy="50" rx="50" ry="10" fill="#8B5A44" stroke="${INK}" stroke-width="3.5"/>` +
      `<path d="M50 50 C50 24 60 14 80 14 C100 14 110 24 110 50 Z" fill="#8B5A44" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<path d="M66 18 Q80 26 94 18" stroke="${INK}" stroke-width="3" fill="none"/>` +
      `<rect x="51" y="38" width="58" height="9" fill="#FFB0C6" stroke="${INK}" stroke-width="3"/></g>` +
      `</svg>`
    );
  }

  // ---------- Most Wanted mugshot ----------
  function mugshot() {
    return (
      `<svg class="mug-svg" viewBox="0 0 140 140" aria-hidden="true">` +
      `<circle cx="70" cy="70" r="64" fill="#CDB4FF" stroke="${INK}" stroke-width="3.5"/>` +
      `<g opacity=".35" stroke="#fff" stroke-width="2">${[30, 50, 70, 90, 110].map((y) => `<line x1="12" y1="${y}" x2="128" y2="${y}"/>`).join('')}</g>` +
      `<path d="M34 132 C34 106 50 96 70 96 C90 96 106 106 106 132 Z" fill="#B8F2E6" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<circle cx="70" cy="66" r="30" fill="#F2CFA8" stroke="${INK}" stroke-width="3.5"/>` +
      `<path d="M41 62 C40 38 58 30 72 32 C88 32 100 42 99 60 C92 50 82 46 74 50 C66 44 54 48 41 62 Z" fill="#4A2E24" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="M70 34 Q74 22 84 24" stroke="#4A2E24" stroke-width="4" fill="none" stroke-linecap="round"/>` +
      face('happy', 70, 70, 0.9) +
      `<path d="M98 54 Q104 64 98 68 Q92 64 98 54 Z" fill="#9FDCFF" stroke="${INK}" stroke-width="2"/>` +
      `</svg>`
    );
  }

  // ---------- parlour upgrades ----------
  function flag(color) {
    return `<svg viewBox="0 0 20 24" aria-hidden="true"><path d="M1 1 H19 L10 22 Z" fill="${color}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  function pot(petal) {
    const petals = [0, 72, 144, 216, 288]
      .map((a) => `<ellipse cx="0" cy="-7" rx="5" ry="7" fill="${petal}" stroke="${INK}" stroke-width="1.8" transform="rotate(${a})"/>`)
      .join('');
    return (
      `<svg class="pot-svg" viewBox="0 0 60 84" aria-hidden="true">` +
      `<path d="M30 52 Q28 36 30 24" stroke="#6FBF73" stroke-width="3" fill="none" stroke-linecap="round"/>` +
      `<path d="M30 42 Q20 38 16 30 Q26 30 30 40" fill="#9FDC9F" stroke="${INK}" stroke-width="1.8"/>` +
      `<path d="M30 36 Q40 32 44 24 Q34 24 30 34" fill="#9FDC9F" stroke="${INK}" stroke-width="1.8"/>` +
      `<g transform="translate(30 20)"><g class="flower">${petals}<circle r="4.5" fill="#FFD77A" stroke="${INK}" stroke-width="1.8"/></g></g>` +
      `<path d="M12 52 H48 L43 80 Q42 82 40 82 H20 Q18 82 17 80 Z" fill="#F7B5A0" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<rect x="9" y="48" width="42" height="9" rx="4" fill="#F9C7B6" stroke="${INK}" stroke-width="2.5"/>` +
      face('closed', 30, 67, 0.55) +
      `</svg>`
    );
  }

  function cat() {
    return (
      `<svg class="cat-svg" viewBox="0 0 96 56" aria-hidden="true">` +
      `<path class="cat-tail" d="M74 44 Q92 40 88 26 Q86 18 80 22" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>` +
      `<path class="cat-tail" d="M74 44 Q92 40 88 26 Q86 18 80 22" fill="none" stroke="#FFE2C7" stroke-width="3.5" stroke-linecap="round"/>` +
      `<path d="M12 50 C10 30 24 22 44 22 C66 22 80 30 78 50 Z" fill="#FFE2C7" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="M16 28 L14 12 L28 22 Z M40 22 L48 10 L52 24 Z" fill="#FFE2C7" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
      `<path d="M18 22 L17 16 L23 20 Z" fill="#FFB5C8"/>` +
      `<path d="M22 36 Q25 39 28 36 M36 36 Q39 39 42 36" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<path d="M30 41 Q32 43 34 41" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>` +
      `<ellipse cx="20" cy="41" rx="3.5" ry="2" fill="${BLUSH}" opacity=".55"/><ellipse cx="44" cy="41" rx="3.5" ry="2" fill="${BLUSH}" opacity=".55"/>` +
      `<path d="M56 30 Q60 26 64 30" fill="none" stroke="#F2B98F" stroke-width="3" stroke-linecap="round"/>` +
      `</svg>`
    );
  }

  function balloon() {
    return (
      `<svg class="balloon-svg" viewBox="0 0 60 120" aria-hidden="true">` +
      `<path d="M30 52 Q24 72 32 88 Q38 102 30 118" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
      `<ellipse cx="30" cy="28" rx="21" ry="25" fill="#B8F2E6" stroke="${INK}" stroke-width="3"/>` +
      `<path d="M17 18 Q19 11 26 9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>` +
      `<path d="M27 53 L33 53 L30 58 Z" fill="#B8F2E6" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
      `</svg>`
    );
  }

  function crown() {
    return (
      `<svg class="crown-svg" viewBox="0 0 48 32" aria-hidden="true">` +
      `<path d="M4 28 L2 8 L14 18 L24 4 L34 18 L46 8 L44 28 Z" fill="#FFD77A" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>` +
      `<circle cx="24" cy="20" r="3" fill="#FF8FB1" stroke="${INK}" stroke-width="1.6"/>` +
      `<circle cx="12" cy="23" r="2.2" fill="#7FD9C4" stroke="${INK}" stroke-width="1.4"/><circle cx="36" cy="23" r="2.2" fill="#B79CFF" stroke="${INK}" stroke-width="1.4"/>` +
      `</svg>`
    );
  }

  // The bauni step stool 🪜
  function stool() {
    return (
      `<svg class="stool-svg" viewBox="0 0 64 60" aria-hidden="true">` +
      `<path d="M10 58 L16 18 M54 58 L48 18" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>` +
      `<rect x="8" y="12" width="48" height="10" rx="4" fill="#CDB4FF" stroke="${INK}" stroke-width="3"/>` +
      `<rect x="12" y="34" width="40" height="8" rx="4" fill="#B8F2E6" stroke="${INK}" stroke-width="3"/>` +
      `<rect x="14" y="14" width="14" height="3" rx="1.5" fill="#fff" opacity=".6"/>` +
      `</svg>`
    );
  }

  function envelope() {
    return (
      `<svg class="envelope-svg" viewBox="0 0 140 100" aria-hidden="true">` +
      `<rect x="6" y="20" width="128" height="76" rx="10" fill="#F0E8FF" stroke="${INK}" stroke-width="3.5"/>` +
      `<path d="M8 92 L58 56 M132 92 L82 56" stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"/>` +
      `<path class="env-flap" d="M8 24 Q8 20 12 20 H128 Q132 20 132 24 L76 64 Q70 68 64 64 Z" fill="#CDB4FF" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<g class="env-seal"><circle cx="70" cy="60" r="11" fill="#FFD77A" stroke="${INK}" stroke-width="2.5"/>` +
      `<circle cx="70" cy="60" r="5.5" fill="none" stroke="#fff" stroke-width="2" opacity=".75"/></g>` +
      `</svg>`
    );
  }

  // Small cone for map pins.
  function pin(starred) {
    return (
      `<div class="pin${starred ? ' pin-next' : ''}">` +
      cone({ scoops: ['strawberry'], expr: 'happy' }) +
      (starred ? '<span class="pin-star">⭐</span>' : '') +
      `</div>`
    );
  }

  window.Art = { cone, scoop, face, bell, aloo, mugshot, pin, flavour, flag, pot, cat, balloon, crown, stool, envelope };
})();
