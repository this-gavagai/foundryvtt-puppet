const path = require('path');

// All per-deployment config lives in secrets.json (gitignored), keyed by
// instance name, shaped as:
//   { "boom": { "url": "http://...", "userName": "...", "password": "..." }, ... }
// userName is the Foundry user's display name — since v14.367 the /join form
// takes the name, not the document id. `userId` is still accepted for servers
// on the older user-id <select> form.
// Each gets its own Chrome profile dir (derived from the name), so instances
// never collide on the userDataDir lock. Copy secrets.example.json ->
// secrets.json and fill it in on each host.
let secrets = {};
try {
  secrets = require('./secrets.json');
} catch {
  console.warn('[ecosystem] secrets.json not found — no instances will start. Copy secrets.example.json to secrets.json.');
}

module.exports = {
  apps: Object.entries(secrets).map(([name, cfg]) => {
    if (!cfg.url || !cfg.password || (!cfg.userName && !cfg.userId)) {
      throw new Error(`[ecosystem] instance "${name}" needs url, password, and userName (or legacy userId) in secrets.json`);
    }
    return {
      name: `puppet-${name}`,
      script: 'puppet.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '1G', // auto-recover from renderer memory bloat
      time: true,               // prefix log lines with timestamps
      env: {
        FOUNDRY_URL: cfg.url,
        // Omit when absent — pm2 would otherwise pass the literal "undefined".
        ...(cfg.userName ? { FOUNDRY_USER_NAME: cfg.userName } : {}),
        ...(cfg.userId ? { FOUNDRY_USER_ID: cfg.userId } : {}),
        FOUNDRY_PASSWORD: cfg.password,
        PUPPET_PROFILE_DIR: path.join(__dirname, 'profiles', name),
      },
    };
  }),
};
