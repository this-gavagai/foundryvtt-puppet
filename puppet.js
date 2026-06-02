const path = require('path');
const puppeteer = require('puppeteer');

const FOUNDRY_URL = process.env.FOUNDRY_URL;
const FOUNDRY_USER_ID = process.env.FOUNDRY_USER_ID;
const FOUNDRY_PASSWORD = process.env.FOUNDRY_PASSWORD;
const USER_DATA_DIR = process.env.PUPPET_PROFILE_DIR || path.join(__dirname, 'profile');

// Credentials must come from the environment (see ecosystem.config.js /
// secrets.json) — no baked-in defaults, so a misconfigured deploy fails loudly
// instead of silently logging in with the wrong account.
if (!FOUNDRY_USER_ID || !FOUNDRY_PASSWORD) {
  console.error('[fatal] FOUNDRY_USER_ID and FOUNDRY_PASSWORD environment variables are required');
  process.exit(1);
}

// --- Tunables (all milliseconds) -------------------------------------------
const NAV_TIMEOUT = 60000;          // page.goto / waitForNavigation
const FORM_RACE_TIMEOUT = 30000;    // login-form vs game-ready race
const FORM_FIELD_TIMEOUT = 5000;    // individual login-form fields
const GAME_READY_TIMEOUT = 240000;  // full world load on a busy, modded server
const POLL_INTERVAL = 15000;        // foundry health poll
const JIGGLE_INTERVAL = 30000;      // mouse-move keepalive
const MEM_INTERVAL = 60000;         // memory snapshot
const RECONNECT_MAX_BACKOFF = 30000;
const RECONNECT_STALE_GUARD = 5000; // ignore reconnect triggers this soon after a success
const ORPHAN_EXIT_GRACE = 500;      // let chrome's 'exit' fire before we exit

// 24h + up to 30min jitter, so multiple instances don't all restart together
const DAILY_RESTART_MS = 24 * 60 * 60 * 1000 + Math.floor(Math.random() * 30 * 60 * 1000);

// Assigned once the browser launches; exitWithReason() kills it so we never
// leave an orphaned Chrome holding the userDataDir lock across a pm2 restart.
let chromeProc = null;

