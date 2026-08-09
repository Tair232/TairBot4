import { DiscordSDK, Common } from "@discord/embedded-app-sdk";
import { io } from "socket.io-client";
import "./style.css";

const CLIENT_BUILD = "9.24";

const CLIENT_ID = "1535948196663009321";
const ALLOWED_GUILD_ID = "1492151172570808390";

const app = document.querySelector("#app");
const discordSdk = new DiscordSDK(CLIENT_ID);

const isLikelyTouchDevice =
  matchMedia("(pointer: coarse)").matches ||
  navigator.maxTouchPoints > 0;

let lastOrientationMode = null;

async function setActivityOrientation(mode) {
  if (lastOrientationMode === mode) return;
  lastOrientationMode = mode;

  try {
    const orientation =
      mode === "movie"
        ? Common.OrientationLockStateTypeObject.LANDSCAPE
        : Common.OrientationLockStateTypeObject.PORTRAIT;

    await discordSdk.commands.setOrientationLockState({
      lock_state: orientation,
      picture_in_picture_lock_state:
        Common.OrientationLockStateTypeObject.LANDSCAPE,
      grid_lock_state:
        Common.OrientationLockStateTypeObject.LANDSCAPE,
    });

    console.log(`[MOBILE] orientation -> ${mode}`);
  } catch (error) {
    // Expected on desktop/web because this SDK command is mobile-only.
    console.log("[MOBILE] orientation lock unavailable on this client");
  }
}

let socket = null;
let currentState = null;
let currentDiscordUserId = null;

let serverClockOffsetMs = 0;
let serverClockReady = false;
let clockSyncInterval = null;
let firstSessionState = true;
let lateJoinCandidateKey = null;

function serverNowMs() {
  return Date.now() + serverClockOffsetMs;
}

function absorbStateClock(state) {
  if (
    serverClockReady ||
    !Number.isFinite(Number(state?.serverNow))
  ) {
    return;
  }

  // Initial coarse estimate until the RTT-based sync completes.
  serverClockOffsetMs = Number(state.serverNow) - Date.now();
}

async function syncServerClock() {
  if (!socket?.connected) return;

  const samples = [];

  for (let i = 0; i < 5; i++) {
    const sample = await new Promise((resolve) => {
      const t0 = Date.now();

      socket.timeout(2000).emit(
        "time:sync",
        { clientSentAt: t0 },
        (error, reply) => {
          const t1 = Date.now();

          if (error || !Number.isFinite(Number(reply?.serverNow))) {
            resolve(null);
            return;
          }

          const rtt = t1 - t0;
          const midpoint = (t0 + t1) / 2;
          const offset = Number(reply.serverNow) - midpoint;

          resolve({ rtt, offset });
        }
      );
    });

    if (sample) samples.push(sample);
    await new Promise((resolve) => setTimeout(resolve, 70));
  }

  if (!samples.length) return;

  // Lowest RTT sample is least distorted by network delay.
  samples.sort((a, b) => a.rtt - b.rtt);
  const best = samples[0];

  serverClockOffsetMs = best.offset;
  serverClockReady = true;

  console.log(
    `[CLOCK] server offset=${serverClockOffsetMs.toFixed(1)}ms rtt=${best.rtt}ms`
  );
}

