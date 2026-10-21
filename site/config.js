// Everything you might want to tweak lives here.
(function () {
  const host = location.hostname;
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host);

  window.APP_CONFIG = {
    // Local demo goes through dev/serve.py (which forwards /api to `wrangler dev`);
    // production talks to the deployed Worker.
    API_URL: isLocal ? `${location.origin}/api` : 'https://icecream-tracker.REPLACE_ME.workers.dev',

    HER: 'Fiza',
    HIM: 'Muneeb',
    SHOP_NAME: "Fiza's Ice Creams",

    COOLDOWN_MS: 3 * 60 * 1000,
    UNDO_MS: 60 * 1000,
    POLL_MS: 20 * 1000,

    MAP_CENTER: [24.905, 67.09],
    MAP_ZOOM: 12,

    // Scoop flavours. `weight` sizes the slice on the flavour wheel.
    FLAVOURS: [
      { key: 'chocolate', name: 'Chocolate', emoji: '🍫', color: '#B07A5E', weight: 2, sparkle: true },
      { key: 'strawberry', name: 'Strawberry', emoji: '🍓', color: '#FFB0C6', weight: 2, sparkle: true, sprinkles: true },
      { key: 'mango', name: 'Mango', emoji: '🥭', color: '#FFD77A', weight: 1 },
      { key: 'pistachio', name: 'Pistachio', emoji: '🌰', color: '#C8E6A0', weight: 1 },
      { key: 'cookies', name: 'Cookies & Cream', short: 'Cookies', emoji: '🍪', color: '#F1EAE4', weight: 1, specks: true },
      { key: 'vanilla', name: 'Vanilla', emoji: '🤍', color: '#FFF3D6', weight: 1, sprinkles: true },
      { key: 'kulfi', name: 'Kulfi', emoji: '🥛', color: '#F7DFA8', weight: 1 },
      { key: 'caramel', name: 'Caramel', emoji: '🍯', color: '#F2C089', weight: 1 },
    ],

    // A surprise every 10 ice creams owed (all-time, so eating never re-locks anything).
    // Each one may carry a sealed note Muneeb writes ahead of time; up to 100 they
    // also add a permanent upgrade to the parlour. After 100 it's notes only.
    MILESTONE_FIRST: 20,
    MILESTONE_STEP: 10,
    UPGRADES: [
      { at: 20, key: 'bunting', name: 'Bunting flags', emoji: '🎀' },
      { at: 30, key: 'lights', name: 'Fairy lights', emoji: '✨' },
      { at: 40, key: 'cherry', name: 'A cherry on every cone', emoji: '🍒' },
      { at: 50, key: 'flowers', name: 'Flower pots by the bell', emoji: '🌸' },
      { at: 60, key: 'cat', name: 'A parlour cat', emoji: '🐱' },
      { at: 70, key: 'open', name: 'A glowing OPEN sign', emoji: '💡' },
      { at: 80, key: 'balloon', name: 'A heart balloon', emoji: '🎈' },
      { at: 90, key: 'rainbow', name: 'Rainbow sprinkles on everything', emoji: '🌈' },
      { at: 100, key: 'golden', name: 'Golden cones and a crown for the bell', emoji: '👑' },
    ],

    // Colour order for the scoops on the stand — mostly her favourites.
    SCOOP_PATTERN: [
      'strawberry', 'chocolate', 'strawberry', 'vanilla', 'chocolate',
      'strawberry', 'mango', 'chocolate', 'strawberry', 'pistachio',
    ],
  };
})();