let shuttingDown = false;
const exitWithReason = (code, reason) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[exit] code=${code} reason=${reason}`);
  try { chromeProc?.kill('SIGKILL'); } catch { }
  process.exit(code);
};

process.on('uncaughtException', err => {
  console.log('[uncaught]', err);
  exitWithReason(1, 'uncaughtException');
});
process.on('unhandledRejection', err => {
  console.log('[unhandled]', err);
  exitWithReason(1, 'unhandledRejection');
});

// Runs in the page (via page.evaluate) once the game is ready. Strips every
// client-side component a headless GM bot doesn't need. These are client-scope
// settings, persisted server-side per user in v13+ (NOT localStorage), so
// noCanvas only takes effect on the *next* load — hence the per-load
// reapplication. Each step is wrapped so one failure can't tank the whole trim.
const CLIENT_TRIM = async () => {
  const trySet = async (key, value) => {
    try {
      // Skip settings this Foundry version doesn't register — avoids noisy
      // "not a registered game setting" warnings when keys are renamed or
      // removed across versions (e.g. tokenVisionAnimation, maxFR in v14).
      if (!game.settings.settings.has(`core.${key}`)) return;
      if (game.settings.get('core', key) === value) return;
      await game.settings.set('core', key, value);
    } catch (e) {
      console.warn(`[puppet] failed to set core.${key}: ${e.message}`);
    }
  };

  await trySet('noCanvas', true);
  await trySet('photosensitiveMode', true);
  await trySet('globalAmbientVolume', 0);
  await trySet('globalInterfaceVolume', 0);
  await trySet('globalPlaylistVolume', 0);
  // Disable optional visual work even with noCanvas — these affect background
  // timing / perception math that runs regardless of whether anything renders.
  await trySet('tokenVisionAnimation', false);
  await trySet('lightAnimation', false);
  await trySet('chatBubbles', false);
  await trySet('maxFR', 5);

  if (globalThis.CONFIG) CONFIG.performanceMode = 0;

  // Suspend Foundry's AudioContexts (music / environment / interface in v13+).
  // Each runs a processing graph on a dedicated audio thread that can consume
  // CPU regardless of audible output.
  try { await game.audio?.context?.suspend?.(); } catch { }
  try {
    for (const k of ['music', 'environment', 'interface']) {
      await game.audio?.[k]?.suspend?.();
      await game.audio?.[k]?.context?.suspend?.();
    }
  } catch { }

  // A/V — client-scope only. voice.mode = 0 means "disabled".
  // videoSrc/audioSrc must be null or a device ID — never a sentinel string.
  try {
    const rtc = game.settings.get('core', 'rtcClientSettings') || {};
    const next = {
      ...rtc,
      voice: { ...(rtc.voice || {}), mode: 0 },
      videoSrc: null,
      audioSrc: null,
    };
    if (JSON.stringify(next) !== JSON.stringify(rtc)) {
      await game.settings.set('core', 'rtcClientSettings', next);
    }
  } catch (e) {
    console.warn(`[puppet] failed to set rtcClientSettings: ${e.message}`);
  }

  // Kill animation tickers — pure waste in a headless GM. RAF is already
  // no-op'd (see evaluateOnNewDocument), so PIXI tickers can't fire frames,
  // but stop the singletons defensively and patch the prototype so any module
  // that calls .start() later gets a no-op too.
  const killed = [];
  try { if (globalThis.PIXI?.Ticker?.shared?.started) { PIXI.Ticker.shared.stop(); killed.push('pixi.shared'); } } catch { }
  try { if (globalThis.PIXI?.Ticker?.system?.started) { PIXI.Ticker.system.stop(); killed.push('pixi.system'); } } catch { }
  try {
    if (globalThis.PIXI?.Ticker?.prototype) {
      PIXI.Ticker.prototype.start = function () { };
      PIXI.Ticker.prototype.update = function () { };
      PIXI.Ticker.prototype._tick = function () { };
      killed.push('pixi.prototype');
    }
  } catch { }
  try {
    const r = game.dice3d?.box?.renderer || game.dice3d?.renderer;
    if (r?.setAnimationLoop) { r.setAnimationLoop(null); killed.push('dice3d'); }
  } catch { }

  // Force-stop the PIXI application's render loop. This is the master switch
  // for all canvas rendering — PIXI tickers, TokenMagic filter passes,
  // Sequencer, FXMaster, weather — nothing renders once app.stop() is called,
  // regardless of whether noCanvas is working.
  try {
    if (globalThis.canvas?.app) {
      canvas.app.stop();
      killed.push('pixi.app');
    }
  } catch { }

  // Re-assert RAF kill, in case any script replaced it during init.
  try {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => { };
  } catch { }

  // Kill CSS animations/transitions — THE main CPU sink for this bot. They run
  // on the compositor thread (not requestAnimationFrame, not the JS main
  // thread), so they survive every kill above and are invisible to a JS CPU
  // profiler. With no GPU each frame is software-rasterized via SwiftShader,
  // and an infinite-keyframe element (e.g. Foundry's paused indicator, a
  // fa-spin spinner) can peg a full core. Cancel the running ones and inject a
  // rule so newly-rendered elements can't restart them.
  try {
    const anims = document.getAnimations?.() ?? [];
    for (const a of anims) { try { a.cancel(); } catch { } }
    if (!document.getElementById('puppet-no-anim')) {
      const style = document.createElement('style');
      style.id = 'puppet-no-anim';
      style.textContent = `*, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }`;
      document.head.appendChild(style);
    }
    if (anims.length) killed.push(`css-animations(${anims.length})`);
  } catch { }

  // Notify any module listening for visibilitychange so it can pause itself.
  try { document.dispatchEvent(new Event('visibilitychange')); } catch { }

  console.log(`[puppet] client trim applied; killed: ${killed.join(', ') || 'none'}`);
};

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--disable-accelerated-2d-canvas',
      '--mute-audio',
    ],
  });

  chromeProc = browser.process();

  // Stderr filter — Chrome emits a lot of harmless noise. Keep only lines that
  // look like real problems.
  const isStderrNoise = (s) =>
    /DEPRECATED_ENDPOINT|SetApplicationIsDaemon|trust_store_mac\.cc|gcm\/engine\/connection_factory_impl|swiftshader|GPU stall|gles2_cmd_decoder|GroupMarkerNotSet|livekit\.cloud|p2p\/socket_manager/i.test(s);

  if (chromeProc) {
    chromeProc.on('exit', (code, signal) => {
      console.log(`[chrome exit] code=${code} signal=${signal}`);
    });
    chromeProc.stderr?.on('data', (data) => {
      const s = data.toString().trim();
      if (s && !isStderrNoise(s)) console.log(`[chrome stderr] ${s}`);
    });
  }

  browser.on('disconnected', () => {
    const alive = chromeProc && chromeProc.exitCode === null && !chromeProc.killed;
    console.log(`[browser disconnected] chrome alive=${alive} pid=${chromeProc?.pid}`);
    // If Chrome is still running (e.g. macOS sleep severed the DevTools socket
    // but the process is fine), kill it so pm2's restart doesn't hit a
    // userDataDir lock on the orphan.
    if (alive) {
      try {
        chromeProc.kill('SIGKILL');
        console.log('[browser disconnected] killed orphan chrome');
      } catch (e) {
        console.log(`[browser disconnected] kill failed: ${e.message}`);
      }
    }
    // Give the chrome 'exit' event a moment to fire so we capture code/signal
    setTimeout(() => exitWithReason(1, 'browser disconnected'), ORPHAN_EXIT_GRACE);
  });

  const page = await browser.newPage();
  // Foundry requires >= 1366x768; anything smaller logs a resolution warning.
  await page.setViewport({ width: 1366, height: 768 });

  // Run before any document scripts on every navigation:
  //   1. Silence console.debug so Foundry's per-hook chatter never reaches CDP.
  //   2. Report the page as hidden so well-behaved modules skip animation work
  //      based on document.hidden / visibilityState.
  //   3. No-op requestAnimationFrame / cancelAnimationFrame. RAF is the upstream
  //      fanout for every visual loop (PIXI tickers, Three.js setAnimationLoop,
  //      module animations). Killing it here severs all of them at once.
  await page.evaluateOnNewDocument(() => {
    // eslint-disable-next-line no-console
    console.debug = () => { };
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    } catch { }
    try {
      window.requestAnimationFrame = () => 0;
      window.cancelAnimationFrame = () => { };
    } catch { }
  });

  let reconnecting = false;
  let lastReconnectEndedAt = 0;
  let gameMissingCount = 0;
  let initialJoinDone = false;

  const isDetachedError = (msg) =>
    /detached Frame|Target closed|Session closed|Execution context was destroyed|Navigating frame was detached|frame got detached/i.test(msg || '');

  const join = async () => {
    if (page.isClosed()) throw new Error('page is closed');

    const response = await page.goto(`${FOUNDRY_URL}/join`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });

    if (!response || !response.ok()) {
      throw new Error(`navigation failed: ${response ? response.status() : 'no response'}`);
    }

    console.log(`[load] ${page.url()} (${response.status()})`);

    // Race the login form against game-ready: if the session cookie is still valid
    // Foundry loads the game directly, otherwise we see the form and fill it.
    const outcome = await Promise.race([
      page.waitForSelector('select[name="userid"]', { timeout: FORM_RACE_TIMEOUT }).then(() => 'form').catch(() => null),
      page.waitForFunction(() => globalThis.game?.ready === true, { timeout: FORM_RACE_TIMEOUT }).then(() => 'game').catch(() => null),
    ]);

    if (outcome === 'form') {
      // Session cookie was rejected or expired — Foundry sent us back to /join.
      // This is the clearest signal that the server actively ended our session
      // rather than a network/socket drop.
      console.log('[load] login form shown — session was not preserved, re-authenticating');
      await page.waitForSelector('input[name="password"]', { timeout: FORM_FIELD_TIMEOUT });
      await page.waitForSelector('button[name="join"]', { timeout: FORM_FIELD_TIMEOUT });
      await page.select('select[name="userid"]', FOUNDRY_USER_ID);
      await page.type('input[name="password"]', FOUNDRY_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => { }),
        page.click('button[name="join"]'),
      ]);
    } else if (outcome === 'game') {
      console.log('[load] session cookie still valid — skipped login form');
    }

    // Confirm the game actually finished loading, not just the HTML.
    // Heavily-modded worlds on busy servers can easily take 2+ minutes.
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: GAME_READY_TIMEOUT });
    gameMissingCount = 0;
    console.log(`[join] ready at ${page.url()}`);

    await page.evaluate(CLIENT_TRIM).catch(e => console.log(`[puppet] trim block error: ${e.message}`));
  };

  const reconnect = async (reason) => {
    if (reconnecting) return;
    // Ignore stale events fired just after a successful reconnect
    if (Date.now() - lastReconnectEndedAt < RECONNECT_STALE_GUARD) return;
    reconnecting = true;
    console.log(`[reconnect] triggered: ${reason}`);
    for (let attempt = 1; ; attempt++) {
      if (page.isClosed()) {
        exitWithReason(1, 'page closed during reconnect');
        return;
      }
      try {
        await join();
        console.log(`[reconnect] success on attempt ${attempt}`);
        lastReconnectEndedAt = Date.now();
        reconnecting = false;
        return;
      } catch (e) {
        const delay = Math.min(RECONNECT_MAX_BACKOFF, 2000 * 2 ** (attempt - 1));
        console.log(`[reconnect] attempt ${attempt} failed: ${e.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  };

  // Forward browser console output, but drop the categories that Foundry
  // produces in firehose volume during init — debug/verbose can easily mean
  // thousands of CDP roundtrips per join, which actually slows the page enough
  // to push past our game.ready timeout.
  const isBrowserNoise = (type, text) => {
    if (type === 'debug' || type === 'verbose') return true;
    return /GL Driver Message|GPU stall|loadTemplates|FilePicker|namespaced under/i.test(text);
  };
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (isBrowserNoise(type, text)) return;
    console.log(`[browser ${type}] ${text}`);
  });

  page.on('pageerror', err => {
    console.log(`[browser error] ${err.message}`);
  });

  page.on('error', err => {
    console.log(`[page crash] ${err.message}`);
    exitWithReason(1, 'page crash');
  });

  // Catch unexpected navigations away from the game — this fires the moment
  // Foundry redirects us (e.g. to /join or /setup), before the WebSocket-closed
  // event arrives. The URL and timing here tells you what the server did.
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url.includes(FOUNDRY_URL)) return;
    const isJoinOrSetup = /\/(join|setup)(\/|$|\?)/i.test(url);
    if (isJoinOrSetup && initialJoinDone && !reconnecting) {
      console.log(`[nav] unexpected redirect to ${url} — Foundry ended the session`);
    }
  });

  page.on('requestfailed', req => {
    const f = req.failure();
    // net::ERR_ABORTED is normal for cancelled requests during navigation; skip
    if (f?.errorText && f.errorText !== 'net::ERR_ABORTED') {
      console.log(`[req failed] ${req.method()} ${req.url()} — ${f.errorText}`);
    }
  });

  // Memory snapshot — helps catch OOM-driven crashes
  setInterval(() => {
    const m = process.memoryUsage();
    const mb = (n) => Math.round(n / 1024 / 1024);
    console.log(`[mem] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB`);
  }, MEM_INTERVAL);

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  client.on('Network.webSocketClosed', () => {
    if (!initialJoinDone) return;
    console.log('[ws] closed');
    reconnect('websocket closed').catch(e => console.log('[reconnect] error:', e.message));
  });
  client.on('Network.webSocketFrameError', ({ errorMessage }) => {
    console.log(`[ws] frame error: ${errorMessage}`);
  });

  // Use the retry loop for the initial join too — no point exiting and letting
  // pm2 cold-restart Chrome when reconnect() already retries with backoff.
  await reconnect('initial connection');
  initialJoinDone = true;

  setTimeout(() => exitWithReason(0, 'scheduled daily restart'), DAILY_RESTART_MS);

  let lastJiggleErrorAt = 0;
  const jiggle = setInterval(async () => {
    if (reconnecting || page.isClosed()) return;
    try {
      await page.mouse.move(Math.random() * 200, Math.random() * 200);
    } catch (e) {
      const now = Date.now();
      if (now - lastJiggleErrorAt > 5 * 60 * 1000) {
        console.log(`[jiggle] error: ${e.message}`);
        lastJiggleErrorAt = now;
      }
    }
  }, JIGGLE_INTERVAL);

  const poll = setInterval(async () => {
    if (reconnecting) return;
    try {
      const status = await page.evaluate(() => ({
        userName: globalThis.game?.user?.name,
        socketConnected: globalThis.game?.socket?.connected,
        ready: globalThis.game?.ready,
        activeUsers: globalThis.game?.users?.filter(u => u.active).map(u => u.name),
      }));

      const gameMissing =
        status.userName === undefined &&
        status.ready === undefined &&
        status.socketConnected === undefined;

      if (gameMissing) {
        gameMissingCount++;
        if (gameMissingCount >= 2) {
          gameMissingCount = 0;
          reconnect('game object missing').catch(e => console.log('[reconnect] error:', e.message));
        }
        return;
      }
      gameMissingCount = 0;

      console.log(`[foundry] ready=${status.ready} socket=${status.socketConnected} as=${status.userName} active=[${(status.activeUsers || []).join(', ')}]`);

      if (status.ready && status.socketConnected === false) {
        reconnect('socket disconnected').catch(e => console.log('[reconnect] error:', e.message));
      }
    } catch (e) {
      if (isDetachedError(e.message)) {
        reconnect('detached frame').catch(err => console.log('[reconnect] error:', err.message));
      } else {
        console.log('[foundry] eval error:', e.message);
      }
    }
  }, POLL_INTERVAL);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}`);
    clearInterval(jiggle);
    clearInterval(poll);
    try { await browser.close(); } catch { }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
})();