// One player object for one movie. We do not constantly recreate <video>.
const player = {
  key: null,
  video: null,
  iframe: null,
  kodikBridgeTimer: null,
  kodikBridgeStartedAt: 0,
  kodikMessageHandler: null,
  kodikTime: 0,
  kodikLastTimeAt: 0,
  kodikMessageSeen: false,
  kodikSuspended: false,
  kodikLastReloadAt: 0,
  kodikLastReloadTarget: null,
  kodikLastPhase: null,
  tap: null,
  loader: null,
  loaderText: null,
  errorBox: null,
  errorText: null,

  loadGeneration: 0,
  loading: false,
  loaded: false,
  qualities: [],
  qualityIndex: -1,
  preferMediaRelay: true,
  appliedSeekRevision: 0,
  startupDelayApplied: false,

  retryTimer: null,
  syncTimer: null,
  playWatchdog: null,
  playAttemptPending: false,

  firstFrameSeen: false,
  buffering: false,
  lastProgressLogAt: 0,

  preloadOverlay: null,
  preloadTitle: null,
  preloadLabel: null,
  preloadTimerText: null,
  lateJoinSkipButton: null,

  lateJoinActive: false,
  lateJoinStarted: false,
  lateJoinTargetPosition: null,
  lateJoinTargetServerTime: null,

  volumeHud: null,
  volumeButton: null,
  volumeSlider: null,
  volumeHideTimer: null,
  controlsVisible: false,

  timeHud: null,
  timeRemainingText: null,
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function movieKey(movie) {
  if (!movie) return "";

  if (movie.source === "KODIK") {
    return `kodik:${movie.url || movie.kodikPath || ""}`;
  }

  return `vk:${movie.oid}_${movie.id}_${movie.hash || ""}`;
}

function globalPreloadExpired(state) {
  return Boolean(
    state?.phase === "PAUSED" &&
    state?.autoStartAt &&
    serverNowMs() >= Number(state.autoStartAt)
  );
}

function wantsPlayback(state) {
  return Boolean(
    state?.phase === "WATCHING" ||
    globalPreloadExpired(state)
  );
}

function serverPosition(state) {
  if (!state?.movie) return 0;

  const base = Math.max(0, Number(state.positionSeconds) || 0);

  if (state.phase === "WATCHING" && state.startedAt) {
    return (
      base +
      Math.max(0, serverNowMs() - Number(state.startedAt)) / 1000
    );
  }

  // All clients can begin at the exact scheduled backend timestamp even if
  // the WATCHING broadcast arrives a few milliseconds later.
  if (
    state.phase === "PAUSED" &&
    state.autoStartAt &&
    serverNowMs() >= Number(state.autoStartAt)
  ) {
    return Math.max(
      0,
      (serverNowMs() - Number(state.autoStartAt)) / 1000
    );
  }

  return base;
}

function renderBoot(text) {
  app.innerHTML = `
    <main class="screen simple-screen">
      <div class="boot-text">${esc(text)}</div>
    </main>
  `;
}

function renderFatal(title, detail = "") {
  destroyPlayer();

  app.innerHTML = `
    <main class="screen simple-screen">
      <div class="fatal">
        <strong>${esc(title)}</strong>
        ${detail ? `<span>${esc(detail)}</span>` : ""}
      </div>
    </main>
  `;
}

function renderIdle() {
  destroyPlayer();
  app.innerHTML = `<main class="screen movie-black"></main>`;
}

function destroyPlayer() {
  player.loadGeneration += 1;

  clearTimeout(player.retryTimer);
  clearTimeout(player.playWatchdog);
  clearTimeout(player.volumeHideTimer);
  clearInterval(player.syncTimer);
  clearInterval(player.kodikBridgeTimer);

  if (player.kodikMessageHandler) {
    window.removeEventListener(
      "message",
      player.kodikMessageHandler
    );
  }

  player.retryTimer = null;
  player.playWatchdog = null;
  player.syncTimer = null;
  player.playAttemptPending = false;

  if (player.video) {
    try {
      player.video.pause();
      player.video.removeAttribute("src");
      player.video.load();
    } catch {}
  }

  if (player.iframe) {
    try {
      player.iframe.src = "about:blank";
    } catch {}
  }

  player.key = null;
  player.video = null;
  player.iframe = null;
  player.kodikBridgeTimer = null;
  player.kodikBridgeStartedAt = 0;
  player.kodikMessageHandler = null;
  player.kodikTime = 0;
  player.kodikLastTimeAt = 0;
  player.kodikMessageSeen = false;
  player.kodikSuspended = false;
  player.kodikLastReloadAt = 0;
  player.kodikLastReloadTarget = null;
  player.kodikLastPhase = null;
  player.tap = null;
  player.loader = null;
  player.loaderText = null;
  player.errorBox = null;
  player.errorText = null;

  player.loading = false;
  player.loaded = false;
  player.qualities = [];
  player.qualityIndex = -1;
  player.preferMediaRelay = true;
  player.appliedSeekRevision = 0;
  player.startupDelayApplied = false;
  player.firstFrameSeen = false;
  player.buffering = false;
  player.lastProgressLogAt = 0;
  player.preloadOverlay = null;
  player.preloadTitle = null;
  player.preloadLabel = null;
  player.preloadTimerText = null;
  player.lateJoinSkipButton = null;

  player.lateJoinActive = false;
  player.lateJoinStarted = false;
  player.lateJoinTargetPosition = null;
  player.lateJoinTargetServerTime = null;

  player.volumeHud = null;
  player.volumeButton = null;
  player.volumeSlider = null;
  player.volumeValue = null;
  player.volumeHideTimer = null;
  player.controlsVisible = false;

  player.timeHud = null;
  player.timeRemainingText = null;
}

function setLoader(text) {
  if (player.loaderText) player.loaderText.textContent = text;
  if (player.loader) player.loader.hidden = false;
  if (player.errorBox) player.errorBox.hidden = true;
}

function hideLoader() {
  if (player.loader) player.loader.hidden = true;
}

function showError(text) {
  hideLoader();

  if (player.errorText) player.errorText.textContent = text;
  if (player.errorBox) player.errorBox.hidden = false;
}

function hideError() {
  if (player.errorBox) player.errorBox.hidden = true;
}

function showTap() {
  hideLoader();
  hideError();

  if (!player.tap) return;

  player.tap.disabled = false;
  player.tap.textContent = "▶ Нажмите, чтобы начать просмотр";
  player.tap.hidden = false;
}

function hideTap() {
  if (!player.tap) return;

  player.tap.hidden = true;
  player.tap.disabled = false;
  player.tap.textContent = "▶ Нажмите, чтобы начать просмотр";
}

function renderMovie(state) {
  if (state.movie?.source === "KODIK") {
    renderKodikMovie(state);
    return;
  }

  const key = movieKey(state.movie);

  if (player.video && player.key === key) {
    updatePreloadOverlay(state);

    const revision = Number(state.seekRevision) || 0;
    const forceExplicitSeek =
      player.loaded &&
      revision !== player.appliedSeekRevision;

    applyHostState(forceExplicitSeek);

    if (forceExplicitSeek) {
      player.appliedSeekRevision = revision;

      console.log(
        `[SYNC] explicit seek applied revision=${revision}`
      );
    }

    return;
  }

  destroyPlayer();

  app.innerHTML = `
    <main class="screen movie-screen">
      <video
        id="movieVideo"
        playsinline
        preload="auto"
        disablepictureinpicture
      ></video>

      <div id="movieLoader" class="movie-loader">
        <div class="loader-inner">
          <div class="spinner"></div>
          <span id="movieLoaderText">Загрузка фильма…</span>
        </div>
      </div>

      <div id="preloadOverlay" class="preload-overlay" hidden>
        <div class="preload-card">
          <strong id="preloadTitle">Предзагрузка фильма</strong>
          <span>
            <span id="preloadLabel">Общий старт через</span>
            <b id="preloadTimerText">1:00</b>
          </span>

          <button
            id="lateJoinSkipButton"
            class="late-join-skip"
            type="button"
            hidden
          >
            Смотреть сейчас
          </button>
        </div>
      </div>

      <div id="volumeHud" class="volume-hud">
        <button
          id="volumeButton"
          class="volume-button"
          type="button"
          aria-label="Звук"
        >
          🔊
        </button>

        <input
          id="volumeSlider"
          class="volume-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value="100"
          aria-label="Громкость"
        />

        <span id="volumeValue" class="volume-value">100%</span>
      </div>

      <div
        id="timeHud"
        class="time-hud"
        aria-live="off"
        aria-label="Оставшееся время фильма"
      >
        <span class="time-hud-label">Осталось</span>
        <strong id="timeRemainingText">--:--</strong>
      </div>

      <button id="tapToPlay" class="tap-to-play" hidden>
        ▶ Нажмите, чтобы начать просмотр
      </button>

      <div id="movieError" class="movie-error" hidden>
        <strong>Не удалось загрузить видео</strong>
        <span id="movieErrorText">Повторяю попытку…</span>
      </div>
    </main>
  `;

  player.key = key;
  player.video = document.querySelector("#movieVideo");
  player.tap = document.querySelector("#tapToPlay");
  player.loader = document.querySelector("#movieLoader");
  player.loaderText = document.querySelector("#movieLoaderText");
  player.errorBox = document.querySelector("#movieError");
  player.errorText = document.querySelector("#movieErrorText");
  player.preloadOverlay = document.querySelector("#preloadOverlay");
  player.preloadTitle = document.querySelector("#preloadTitle");
  player.preloadLabel = document.querySelector("#preloadLabel");
  player.preloadTimerText = document.querySelector("#preloadTimerText");
  player.lateJoinSkipButton = document.querySelector("#lateJoinSkipButton");

  player.volumeHud = document.querySelector("#volumeHud");
  player.volumeButton = document.querySelector("#volumeButton");
  player.volumeSlider = document.querySelector("#volumeSlider");
  player.volumeValue = document.querySelector("#volumeValue");

  player.timeHud = document.querySelector("#timeHud");
  player.timeRemainingText = document.querySelector("#timeRemainingText");

  setupVolumeControls();
  configureLateJoinIfNeeded(state, key);

  if (player.lateJoinSkipButton) {
    player.lateJoinSkipButton.onclick = skipLateJoinWait;
  }

  updatePreloadOverlay(state);

  player.tap.onclick = handleUserPlayGesture;

  player.video.addEventListener("loadedmetadata", () => {
    if (!isCurrentMovie(key)) return;

    const duration = Number(player.video.duration);

    console.log(
      `[PLAYER] metadata ${player.video.videoWidth}x${player.video.videoHeight}, duration=${duration}`
    );

    if (Number.isFinite(duration) && duration > 0) {
      socket?.emit("movie:metadata", {
        movieKey: key,
        duration,
      });
    }

    seekToHost(true);

    // Metadata is enough to know the source is valid.
    // Do not leave "Загрузка..." waiting for play().
    hideLoader();

    if (currentState?.phase === "PAUSED") {
      player.video.pause();
      return;
    }

    requestPlayback();
  });

  player.video.addEventListener("loadeddata", () => {
    if (!isCurrentMovie(key)) return;
    hideLoader();
    applyHostState(false);
  });

  player.video.addEventListener("canplay", () => {
    if (!isCurrentMovie(key)) return;
    hideLoader();
    applyHostState(false);
  });

  player.video.addEventListener("playing", () => {
    if (!isCurrentMovie(key)) return;

    player.firstFrameSeen = true;
    player.buffering = false;
    player.playAttemptPending = false;
    clearTimeout(player.playWatchdog);
    player.playWatchdog = null;

    hideLoader();
    hideError();
    hideTap();
    updatePreloadOverlay(currentState);

    console.log(
      `[PLAYER] playing quality=${qualityNumber(player.qualities[player.qualityIndex]?.key)}p`
    );

    emitPlaybackProgress();

    // Do NOT seek on the first playing frame.
    // Let sequential playback establish itself first.
  });

  player.video.addEventListener("waiting", () => {
    if (!isCurrentMovie(key)) return;
    player.buffering = true;
    console.log(
      `[PLAYER] waiting at ${player.video.currentTime.toFixed(2)}s, bufferedAhead=${bufferedAhead(player.video).toFixed(2)}s`
    );
    emitPlaybackProgress();
  });

  player.video.addEventListener("stalled", () => {
    if (!isCurrentMovie(key)) return;
    player.buffering = true;
    console.log(
      `[PLAYER] stalled at ${player.video.currentTime.toFixed(2)}s, bufferedAhead=${bufferedAhead(player.video).toFixed(2)}s`
    );
    emitPlaybackProgress();
  });

  player.video.addEventListener("canplay", () => {
    if (!isCurrentMovie(key)) return;
    player.buffering = false;
  });

  player.video.addEventListener("progress", () => {
    if (!isCurrentMovie(key)) return;

    const now = Date.now();
    if (now - player.lastProgressLogAt < 5000) return;
    player.lastProgressLogAt = now;

    console.log(
      `[PLAYER] buffer ${bufferedAhead(player.video).toFixed(1)}s ahead @ ${player.video.currentTime.toFixed(1)}s`
    );
  });

  player.video.addEventListener("pause", () => {
    if (!isCurrentMovie(key)) return;

    if (wantsPlayback(currentState) && !player.video.ended) {
      // If the browser paused us unexpectedly, host sync will try again.
      setTimeout(() => {
        if (isCurrentMovie(key)) applyHostState(false);
      }, 300);
    }
  });

  player.video.addEventListener("ended", () => {
    if (!isCurrentMovie(key)) return;
    emitPlaybackProgress(true);
    socket?.emit("movie:ended", { movieKey: key });
  });

  player.video.addEventListener("error", () => {
    if (!isCurrentMovie(key)) return;

    const error = player.video.error;

    console.error(
      "[PLAYER] media error:",
      error,
      `networkState=${player.video.networkState}`,
      `readyState=${player.video.readyState}`
    );

    if (error?.code === 4) {
      player.preferMediaRelay = true;
    }

    // Refresh metadata, then direct/relay source selection will run again.
    retryFreshMovieSource(
      `Ошибка потока ${error?.code || "?"}`
    );
  });

  loadFreshMovieSource(state.movie, key);

  player.syncTimer = setInterval(() => {
    updatePreloadOverlay(currentState);
    updateTimeRemaining();
    applyHostState(false);
    emitPlaybackProgress();
  }, 1000);
}


function kodikProxyPath(movie) {
  const raw = String(movie?.kodikPath || "");

  if (!raw.startsWith("/")) {
    throw new Error("Kodik path отсутствует.");
  }

  const host = String(movie?.kodikHost || "kodik.info").toLowerCase();

  if (host === "kodikplayer.com") {
    // Discord Activity URL Mapping:
    // /kodikplayer -> kodikplayer.com
    return `/kodikplayer${raw}`;
  }

  // Discord Activity URL Mapping:
  // /kodik -> kodik.info
  return `/kodik${raw}`;
}


function parseKodikMessage(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }

  if (typeof raw !== "string") {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function kodikStartPosition(state) {
  if (!state?.movie) return 0;

  if (
    state.phase === "PAUSED" &&
    state.autoStartAt &&
    !globalPreloadExpired(state)
  ) {
    return 0;
  }

  return Math.max(0, Math.floor(serverPosition(state)));
}

function buildKodikIframeSrc(movie, startAt = 0) {
  const mapped = kodikProxyPath(movie);
  const url = new URL(mapped, window.location.origin);

  // Current public Kodik integrations use these parameters to select the
  // episode and restore a position without needing same-origin DOM access.
  if (!url.searchParams.has("episode")) {
    url.searchParams.set(
      "episode",
      String(Number(movie?.episode) || 1)
    );
  }

  url.searchParams.set(
    "start_from",
    String(Math.max(0, Math.floor(Number(startAt) || 0)))
  );

  if (!url.searchParams.has("hide_selectors")) {
    url.searchParams.set("hide_selectors", "true");
  }

  return `${url.pathname}${url.search}${url.hash || ""}`;
}

function setKodikIframePosition(
  target,
  reason = "resync",
  { force = false } = {}
) {
  if (!player.iframe || !currentState?.movie) return;
  if (currentState.movie.source !== "KODIK") return;

  target = Math.max(0, Math.floor(Number(target) || 0));

  const now = Date.now();

  if (
    !force &&
    now - player.kodikLastReloadAt < 10_000
  ) {
    return;
  }

  if (
    !force &&
    Number.isFinite(player.kodikLastReloadTarget) &&
    Math.abs(player.kodikLastReloadTarget - target) < 3
  ) {
    return;
  }

  const src = buildKodikIframeSrc(
    currentState.movie,
    target
  );

  player.kodikLastReloadAt = now;
  player.kodikLastReloadTarget = target;
  player.kodikSuspended = false;
  player.loaded = false;

  setLoader(
    reason === "explicit-seek"
      ? `Перемотка Kodik → ${fmt(target)}…`
      : "Синхронизация Kodik…"
  );

  diagnostic("kodik-iframe-reload", {
    mode:
      `${reason} target=${target}s ` +
      `build=${CLIENT_BUILD}`,
  });

  player.iframe.src = src;
}

function suspendKodikAtCurrentPosition() {
  if (!player.iframe || player.kodikSuspended) return;

  const target = Math.max(
    0,
    Number.isFinite(player.kodikTime)
      ? player.kodikTime
      : serverPosition(currentState)
  );

  player.kodikSuspended = true;
  player.kodikLastReloadTarget = target;

  diagnostic("kodik-suspend", {
    mode: `target=${target.toFixed(1)} build=${CLIENT_BUILD}`,
  });

  // Cross-origin iframe cannot be reliably paused from the parent.
  // Unloading it is the deterministic pause. Resume recreates it using
  // start_from=<authoritative room position>.
  try {
    player.iframe.src = "about:blank";
  } catch {}

  hideLoader();
}

function emitKodikProgress(forceEnded = false) {
  if (!socket?.connected || !currentState?.movie) return;
  if (currentState.movie.source !== "KODIK") return;
  if (movieKey(currentState.movie) !== player.key) return;

  const currentTime = Math.max(
    0,
    Number(player.kodikTime) || 0
  );

  socket.emit("playback:progress", {
    movieKey: player.key,
    currentTime,
    duration: currentState.movie.duration || null,
    ended: Boolean(forceEnded),
    buffering: false,
    loaded: Boolean(player.loaded),
    participating: true,
    lateJoin: false,
  });
}

function attachKodikMessageBridge(key) {
  if (player.kodikMessageHandler) {
    window.removeEventListener(
      "message",
      player.kodikMessageHandler
    );
  }

  player.kodikMessageSeen = false;

  player.kodikMessageHandler = (event) => {
    if (!isCurrentMovie(key) || !player.iframe) return;

    if (
      event.source !== player.iframe.contentWindow
    ) {
      return;
    }

    const message = parseKodikMessage(event.data);

    if (!message) return;

    if (!player.kodikMessageSeen) {
      player.kodikMessageSeen = true;

      diagnostic("kodik-postmessage-found", {
        mode:
          `${String(message.key || message.event || "message")} ` +
          `build=${CLIENT_BUILD}`,
      });
    }

    if (message.key === "kodik_player_time_update") {
      const value = Number(message.value);

      if (!Number.isFinite(value) || value < 0) {
        return;
      }

      player.kodikTime = value;
      player.kodikLastTimeAt = Date.now();
      player.loaded = true;
      player.buffering = false;

      hideLoader();
      hideError();
      emitKodikProgress(false);

      return;
    }

    // Log the first few other Kodik events so we can discover an end/play/
    // pause signal without guessing undocumented command names.
    const marker = String(
      message.key ||
      message.event ||
      message.type ||
      ""
    ).toLowerCase();

    if (
      marker.includes("end") ||
      marker.includes("finish")
    ) {
      diagnostic("kodik-ended-message", {
        mode: marker.slice(0, 80),
      });

      emitKodikProgress(true);

      socket?.emit("movie:ended", {
        movieKey: key,
      });
    }
  };

  window.addEventListener(
    "message",
    player.kodikMessageHandler
  );
}

function syncKodikIframeToHost(state, { force = false } = {}) {
  if (!player.iframe || !state?.movie) return;
  if (state.movie.source !== "KODIK") return;

  const revision = Number(state.seekRevision) || 0;

  if (revision !== player.appliedSeekRevision) {
    player.appliedSeekRevision = revision;

    if (
      state.phase === "PAUSED" &&
      !state.autoStartAt
    ) {
      player.kodikTime = serverPosition(state);
      player.kodikLastReloadTarget = player.kodikTime;
      return;
    }

    setKodikIframePosition(
      serverPosition(state),
      "explicit-seek",
      { force: true }
    );
    return;
  }

  // A real /movie pause: unloading the iframe is the only reliable
  // cross-origin pause. The scheduled preload pause is NOT suspended.
  if (
    state.phase === "PAUSED" &&
    !state.autoStartAt
  ) {
    suspendKodikAtCurrentPosition();
    player.kodikLastPhase = "PAUSED";
    return;
  }

  if (
    state.phase === "WATCHING" &&
    player.kodikSuspended
  ) {
    setKodikIframePosition(
      serverPosition(state),
      "resume",
      { force: true }
    );

    player.kodikLastPhase = "WATCHING";
    return;
  }

  // When the common 60-second preload expires, force one iframe reload at the
  // authoritative start position. start_from lets every client join the same
  // room clock without touching the inner <video>.
  if (
    wantsPlayback(state) &&
    player.kodikLastPhase !== "WATCHING"
  ) {
    setKodikIframePosition(
      serverPosition(state),
      "common-start",
      { force: true }
    );

    player.kodikLastPhase = "WATCHING";
    return;
  }

  player.kodikLastPhase = state.phase;

  // If Kodik is publishing its own current time, use it as a drift detector.
  // Resync is intentionally coarse because it requires iframe reload.
  if (
    wantsPlayback(state) &&
    player.kodikLastTimeAt &&
    Date.now() - player.kodikLastTimeAt < 5000
  ) {
    const host = serverPosition(state);
    const drift = host - Number(player.kodikTime || 0);

    if (force || Math.abs(drift) > 8) {
      setKodikIframePosition(
        host,
        `drift=${drift.toFixed(1)}s`,
        { force }
      );
    }
  }
}

function beginKodikBridge(state, key) {
  if (!player.iframe) return;

  attachKodikMessageBridge(key);

  diagnostic("kodik-bridge", {
    mode: `postMessage build=${CLIENT_BUILD}`,
  });

  clearInterval(player.kodikBridgeTimer);

  player.kodikBridgeTimer = setInterval(() => {
    if (!isCurrentMovie(key)) {
      clearInterval(player.kodikBridgeTimer);
      player.kodikBridgeTimer = null;
      return;
    }

    updatePreloadOverlay(currentState);
    syncKodikIframeToHost(currentState);
    emitKodikProgress(false);
  }, 1000);
}

function renderKodikMovie(state) {
  const key = movieKey(state.movie);

  if (player.key === key && player.iframe) {
    updatePreloadOverlay(state);
    syncKodikIframeToHost(state);
    return;
  }

  destroyPlayer();

  app.innerHTML = `
    <main class="screen movie-screen kodik-screen">
      <iframe
        id="kodikFrame"
        class="kodik-frame"
        title="Kodik Anime Player"
        allow="autoplay; fullscreen; picture-in-picture"
        referrerpolicy="no-referrer-when-downgrade"
      ></iframe>

      <div id="movieLoader" class="movie-loader">
        <div class="loader-inner">
          <div class="spinner"></div>
          <span id="movieLoaderText">Загрузка Kodik…</span>
        </div>
      </div>

      <div id="preloadOverlay" class="preload-overlay" hidden>
        <div class="preload-card">
          <strong id="preloadTitle">Предзагрузка аниме</strong>
          <span>
            <span id="preloadLabel">Общий старт через</span>
            <b id="preloadTimerText">1:00</b>
          </span>

          <button
            id="lateJoinSkipButton"
            class="late-join-skip"
            type="button"
            hidden
          >
            Смотреть сейчас
          </button>
        </div>
      </div>

      <div id="volumeHud" class="volume-hud">
        <button
          id="volumeButton"
          class="volume-button"
          type="button"
          aria-label="Звук"
        >
          🔊
        </button>

        <input
          id="volumeSlider"
          class="volume-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value="100"
          aria-label="Громкость"
        />

        <span id="volumeValue" class="volume-value">100%</span>
      </div>

      <div
        id="timeHud"
        class="time-hud"
        aria-live="off"
        aria-label="Оставшееся время аниме"
      >
        <span class="time-hud-label">Осталось</span>
        <strong id="timeRemainingText">--:--</strong>
      </div>

      <button id="tapToPlay" class="tap-to-play" hidden>
        ▶ Нажмите, чтобы начать просмотр
      </button>

      <div id="movieError" class="movie-error" hidden>
        <strong>Не удалось подключить Kodik</strong>
        <span id="movieErrorText">Проверяю плеер…</span>
      </div>
    </main>
  `;

  player.key = key;
  player.iframe = document.querySelector("#kodikFrame");
  player.tap = document.querySelector("#tapToPlay");
  player.loader = document.querySelector("#movieLoader");
  player.loaderText = document.querySelector("#movieLoaderText");
  player.errorBox = document.querySelector("#movieError");
  player.errorText = document.querySelector("#movieErrorText");

  player.preloadOverlay = document.querySelector("#preloadOverlay");
  player.preloadTitle = document.querySelector("#preloadTitle");
  player.preloadLabel = document.querySelector("#preloadLabel");
  player.preloadTimerText = document.querySelector("#preloadTimerText");
  player.lateJoinSkipButton = document.querySelector("#lateJoinSkipButton");

  player.volumeHud = document.querySelector("#volumeHud");
  player.volumeButton = document.querySelector("#volumeButton");
  player.volumeSlider = document.querySelector("#volumeSlider");
  player.volumeValue = document.querySelector("#volumeValue");

  player.timeHud = document.querySelector("#timeHud");
  player.timeRemainingText = document.querySelector("#timeRemainingText");

  // Kodik is cross-origin. The VK-only late-join prebuffer mode relies on
  // direct <video> access, so for Kodik we join at the authoritative room
  // position using start_from instead.
  player.lateJoinActive = false;
  player.lateJoinStarted = true;

  if (player.lateJoinSkipButton) {
    player.lateJoinSkipButton.hidden = true;
  }

  // Parent custom volume/play controls cannot manipulate a cross-origin Kodik
  // video. Keep them hidden; Kodik's own player receives pointer input.
  if (player.volumeHud) {
    player.volumeHud.hidden = true;
  }

  if (player.timeHud) {
    player.timeHud.hidden = true;
  }

  if (player.tap) {
    player.tap.hidden = true;
  }

  player.appliedSeekRevision =
    Number(state.seekRevision) || 0;

  player.kodikLastPhase =
    wantsPlayback(state) ? "WATCHING" : state.phase;

  updatePreloadOverlay(state);

  const initialPosition = kodikStartPosition(state);
  const src = buildKodikIframeSrc(
    state.movie,
    initialPosition
  );

  diagnostic("kodik-iframe-load", {
    mode:
      `${src.slice(0, 100)} build=${CLIENT_BUILD}`,
  });

  player.iframe.addEventListener("load", () => {
    if (!isCurrentMovie(key)) return;

    // iframe "load" means the Kodik document itself is ready. Do NOT keep a
    // full-screen parent loader while waiting for an inaccessible inner video.
    player.loaded = true;
    hideLoader();
    hideError();

    diagnostic("kodik-iframe-loaded", {
      mode: `build=${CLIENT_BUILD}`,
    });
  });

  beginKodikBridge(state, key);
  player.iframe.src = src;
}

function isCurrentMovie(key) {
  return Boolean(
    player.key === key &&
    currentState?.movie &&
    movieKey(currentState.movie) === key
  );
}


function configureLateJoinIfNeeded(state, key) {
  if (lateJoinCandidateKey !== key) return;
  if (state?.phase !== "WATCHING" || !state?.startedAt) return;

  const current = serverPosition(state);

  // A join at the first few seconds is effectively an on-time viewer.
  if (current < 5) return;

  const preloadSeconds = Math.max(
    30,
    Number(state.lateJoinPreloadSeconds) || 180
  );

  let target = current + preloadSeconds;

  if (Number.isFinite(Number(state.movie?.duration))) {
    target = Math.min(
      target,
      Math.max(current + 1, Number(state.movie.duration) - 2)
    );
  }

  player.lateJoinActive = true;
  player.lateJoinStarted = false;
  player.lateJoinTargetPosition = target;

  // V9.15 uses fresh server-side VK metadata + Bothost relay for everyone.
  player.preferMediaRelay = true;

  // Convert target movie position to authoritative server wall-clock time.
  const base = Math.max(0, Number(state.positionSeconds) || 0);
  player.lateJoinTargetServerTime =
    Number(state.startedAt) + Math.max(0, target - base) * 1000;

  console.log(
    `[LATE JOIN] current=${current.toFixed(1)} target=${target.toFixed(1)} wait=${Math.max(
      0,
      (player.lateJoinTargetServerTime - serverNowMs()) / 1000
    ).toFixed(1)}s`
  );
}

function lateJoinSecondsLeft() {
  if (!player.lateJoinActive || !player.lateJoinTargetServerTime) return 0;

  return Math.max(
    0,
    Math.ceil(
      (player.lateJoinTargetServerTime - serverNowMs()) / 1000
    )
  );
}

function skipLateJoinWait() {
  if (
    !player.video ||
    !currentState?.movie ||
    !player.lateJoinActive ||
    player.lateJoinStarted
  ) {
    return;
  }

  const video = player.video;
  let target = serverPosition(currentState);

  if (Number.isFinite(video.duration) && video.duration > 0) {
    target = Math.min(
      target,
      Math.max(0, video.duration - 0.2)
    );
  }

  console.log(
    `[LATE JOIN] user skipped preload -> room position ${target.toFixed(2)}s`
  );

  // This affects only this Activity instance.
  // The authoritative backend timeline and all other viewers remain untouched.
  player.lateJoinStarted = true;
  player.lateJoinActive = false;
  player.lateJoinTargetPosition = null;
  player.lateJoinTargetServerTime = null;
  player.firstFrameSeen = false;
  player.buffering = false;

  if (player.lateJoinSkipButton) {
    player.lateJoinSkipButton.disabled = true;
  }

  updatePreloadOverlay(currentState);

  // Even if this point is not already buffered, the user's explicit action
  // means "join now", so intentionally perform the seek and let the browser
  // buffer the current room position.
  if (player.loaded && video.readyState >= 1) {
    try {
      video.currentTime = target;
    } catch {}

    hideLoader();
    emitPlaybackProgress();
    requestPlayback();
  }
}

function formatRemainingTime(seconds) {
  seconds = Math.max(0, Math.ceil(Number(seconds) || 0));

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateTimeRemaining() {
  if (!player.timeRemainingText || !player.video) return;

  const video = player.video;
  let duration = Number(video.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Number(currentState?.movie?.duration);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    player.timeRemainingText.textContent = "--:--";
    return;
  }

  const current = Math.max(0, Number(video.currentTime) || 0);
  player.timeRemainingText.textContent =
    formatRemainingTime(Math.max(0, duration - current));
}

function setupVolumeControls() {
  const video = player.video;
  const hud = player.volumeHud;
  const button = player.volumeButton;
  const slider = player.volumeSlider;
  const valueLabel = player.volumeValue;
  const screen = document.querySelector(".movie-screen");

  if (!video || !hud || !button || !slider || !screen) return;

  let savedVolume = 1;

  try {
    const raw = localStorage.getItem("movieNightVolume");
    const parsed = Number(raw);

    if (Number.isFinite(parsed)) {
      savedVolume = Math.min(1, Math.max(0, parsed));
    }
  } catch {}

  video.volume = savedVolume;
  video.muted = savedVolume <= 0;
  slider.value = String(Math.round(savedVolume * 100));

  const refresh = () => {
    const effective = video.muted ? 0 : video.volume;
    const percent = Math.round(effective * 100);

    if (video.muted || video.volume <= 0.001) {
      button.textContent = "🔇";
    } else if (video.volume < 0.5) {
      button.textContent = "🔉";
    } else {
      button.textContent = "🔊";
    }

    if (valueLabel) {
      valueLabel.textContent = `${percent}%`;
    }
  };

  const timeHud = player.timeHud;

  const hideHud = () => {
    hud.classList.remove("visible");
    timeHud?.classList.remove("visible");
    player.controlsVisible = false;
  };

  const showHud = (duration = 2200) => {
    updateTimeRemaining();

    hud.classList.add("visible");
    timeHud?.classList.add("visible");
    player.controlsVisible = true;

    clearTimeout(player.volumeHideTimer);

    player.volumeHideTimer = setTimeout(() => {
      hideHud();
    }, duration);
  };

  slider.addEventListener("input", () => {
    const next = Math.min(
      1,
      Math.max(0, Number(slider.value) / 100)
    );

    video.volume = next;
    video.muted = next <= 0;

    try {
      localStorage.setItem("movieNightVolume", String(next));
    } catch {}

    refresh();
    showHud(3000);
  });

  button.addEventListener("click", (event) => {
    event.stopPropagation();

    if (video.muted || video.volume <= 0.001) {
      const fallback =
        Number(slider.value) > 0
          ? Number(slider.value) / 100
          : 0.75;

      video.volume = fallback;
      video.muted = false;
      slider.value = String(Math.round(fallback * 100));
    } else {
      video.muted = true;
    }

    refresh();
    showHud(3000);
  });

  hud.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    showHud(3000);
  });

  // Desktop: behave like YouTube on mouse movement.
  screen.addEventListener(
    "mousemove",
    () => showHud(1800),
    { passive: true }
  );

  // Phone/tablet: one tap shows controls, another tap on empty movie
  // while visible can hide them immediately.
  screen.addEventListener(
    "pointerup",
    (event) => {
      if (!isLikelyTouchDevice) return;

      if (
        event.target === slider ||
        event.target === button ||
        event.target.closest?.(".preload-card") ||
        event.target.closest?.(".tap-to-play")
      ) {
        return;
      }

      if (player.controlsVisible) {
        hideHud();
      } else {
        showHud(3000);
      }
    },
    { passive: true }
  );

  video.addEventListener("timeupdate", updateTimeRemaining);
  video.addEventListener("durationchange", updateTimeRemaining);
  video.addEventListener("loadedmetadata", updateTimeRemaining);
  video.addEventListener("seeked", updateTimeRemaining);

  updateTimeRemaining();
  refresh();
}
function emitPlaybackProgress(forceEnded = false) {
  if (!socket?.connected || !currentState?.movie) return;
  if (movieKey(currentState.movie) !== player.key) return;

  if (currentState.movie.source === "KODIK") {
    emitKodikProgress(forceEnded);
    return;
  }

  if (!player.video) return;

  const participating =
    !player.lateJoinActive || player.lateJoinStarted;

  socket.emit("playback:progress", {
    movieKey: player.key,
    currentTime: Number(player.video.currentTime) || 0,
    duration: Number.isFinite(player.video.duration)
      ? player.video.duration
      : currentState.movie.duration || null,
    ended: forceEnded || player.video.ended,
    buffering: player.buffering,
    loaded: player.loaded,
    participating,
    lateJoin: player.lateJoinActive,
  });
}

/* ---------------- VK PLAYER CORE (kept intentionally close to V6/V7) ---------------- */

function vkEmbedPath(movie) {
  const params = new URLSearchParams({
    oid: movie.oid,
    id: movie.id,
    hd: "4",
    autoplay: "0",
    js_api: "1",
  });

  if (movie.hash) params.set("hash", movie.hash);

  return `/vk/video_ext.php?${params}`;
}

function decodeVkUrl(value) {
  return value
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&");
}

function extractMp4Files(html) {
  const files = {};

  for (const q of ["144", "240", "360", "480", "720", "1080", "1440", "2160"]) {
    const match = html.match(
      new RegExp(`"mp4_${q}"\\s*:\\s*"([^"]+)"`, "i")
    );

    if (match) {
      files[`mp4_${q}`] = decodeVkUrl(match[1]);
    }
  }

  return files;
}

function qualityNumber(key) {
  return Number(String(key || "").replace("mp4_", "")) || 0;
}

function qualityOrder(files) {
  // 720p is the reliability-first default for a group Activity.
  // It greatly reduces the simultaneous startup burst compared with 1080p.
  // 1080p remains the second choice.
  const order = [720, 1080, 480, 360, 240, 144, 1440, 2160];
  const result = [];

  for (const q of order) {
    const key = `mp4_${q}`;
    if (files[key]) result.push({ key, url: files[key] });
  }

  return result;
}

function mappedMediaUrl(original) {
  const url = new URL(original);
  const host = url.hostname.toLowerCase();

  if (host.endsWith(".okcdn.ru")) {
    const subdomain = host.slice(0, -".okcdn.ru".length);

    if (!subdomain) {
      throw new Error("Пустой OKCDN subdomain");
    }

    return `/vkmedia/${encodeURIComponent(subdomain)}${url.pathname}${url.search}${url.hash}`;
  }

  if (host.endsWith(".vkuser.net")) {
    const subdomain = host.slice(0, -".vkuser.net".length);

    if (!subdomain) {
      throw new Error("Пустой VKUSER subdomain");
    }

    return `/vkuser/${encodeURIComponent(subdomain)}${url.pathname}${url.search}${url.hash}`;
  }

  throw new Error(`Неподдерживаемый VK CDN: ${url.hostname}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableViewerHash(value) {
  let hash = 2166136261;

  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function initialMediaDelayMs(key) {
  // Spread viewers across ~0..9 seconds. The room already has a 60-second
  // preload window, so this reduces the thundering-herd without delaying
  // the synchronized movie start.
  const seed = `${currentDiscordUserId || "anon"}:${key}:${discordSdk.instanceId || ""}`;
  const slot = stableViewerHash(seed) % 12;

  return slot * 800;
}

function diagnostic(stage, extra = {}) {
  const payload = {
    stage: String(stage || "").slice(0, 80),
    movieKey: player.key || null,
    quality: Number(extra.quality) || null,
    mode: extra.mode ? String(extra.mode).slice(0, 32) : null,
    error: extra.error ? String(extra.error).slice(0, 180) : null,
    readyState: player.video?.readyState ?? null,
    networkState: player.video?.networkState ?? null,
  };

  console.log("[PLAYER DIAG]", payload);

  if (socket?.connected) {
    socket.emit("player:diagnostic", payload);
  }
}

function backendMediaUrl(original) {
  return `/api/media?url=${encodeURIComponent(original)}`;
}

async function fetchBackendVkQualities(movie) {
  const params = new URLSearchParams({
    oid: movie.oid,
    id: movie.id,
  });

  if (movie.hash) {
    params.set("hash", movie.hash);
  }

  // Unique request to our own backend; VK itself is fetched server-side
  // with no-store, so Discord's Activity proxy cannot hand us stale embed HTML.
  params.set("_request", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const response = await fetch(`/api/vk-meta?${params}`, {
    cache: "no-store",
    credentials: "omit",
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.error || `Backend VK metadata HTTP ${response.status}`
    );
  }

  const qualities = qualityOrder(data?.files || {});

  if (!qualities.length) {
    throw new Error("Backend VK не отдал MP4");
  }

  return qualities;
}

function waitForMetadata(video, timeoutMs, generation) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;

      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", onError);

      fn(value);
    };

    const onMetadata = () => finish(resolve);

    const onError = () => {
      finish(
        reject,
        new Error(`VIDEO ERROR ${video.error?.code || "?"}`)
      );
    };

    const timer = setTimeout(() => {
      if (generation !== player.loadGeneration) {
        finish(reject, new Error("stale load"));
        return;
      }

      if (video.readyState >= 1) {
        finish(resolve);
      } else {
        finish(reject, new Error("metadata timeout"));
      }
    }, timeoutMs);

    // Listener is armed BEFORE src assignment.
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });

    if (video.readyState >= 1) {
      finish(resolve);
    }
  });
}

async function loadFreshMovieSource(movie, key) {
  if (!isCurrentMovie(key) || player.loading) return;

  player.loading = true;
  player.loaded = false;
  player.firstFrameSeen = false;
  player.preferMediaRelay = true;

  const generation = ++player.loadGeneration;

  clearTimeout(player.retryTimer);
  player.retryTimer = null;

  setLoader("Подготовка видео…");

  try {
    // Spread first requests across the existing preload window so that a
    // group of viewers does not hit Bothost/VK in the same millisecond.
    if (!player.startupDelayApplied) {
      player.startupDelayApplied = true;

      const delayMs = player.lateJoinActive
        ? 0
        : initialMediaDelayMs(key);

      if (delayMs > 0) {
        diagnostic("startup-stagger", {
          mode: `${delayMs}ms`,
        });

        setLoader(
          `Подготовка источника… ${Math.ceil(delayMs / 1000)} сек`
        );

        await sleep(delayMs);

        if (
          generation !== player.loadGeneration ||
          !isCurrentMovie(key)
        ) {
          return;
        }
      }
    }

    diagnostic("vk-metadata-backend-start");

    // V9.15: ALL viewers obtain fresh VK metadata through Bothost.
    // Discord Activity no longer fetches video_ext.php directly.
    const qualities = await fetchBackendVkQualities(movie);

    diagnostic("vk-metadata-backend-ok", {
      mode: `${qualities.length} qualities`,
    });

    if (
      generation !== player.loadGeneration ||
      !isCurrentMovie(key)
    ) {
      return;
    }

    player.qualities = qualities;

    let lastError = null;

    for (let i = 0; i < qualities.length; i++) {
      const quality = qualities[i];
      const q = qualityNumber(quality.key);

      // Two relay attempts for the same quality before dropping down.
      // The second attempt asks /api/vk-meta again, which gives a fresh
      // signed CDN URL instead of reusing the first one.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (
            generation !== player.loadGeneration ||
            !isCurrentMovie(key)
          ) {
            return;
          }

          if (attempt > 1) {
            const retryDelay =
              900 +
              (stableViewerHash(
                `${currentDiscordUserId}:${key}:${q}:${generation}:relay`
              ) % 1800);

            diagnostic("relay-retry-wait", {
              quality: q,
              mode: `${retryDelay}ms`,
            });

            setLoader(
              `Повтор ${q}p через ${Math.ceil(retryDelay / 1000)} сек…`
            );

            await sleep(retryDelay);

            if (
              generation !== player.loadGeneration ||
              !isCurrentMovie(key)
            ) {
              return;
            }
          }

          // First attempt uses the fresh list we already fetched.
          // Retry refreshes video_ext again to obtain another signed URL.
          let freshQualities = qualities;

          if (attempt > 1) {
            diagnostic("vk-metadata-backend-refresh", {
              quality: q,
            });

            freshQualities = await fetchBackendVkQualities(movie);
          }

          const freshQuality =
            freshQualities.find((item) => item.key === quality.key) ||
            freshQualities[i] ||
            freshQualities[0];

          if (!freshQuality?.url) {
            throw new Error("Свежий backend MP4 не найден");
          }

          const video = player.video;

          try {
            video.pause();
            video.removeAttribute("src");
            video.load();
          } catch {}

          const source = backendMediaUrl(freshQuality.url);

          setLoader(
            attempt === 1
              ? `Загрузка ${q}p…`
              : `Повторная загрузка ${q}p…`
          );

          diagnostic("media-relay-start", {
            quality: q,
            mode: `relay-attempt-${attempt}`,
          });

          const metadataStartedAt = performance.now();

          const metadataPromise = waitForMetadata(
            video,
            35_000,
            generation
          );

          video.src = source;
          video.load();

          await metadataPromise;

          if (
            generation !== player.loadGeneration ||
            !isCurrentMovie(key)
          ) {
            return;
          }

          diagnostic("media-metadata-ok", {
            quality: q,
            mode:
              `relay-attempt-${attempt} ` +
              `${Math.round(performance.now() - metadataStartedAt)}ms`,
          });

          player.qualityIndex = i;
          player.loaded = true;
          player.loading = false;
          player.preferMediaRelay = true;
          player.appliedSeekRevision =
            Number(currentState?.seekRevision) || 0;

          hideLoader();

          seekToHost(true);
          applyHostState(true);
          return;
        } catch (error) {
          lastError = error;

          diagnostic("media-relay-failed", {
            quality: q,
            mode: `relay-attempt-${attempt}`,
            error: error?.message || error,
          });
        }
      }
    }

    throw lastError || new Error("Все качества VK недоступны");
  } catch (error) {
    if (
      generation !== player.loadGeneration ||
      !isCurrentMovie(key)
    ) {
      return;
    }

    player.loading = false;
    player.loaded = false;

    diagnostic("movie-load-failed", {
      error: error?.message || error,
    });

    showError(
      `${error?.message || error}. Новая попытка через несколько секунд…`
    );

    const retryDelay =
      5000 +
      (stableViewerHash(
        `${currentDiscordUserId}:${key}:${generation}:full-relay-retry`
      ) % 3000);

    player.retryTimer = setTimeout(() => {
      player.retryTimer = null;

      if (!isCurrentMovie(key)) return;

      hideError();
      loadFreshMovieSource(currentState.movie, key);
    }, retryDelay);
  }
}


function retryFreshMovieSource(reason) {
  if (!player.key || !currentState?.movie) return;

  const key = player.key;

  // Avoid a storm of retries from multiple media error events.
  if (player.loading || player.retryTimer) return;

  console.warn("[PLAYER] refreshing signed VK source:", reason);

  player.loaded = false;
  player.qualityIndex = -1;
  player.preferMediaRelay = true;

  // Drop the failed signed media URL completely before obtaining a new one.
  // This is especially important for viewers joining an already-running film.
  try {
    player.video?.pause();
    player.video?.removeAttribute("src");
    player.video?.load();
  } catch {}

  showError(`${reason}. Получаю новую ссылку VK…`);

  player.retryTimer = setTimeout(() => {
    player.retryTimer = null;

    if (!isCurrentMovie(key)) return;

    hideError();
    loadFreshMovieSource(currentState.movie, key);
  }, 1500);
}


function preloadSecondsLeft(state) {
  if (!state?.autoStartAt) return 0;

  return Math.max(
    0,
    Math.ceil((Number(state.autoStartAt) - serverNowMs()) / 1000)
  );
}

function updatePreloadOverlay(state) {
  if (!player.preloadOverlay) return;

  if (player.lateJoinActive && !player.lateJoinStarted) {
    player.preloadOverlay.hidden = false;

    if (player.preloadTitle) {
      player.preloadTitle.textContent = "Подготовка к подключению";
    }

    if (player.preloadLabel) {
      player.preloadLabel.textContent = "Подключение через";
    }

    if (player.preloadTimerText) {
      player.preloadTimerText.textContent = fmt(lateJoinSecondsLeft());
    }

    if (player.lateJoinSkipButton) {
      player.lateJoinSkipButton.hidden = false;
      player.lateJoinSkipButton.disabled = false;
    }

    return;
  }

  if (player.lateJoinSkipButton) {
    player.lateJoinSkipButton.hidden = true;
    player.lateJoinSkipButton.disabled = false;
  }

  const active =
    state?.phase === "PAUSED" &&
    Boolean(state?.autoStartAt) &&
    !globalPreloadExpired(state);

  if (!active) {
    player.preloadOverlay.hidden = true;
    return;
  }

  player.preloadOverlay.hidden = false;

  if (player.preloadTitle) {
    player.preloadTitle.textContent = "Предзагрузка фильма";
  }

  if (player.preloadLabel) {
    player.preloadLabel.textContent = "Общий старт через";
  }

  if (player.preloadTimerText) {
    player.preloadTimerText.textContent = fmt(preloadSecondsLeft(state));
  }
}

function bufferedAhead(video) {
  if (!video || !video.buffered?.length) return 0;

  const t = Number(video.currentTime) || 0;

  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);

    if (t >= start - 0.25 && t <= end + 0.25) {
      return Math.max(0, end - t);
    }
  }

  return 0;
}

function isTimeBuffered(video, time, margin = 0.35) {
  if (!video || !video.buffered?.length) return false;

  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);

    if (time >= start - margin && time <= end - margin) {
      return true;
    }
  }

  return false;
}

/* ---------------- HOST SYNCHRONIZATION ---------------- */

function seekToHost(force = false) {
  if (!player.video || !player.loaded || !currentState?.movie) return;
  if (player.video.readyState < 1) return;

  // Late joiners preload a FUTURE point while paused.
  if (player.lateJoinActive && !player.lateJoinStarted) {
    const target = Number(player.lateJoinTargetPosition);

    if (Number.isFinite(target)) {
      const local = Number(player.video.currentTime) || 0;

      if (force || Math.abs(local - target) > 0.35) {
        try {
          player.video.currentTime = target;
          console.log(`[LATE JOIN] preload seek -> ${target.toFixed(2)}s`);
        } catch {}
      }
    }

    return;
  }

  // During the common preload window every on-time viewer stays at 0.
  if (
    currentState.phase === "PAUSED" &&
    currentState.autoStartAt &&
    !globalPreloadExpired(currentState)
  ) {
    if (Math.abs(Number(player.video.currentTime) || 0) > 0.1) {
      try {
        player.video.currentTime = 0;
      } catch {}
    }
    return;
  }

  if (
    !force &&
    wantsPlayback(currentState) &&
    !player.firstFrameSeen
  ) {
    return;
  }

  if (!force && player.buffering) {
    return;
  }

  let target = serverPosition(currentState);

  if (Number.isFinite(player.video.duration) && player.video.duration > 0) {
    target = Math.min(
      target,
      Math.max(0, player.video.duration - 0.2)
    );
  }

  const local = Number(player.video.currentTime) || 0;
  const drift = target - local;

  const threshold =
    currentState.phase === "PAUSED" && !globalPreloadExpired(currentState)
      ? 0.6
      : 3.5;

  if (!(force || Math.abs(drift) > threshold)) return;

  if (!force && !isTimeBuffered(player.video, target)) {
    console.log(
      `[SYNC] skip seek: target ${target.toFixed(2)}s not buffered; local=${local.toFixed(2)}s drift=${drift.toFixed(2)}s`
    );
    return;
  }

  try {
    player.video.currentTime = target;

    console.log(
      `[SYNC] seek -> ${target.toFixed(2)}s, drift=${drift.toFixed(2)}s, force=${force}`
    );
  } catch {}
}
function requestPlayback() {
  const video = player.video;

  if (
    !video ||
    !player.loaded ||
    !wantsPlayback(currentState) ||
    video.ended ||
    !video.paused
  ) {
    if (video && !video.paused) hideTap();
    return;
  }

  if (player.playAttemptPending) return;

  player.playAttemptPending = true;

  clearTimeout(player.playWatchdog);

  // Some embedded Chromium versions can leave play() pending.
  // UI must never depend on that Promise settling.
  player.playWatchdog = setTimeout(() => {
    player.playWatchdog = null;
    player.playAttemptPending = false;

    if (
      player.video &&
      wantsPlayback(currentState) &&
      player.video.paused &&
      !player.video.ended
    ) {
      showTap();
    }
  }, 1800);

  let promise;

  try {
    promise = video.play();
  } catch (error) {
    clearTimeout(player.playWatchdog);
    player.playWatchdog = null;
    player.playAttemptPending = false;

    console.log("[PLAYER] autoplay threw:", error);
    showTap();
    return;
  }

  Promise.resolve(promise)
    .then(() => {
      clearTimeout(player.playWatchdog);
      player.playWatchdog = null;
      player.playAttemptPending = false;

      hideLoader();
      hideTap();
    })
    .catch((error) => {
      clearTimeout(player.playWatchdog);
      player.playWatchdog = null;
      player.playAttemptPending = false;

      console.log("[PLAYER] autoplay rejected:", error);
      showTap();
    });
}

function handleUserPlayGesture() {
  if (!player.video) return;

  if (
    player.lateJoinActive &&
    !player.lateJoinStarted
  ) {
    return;
  }

  if (!wantsPlayback(currentState)) {
    return;
  }

  player.tap.disabled = true;
  player.tap.textContent = "Запускаю…";

  // This is inside the user's click event. No await before calling play().
  let promise;

  try {
    promise = player.video.play();
  } catch (error) {
    console.error("[PLAYER] manual play threw:", error);
    showTap();
    return;
  }

  const fallback = setTimeout(() => {
    if (!player.video) return;

    if (player.video.paused) {
      showTap();
    } else {
      hideTap();
      hideLoader();
    }
  }, 2500);

  Promise.resolve(promise)
    .then(() => {
      clearTimeout(fallback);
      hideTap();
      hideLoader();
      seekToHost(true);
    })
    .catch((error) => {
      clearTimeout(fallback);
      console.error("[PLAYER] manual play rejected:", error);
      showTap();
    });
}

function applyHostState(forceSeek = false) {
  const state = currentState;
  const video = player.video;

  if (!state?.movie || !video || !player.loaded) return;
  if (movieKey(state.movie) !== player.key) return;

  updatePreloadOverlay(state);

  // Late join mode:
  // 1) seek to a future position;
  // 2) buffer there for ~3 minutes while the room approaches it;
  // 3) only join playback when the authoritative room reaches that position.
  if (player.lateJoinActive && !player.lateJoinStarted) {
    seekToHost(forceSeek);

    const target = Number(player.lateJoinTargetPosition);
    const currentRoomPosition = serverPosition(state);

    if (
      Number.isFinite(target) &&
      currentRoomPosition >= target
    ) {
      const catchupTarget = Math.min(
        currentRoomPosition,
        Number.isFinite(video.duration)
          ? Math.max(0, video.duration - 0.2)
          : currentRoomPosition
      );

      if (
        isTimeBuffered(video, catchupTarget, 0.05) ||
        Math.abs((Number(video.currentTime) || 0) - catchupTarget) < 0.8
      ) {
        try {
          video.currentTime = catchupTarget;
        } catch {}

        player.lateJoinStarted = true;
        player.lateJoinActive = false;
        player.firstFrameSeen = false;

        console.log(
          `[LATE JOIN] joining room @ ${catchupTarget.toFixed(2)}s`
        );

        updatePreloadOverlay(state);
        emitPlaybackProgress();
        requestPlayback();
        return;
      }

      // The planned point was not buffered enough yet.
      // Keep paused and let range requests continue instead of stuttering.
      if (!video.paused) video.pause();
      return;
    }

    if (!video.paused) video.pause();
    hideTap();
    return;
  }

  seekToHost(forceSeek);

  // Common one-minute preload. All clients use server-synchronized time.
  if (
    state.phase === "PAUSED" &&
    state.autoStartAt &&
    !globalPreloadExpired(state)
  ) {
    clearTimeout(player.playWatchdog);
    player.playWatchdog = null;
    player.playAttemptPending = false;

    if (!video.paused) video.pause();

    hideLoader();
    hideTap();

    try {
      if (Math.abs(video.currentTime) > 0.1) video.currentTime = 0;
    } catch {}

    return;
  }

  // Manual host pause (not the scheduled preload).
  if (
    state.phase === "PAUSED" &&
    !state.autoStartAt
  ) {
    clearTimeout(player.playWatchdog);
    player.playWatchdog = null;
    player.playAttemptPending = false;

    if (!video.paused) video.pause();

    hideLoader();
    hideTap();
    emitPlaybackProgress();
    return;
  }

  // WATCHING or the exact local moment at which scheduled preload expired.
  if (wantsPlayback(state)) {
    requestPlayback();
    emitPlaybackProgress();
  }
}
/* ---------------- VOTING ---------------- */

function remainingVotingSeconds(state) {
  return Math.max(
    0,
    Math.ceil((Number(state.voteEndsAt) - serverNowMs()) / 1000)
  );
}

function renderVoting(state) {
  destroyPlayer();

  const suggestions = Array.isArray(state.suggestions)
    ? state.suggestions
    : [];

  const canSuggest = !state.mySuggestionId;

  app.innerHTML = `
    <main class="screen voting-screen">
      <section class="vote-wrap">
        <header class="vote-header">
          <div>
            <div class="vote-kicker">MOVIE NIGHT</div>
            <h1>Что смотрим дальше?</h1>
          </div>

          <div class="vote-timer" id="voteTimer">
            ${fmt(remainingVotingSeconds(state))}
          </div>
        </header>

        ${
          state.notice
            ? `
              <div class="vote-notice">
                ${esc(state.notice)}
              </div>
            `
            : ""
        }

        <div class="vote-grid">
          <section class="vote-panel">
            <h2>Предложить</h2>

            ${
              canSuggest
                ? `
                  <form id="proposalForm">
                    <div class="proposal-section">
                      <div class="proposal-section-title">
                        🎬 Фильм
                      </div>

                      <label>
                        Название
                        <input
                          id="proposalTitle"
                          maxlength="100"
                          placeholder="Название фильма"
                        />
                      </label>

                      <label>
                        Ссылка VK Видео
                        <input
                          id="proposalUrl"
                          placeholder="https://vkvideo.ru/video-..."
                        />
                      </label>

                      <button
                        class="primary-action"
                        type="submit"
                      >
                        Предложить фильм
                      </button>
                    </div>

                    <div class="proposal-divider">
                      <span>ИЛИ</span>
                    </div>

                    <div class="proposal-section anime-proposal-section">
                      <div class="proposal-section-title">
                        🍥 Аниме
                      </div>

                      <label>
                        Название аниме
                        <input
                          id="animeSearchInput"
                          maxlength="120"
                          placeholder="Например: Киберпанк или Naruto"
                        />
                      </label>

                      <button
                        id="animeSearchButton"
                        class="secondary-action"
                        type="button"
                      >
                        Найти аниме
                      </button>

                      <div
                        id="animeSearchStatus"
                        class="anime-search-status"
                      ></div>

                      <div
                        id="animeSearchResults"
                        class="anime-search-results"
                      ></div>
                    </div>

                    <div
                      id="proposalError"
                      class="form-error"
                    ></div>
                  </form>
                `
                : `
                  <div class="already-proposed">
                    ✓ Ты уже предложил вариант
                  </div>
                `
            }
          </section>

          <section class="vote-panel">
            <h2>Голосование</h2>

            <div class="suggestions">
              ${
                suggestions.length
                  ? suggestions
                      .map((item) => {
                        const isAnime =
                          item.kind === "ANIME";

                        const meta = isAnime
                          ? [
                              "🍥 Аниме",
                              item.year || null,
                              item.episodesCount
                                ? `${item.episodesCount} эп.`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "🎬 Фильм";

                        return `
                          <button
                            class="suggestion ${
                              state.myVote === item.id
                                ? "selected"
                                : ""
                            }"
                            data-vote-id="${esc(item.id)}"
                          >
                            <div class="suggestion-main">
                              <div class="suggestion-type">
                                ${esc(meta)}
                              </div>

                              <strong>${esc(item.title)}</strong>

                              <span>
                                Предложил: ${esc(
                                  item.proposerName || "Участник"
                                )}
                              </span>
                            </div>

                            <div class="vote-count">
                              ${Number(item.votes) || 0}
                            </div>
                          </button>
                        `;
                      })
                      .join("")
                  : `
                    <div class="no-suggestions">
                      Пока никто ничего не предложил.
                    </div>
                  `
              }
            </div>

            <div id="voteError" class="form-error"></div>
          </section>
        </div>
      </section>
    </main>
  `;

  const timer = document.querySelector("#voteTimer");

  const timerInterval = setInterval(() => {
    if (!document.body.contains(timer)) {
      clearInterval(timerInterval);
      return;
    }

    timer.textContent = fmt(
      remainingVotingSeconds(currentState || state)
    );
  }, 500);

  const form = document.querySelector("#proposalForm");

  if (form) {
    const proposalError =
      document.querySelector("#proposalError");

    form.onsubmit = (event) => {
      event.preventDefault();

      const title =
        document.querySelector("#proposalTitle").value.trim();

      const url =
        document.querySelector("#proposalUrl").value.trim();

      proposalError.textContent = "";

      if (!title || !url) {
        proposalError.textContent =
          "Для фильма укажи название и ссылку VK Видео.";
        return;
      }

      socket.emit(
        "vote:suggest",
        { title, url },
        (result) => {
          if (!result?.ok) {
            proposalError.textContent =
              result?.error ||
              "Не удалось предложить фильм.";
          }
        }
      );
    };

    const animeInput =
      document.querySelector("#animeSearchInput");

    const animeButton =
      document.querySelector("#animeSearchButton");

    const animeStatus =
      document.querySelector("#animeSearchStatus");

    const animeResults =
      document.querySelector("#animeSearchResults");

    const runAnimeSearch = () => {
      const query = animeInput.value.trim();

      proposalError.textContent = "";
      animeResults.innerHTML = "";

      if (query.length < 2) {
        animeStatus.textContent =
          "Введи хотя бы 2 символа.";
        return;
      }

      animeButton.disabled = true;
      animeStatus.textContent = "Ищу в Kodik…";

      socket.emit(
        "anime:search",
        { query },
        (result) => {
          animeButton.disabled = false;

          if (!result?.ok) {
            animeStatus.textContent =
              result?.error ||
              "Не удалось найти аниме.";
            return;
          }

          const results = Array.isArray(result.results)
            ? result.results
            : [];

          if (!results.length) {
            animeStatus.textContent =
              "Ничего похожего не найдено.";
            return;
          }

          animeStatus.textContent =
            `Найдено: ${results.length}. Выбери нужное.`;

          animeResults.innerHTML = results
            .map((item) => {
              const details = [
                item.year || null,
                item.type === "anime-serial"
                  ? item.episodesCount
                    ? `${item.episodesCount} эп.`
                    : "сериал"
                  : "фильм",
                Number(item.translationsCount) > 0
                  ? `${item.translationsCount} озвуч.`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              const orig =
                item.titleOrig &&
                item.titleOrig !== item.title
                  ? `<span>${esc(item.titleOrig)}</span>`
                  : "";

              return `
                <button
                  type="button"
                  class="anime-search-result"
                  data-anime-result="${esc(item.key)}"
                >
                  <div class="anime-result-main">
                    <strong>${esc(item.title)}</strong>
                    ${orig}
                    <small>${esc(details)}</small>
                  </div>

                  <div class="anime-result-add">
                    Предложить
                  </div>
                </button>
              `;
            })
            .join("");

          animeResults
            .querySelectorAll("[data-anime-result]")
            .forEach((button) => {
              button.onclick = () => {
                proposalError.textContent = "";
                animeStatus.textContent =
                  "Добавляю в голосование…";

                animeResults
                  .querySelectorAll("button")
                  .forEach((node) => {
                    node.disabled = true;
                  });

                socket.emit(
                  "vote:suggest-anime",
                  {
                    searchId: result.searchId,
                    resultKey:
                      button.dataset.animeResult,
                  },
                  (proposalResult) => {
                    if (!proposalResult?.ok) {
                      animeStatus.textContent = "";
                      proposalError.textContent =
                        proposalResult?.error ||
                        "Не удалось предложить аниме.";

                      animeResults
                        .querySelectorAll("button")
                        .forEach((node) => {
                          node.disabled = false;
                        });
                    }
                  }
                );
              };
            });
        }
      );
    };

    animeButton.onclick = runAnimeSearch;

    animeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runAnimeSearch();
      }
    });
  }

  document
    .querySelectorAll("[data-vote-id]")
    .forEach((button) => {
      button.onclick = () => {
        const errorBox =
          document.querySelector("#voteError");

        errorBox.textContent = "";

        socket.emit(
          "vote:cast",
          { suggestionId: button.dataset.voteId },
          (result) => {
            if (!result?.ok) {
              errorBox.textContent =
                result?.error ||
                "Не удалось проголосовать.";
            }
          }
        );
      };
    });
}

function remainingDubVotingSeconds(state) {
  return Math.max(
    0,
    Math.ceil(
      (Number(state.dubVoteEndsAt) - serverNowMs()) /
        1000
    )
  );
}

function renderDubVoting(state) {
  destroyPlayer();

  const options = Array.isArray(state.dubOptions)
    ? state.dubOptions
    : [];

  const anime = state.animeWinner || {};
  const searching = Boolean(state.dubSearching);

  app.innerHTML = `
    <main class="screen voting-screen">
      <section class="vote-wrap dub-vote-wrap">
        <header class="vote-header">
          <div>
            <div class="vote-kicker">
              🍥 АНИМЕ ВЫБРАНО
            </div>

            <h1>Выбираем озвучку</h1>

            <div class="dub-anime-title">
              ${esc(anime.title || "Аниме")}
              ${
                anime.year
                  ? `<span>${esc(anime.year)}</span>`
                  : ""
              }
            </div>
          </div>

          <div class="vote-timer" id="dubVoteTimer">
            ${
              searching || !state.dubVoteEndsAt
                ? "—"
                : fmt(remainingDubVotingSeconds(state))
            }
          </div>
        </header>

        ${
          state.notice
            ? `
              <div class="vote-notice">
                ${esc(state.notice)}
              </div>
            `
            : ""
        }

        <section class="vote-panel dub-vote-panel auto-dub-panel">
          ${
            searching
              ? `
                <div class="auto-dub-loading">
                  <div class="spinner"></div>
                  <strong>Ищу озвучки автоматически…</strong>
                  <span>AnimeGo → Kodik</span>
                </div>
              `
              : options.length
                ? `
                  <div class="dub-explanation">
                    Нашёл <strong>${options.length}</strong>
                    ${
                      options.length === 1
                        ? "вариант"
                        : "вариантов"
                    }.
                    Голосуй — победитель запустится автоматически.
                  </div>

                  <div class="suggestions dub-suggestions">
                    ${options
                      .map(
                        (item) => `
                          <button
                            class="suggestion ${
                              state.myDubVote === item.id
                                ? "selected"
                                : ""
                            }"
                            data-dub-vote-id="${esc(item.id)}"
                          >
                            <div class="suggestion-main">
                              <div class="suggestion-type">
                                🎙 Озвучка · ${esc(
                                  item.provider || "Kodik"
                                )}
                              </div>

                              <strong>${esc(item.title)}</strong>

                              <span>
                                ${
                                  Number(item.episode) === 1
                                    ? "Плеер найден по 1 серии"
                                    : `Плеер найден по серии ${esc(
                                        item.episode
                                      )}`
                                }
                              </span>
                            </div>

                            <div class="vote-count">
                              ${Number(item.votes) || 0}
                            </div>
                          </button>
                        `
                      )
                      .join("")}
                  </div>

                  <div id="dubVoteError" class="form-error"></div>
                `
                : `
                  <div class="auto-dub-empty">
                    <strong>Озвучки не найдены</strong>
                    <span>
                      Можно повторить поиск — вручную Kodik-ссылку
                      больше вводить не нужно.
                    </span>

                    <button
                      id="refreshDubsButton"
                      class="primary-action"
                      type="button"
                    >
                      Повторить поиск
                    </button>

                    <div
                      id="dubRefreshError"
                      class="form-error"
                    ></div>
                  </div>
                `
          }
        </section>
      </section>
    </main>
  `;

  const timer = document.querySelector("#dubVoteTimer");

  const timerInterval = setInterval(() => {
    if (!document.body.contains(timer)) {
      clearInterval(timerInterval);
      return;
    }

    const stateNow = currentState || state;

    timer.textContent =
      stateNow.dubSearching || !stateNow.dubVoteEndsAt
        ? "—"
        : fmt(remainingDubVotingSeconds(stateNow));
  }, 500);

  document
    .querySelectorAll("[data-dub-vote-id]")
    .forEach((button) => {
      button.onclick = () => {
        const errorBox =
          document.querySelector("#dubVoteError");

        if (errorBox) errorBox.textContent = "";

        socket.emit(
          "vote:dub-cast",
          {
            optionId: button.dataset.dubVoteId,
          },
          (result) => {
            if (!result?.ok && errorBox) {
              errorBox.textContent =
                result?.error ||
                "Не удалось проголосовать за озвучку.";
            }
          }
        );
      };
    });

  const refreshButton =
    document.querySelector("#refreshDubsButton");

  if (refreshButton) {
    refreshButton.onclick = () => {
      const errorBox =
        document.querySelector("#dubRefreshError");

      if (errorBox) errorBox.textContent = "";

      refreshButton.disabled = true;
      refreshButton.textContent = "Ищу…";

      socket.emit(
        "anime:refresh-dubs",
        {},
        (result) => {
          if (!result?.ok) {
            refreshButton.disabled = false;
            refreshButton.textContent =
              "Повторить поиск";

            if (errorBox) {
              errorBox.textContent =
                result?.error ||
                "Не удалось повторить поиск.";
            }
          }
        }
      );
    };
  }
}



/* ---------------- STATE / DISCORD ---------------- */

function renderState(state) {
  if (!state) return;

  if (state.phase === "WATCHING" || state.phase === "PAUSED") {
    setActivityOrientation("movie");
    renderMovie(state);
    return;
  }

  if (state.phase === "VOTING") {
    setActivityOrientation("ui");
    renderVoting(state);
    return;
  }

  if (state.phase === "DUB_VOTING") {
    setActivityOrientation("ui");
    renderDubVoting(state);
    return;
  }

  setActivityOrientation("ui");
  renderIdle();
}

async function authenticateDiscord() {
  await discordSdk.ready();

  // On phones Discord supports orientation locking. Desktop simply ignores it.
  setActivityOrientation("ui");

  if (discordSdk.guildId !== ALLOWED_GUILD_ID) {
    throw new Error("Activity открыта не на разрешённом сервере.");
  }

  const { code } = await discordSdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  const response = await fetch("/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || !json.access_token) {
    throw new Error(
      json.error ||
      "Не удалось получить Discord access token."
    );
  }

  const auth = await discordSdk.commands.authenticate({
    access_token: json.access_token,
  });

  if (!auth?.user?.id) {
    throw new Error("Discord authenticate не вернул пользователя.");
  }

  currentDiscordUserId = String(auth.user.id);

  return json.access_token;
}

function connectBackend(accessToken) {
  socket = io({
    transports: ["websocket", "polling"],
    auth: {
      accessToken,
      instanceId: discordSdk.instanceId,
      guildId: discordSdk.guildId,
      channelId: discordSdk.channelId,
    },
  });

  socket.on("connect", () => {
    console.log("[BACKEND] connected", socket.id);

    syncServerClock();

    clearInterval(clockSyncInterval);
    clockSyncInterval = setInterval(() => {
      syncServerClock();
    }, 30_000);
  });

  socket.on("connect_error", (error) => {
    console.error("[BACKEND] connect_error", error);
    renderFatal(
      "Нет соединения с Movie Night",
      error.message
    );
  });

  socket.on("session:state", (state) => {
    absorbStateClock(state);

    if (firstSessionState) {
      firstSessionState = false;

      if (
        state?.phase === "WATCHING" &&
        state?.movie
      ) {
        lateJoinCandidateKey = movieKey(state.movie);
      }
    }

    currentState = state;
    renderState(state);
  });

  socket.on("session:error", (message) => {
    console.error("[BACKEND] session:error", message);
  });
}

async function boot() {
  renderBoot("Подключение к Movie Night…");

  try {
    const accessToken = await authenticateDiscord();
    connectBackend(accessToken);
  } catch (error) {
    console.error(error);

    renderFatal(
      "Не удалось запустить Movie Night",
      error.message
    );
  }
}

boot();
