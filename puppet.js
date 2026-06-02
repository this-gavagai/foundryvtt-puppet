const path = require('path');
const puppeteer = require('puppeteer');

const FOUNDRY_URL = process.env.FOUNDRY_URL;
const FOUNDRY_USER_ID = process.env.FOUNDRY_USER_ID;
const FOUNDRY_PASSWORD = process.env.FOUNDRY_PASSWORD;
const USER_DATA_DIR = process.env.PUPPET_PROFILE_DIR || path.join(__dirname, 'profile');

// URL + credentials must come from the environment (see ecosystem.config.js /
// secrets.json) — no baked-in defaults, so a misconfigured deploy fails loudly
// instead of silently logging in wrong or navigating to "undefined/join".
if (!FOUNDRY_URL || !FOUNDRY_USER_ID || !FOUNDRY_PASSWORD) {
  console.error('[fatal] FOUNDRY_URL, FOUNDRY_USER_ID and FOUNDRY_PASSWORD environment variables are required');
  process.exit(1);
}

// --- Tunables (all milliseconds) -------------------------------------------
const NAV_TIMEOUT = 60000;          // page.goto / waitForNavigation
const FORM_RACE_TIMEOUT = 30000;    // login-form vs game-ready race
const FORM_FIELD_TIMEOUT = 5000;    // individual login-form fields
const GAME_READY_TIMEOUT = 600000;  // generous — a COLD profile draws the canvas
                                    // once (slow, software-rendered) before the
                                    // trim can disable it; give that one load
                                    // room to finish and persist noCanvas.
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
// settings, stored in this Chrome profile's localStorage — so once set they
// persist across restarts (as long as the profile dir does), but noCanvas only
// takes effect on the *next* load, which is why a brand-new (cold) profile
// still draws the canvas once before this trim disables it for subsequent
// loads. Each step is wrapped so one failure can't tank the whole trim.
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

  // Diagnostic: surface WHY Foundry's socket drops. socket.io reasons are
  // semantic — 'io server disconnect' = the server kicked us (e.g. it
  // restarted/crashed), 'ping timeout'/'transport close'/'transport error' =
  // network/transport. Guard so we only attach once per socket instance.
  try {
    const sock = game.socket;
    if (sock && !sock.__puppetInstrumented) {
      sock.__puppetInstrumented = true;
      sock.on('disconnect', (reason) => console.log(`[socket] disconnect: ${reason}`));
      sock.io?.on?.('reconnect_attempt', (n) => console.log(`[socket] reconnect_attempt ${n}`));
      sock.io?.on?.('reconnect_error', (e) => console.log(`[socket] reconnect_error: ${e?.message || e}`));
    }
  } catch { }

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
      // Set the REAL window/screen size. With defaultViewport:null, page.setViewport
      // doesn't change what Foundry reads (window.screen) — it stayed at headless
      // Chrome's 800x600 default, below Foundry's 1366x768 minimum, which is the
      // only error that correlates with the failed loads. 1366x768 = the minimum
      // (keeps software-raster cost as low as Foundry will allow).
      '--window-size=1366,768',
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
  // Match the window size set via --window-size. (setViewport alone doesn't move
  // window.screen, which is what Foundry's resolution check reads — the launch
  // arg above is what actually satisfies it; this keeps innerWidth consistent.)
  await page.setViewport({ width: 1366, height: 768 });

  // Run before any document scripts on every navigation:
  //   1. Silence console.debug so Foundry's per-hook chatter never reaches CDP.
  //   2. Report the page as hidden so well-behaved modules skip animation work
  //      based on document.hidden / visibilityState.
  //   3. No-op requestAnimationFrame / cancelAnimationFrame. RAF is the upstream
  //      fanout for every visual loop (PIXI tickers, Three.js setAnimationLoop,
  //      module animations). Killing it here severs all of them at once.
  //   4. Kill ALL CSS animations/transitions from the first paint — see below.
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

    // CSS animations/transitions run on the compositor thread — NOT via
    // requestAnimationFrame and NOT on the JS main thread. With no GPU they are
    // software-rasterized, and Foundry's load-time UI (the loading spinner, the
    // paused pulse, fa-spin) animates continuously during the whole load. On a
    // COLD profile that also draws the canvas, this compositor work pegs the
    // CPU hard enough to starve the main thread so game.ready never arrives —
    // the load can't finish, the post-ready trim never runs, and noCanvas never
    // gets persisted, so it can never warm itself up. The trim's kill is too
    // late; this kills them from the very first paint so a cold first load can
    // complete and persist noCanvas. Inject into <html> immediately (head may
    // not exist yet at document-start) and re-assert on DOMContentLoaded.
    const installNoAnim = () => {
      try {
        if (document.getElementById('puppet-no-anim')) return;
        const style = document.createElement('style');
        style.id = 'puppet-no-anim';
        style.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;}';
        (document.head || document.documentElement).appendChild(style);
      } catch { }
    };
    installNoAnim();
    try { document.addEventListener('DOMContentLoaded', installNoAnim); } catch { }

    // Diagnostic: log every WebSocket close with its code/reason. The close
    // code distinguishes WHY the connection dropped — 1000 normal, 1001 going
    // away, 1006 abnormal (no close frame: server crash / severed link), 1012
    // service restart. Foundry's socket.io runs over this WebSocket, so this
    // reveals what's behind the reconnect churn. Wrap the constructor while
    // preserving prototype + static constants so socket.io keeps working.
    try {
      const OrigWS = window.WebSocket;
      if (OrigWS && !OrigWS.__puppetWrapped) {
        const WrappedWS = function (url, protocols) {
          const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
          try {
            ws.addEventListener('close', (e) => {
              console.log(`[ws-close] code=${e.code} clean=${e.wasClean}${e.reason ? ` reason="${e.reason}"` : ''}`);
            });
          } catch { }
          return ws;
        };
        WrappedWS.prototype = OrigWS.prototype;
        WrappedWS.CONNECTING = OrigWS.CONNECTING;
        WrappedWS.OPEN = OrigWS.OPEN;
        WrappedWS.CLOSING = OrigWS.CLOSING;
        WrappedWS.CLOSED = OrigWS.CLOSED;
        WrappedWS.__puppetWrapped = true;
        window.WebSocket = WrappedWS;
      }
    } catch { }
  });

  let reconnecting = false;
  let lastReconnectEndedAt = 0;
  let lastReadyAt = 0;
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
    // On timeout, dump the actual game state so we know WHY ready never came
    // (game undefined? socket down? stuck mid-init?) instead of a bare
    // "Waiting failed". Also log progress periodically while we wait.
    let waited = 0;
    const PROGRESS_EVERY = 30000;
    const progress = setInterval(async () => {
      waited += PROGRESS_EVERY;
      const st = await page.evaluate(() => ({
        game: typeof globalThis.game,
        ready: globalThis.game?.ready,
        socket: globalThis.game?.socket?.connected,
        scene: globalThis.game?.scenes?.active?.name ?? null,
      })).catch(e => ({ evalError: e.message }));
      console.log(`[join-wait] +${waited / 1000}s ${JSON.stringify(st)}`);
    }, PROGRESS_EVERY);
    try {
      await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: GAME_READY_TIMEOUT });
    } catch (e) {
      const st = await page.evaluate(() => ({
        game: typeof globalThis.game,
        ready: globalThis.game?.ready,
        socket: globalThis.game?.socket?.connected,
        scene: globalThis.game?.scenes?.active?.name ?? null,
        url: location.href,
      })).catch(ev => ({ evalError: ev.message }));
      throw new Error(`game-ready wait failed: ${e.message} | state=${JSON.stringify(st)}`);
    } finally {
      clearInterval(progress);
    }
    gameMissingCount = 0;
    lastReadyAt = Date.now();
    console.log(`[join] ready at ${page.url()}`);

    await page.evaluate(CLIENT_TRIM).catch(e => console.log(`[puppet] trim block error: ${e.message}`));
  };

  const reconnect = async (reason) => {
    if (reconnecting) return;
    // Ignore stale events fired just after a successful reconnect
    if (Date.now() - lastReconnectEndedAt < RECONNECT_STALE_GUARD) return;
    reconnecting = true;
    const lasted = lastReadyAt ? ` (session lasted ${Math.round((Date.now() - lastReadyAt) / 1000)}s)` : '';
    console.log(`[reconnect] triggered: ${reason}${lasted}`);
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
