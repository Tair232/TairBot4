import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { Server as SocketIOServer } from "socket.io";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
  generateDependencyReport,
} from "@discordjs/voice";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, "dist");

// Bothost preserves /app/data between deploys.
// Local development falls back to the project's ./data directory.
const DATA_DIR =
  process.env.DATA_DIR ||
  (fs.existsSync("/app/data")
    ? "/app/data"
    : path.join(ROOT, "data"));

const STATE_FILE = path.join(DATA_DIR, "state.json");

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const CONTROL_ROLE_IDS = new Set(
  String(process.env.CONTROL_ROLE_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
const VOTING_DURATION_SECONDS = Math.max(
  60,
  Number(process.env.VOTING_DURATION_SECONDS) || 600
);

const DUB_VOTING_DURATION_SECONDS = Math.max(
  20,
  Number(process.env.DUB_VOTING_DURATION_SECONDS) || 60
);

const KODIK_API_KEY = String(process.env.KODIK_API_KEY || "").trim();

const KODIK_API_BASE_URL = String(
  process.env.KODIK_API_BASE_URL || "https://kodikapi.com"
).replace(/\/+$/, "");

const SHIKIMORI_API_BASE_URL = String(
  process.env.SHIKIMORI_API_BASE_URL || "https://shikimori.one"
).replace(/\/+$/, "");

const MOVIE_PRELOAD_SECONDS = Math.max(
  10,
  Number(process.env.MOVIE_PRELOAD_SECONDS) || 60
);

const LATE_JOIN_PRELOAD_SECONDS = Math.max(
  MOVIE_PRELOAD_SECONDS + 120,
  Number(process.env.LATE_JOIN_PRELOAD_SECONDS) ||
    MOVIE_PRELOAD_SECONDS + 120
);
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 3000;

function requireConfig() {
  const missing = [];

  for (const [name, value] of [
    ["DISCORD_CLIENT_ID", CLIENT_ID],
    ["DISCORD_GUILD_ID", GUILD_ID],
    ["DISCORD_VOICE_CHANNEL_ID", VOICE_CHANNEL_ID],
    ["DISCORD_BOT_TOKEN", BOT_TOKEN],
    ["DISCORD_CLIENT_SECRET", CLIENT_SECRET],
  ]) {
    if (!value || String(value).startsWith("PASTE_")) {
      missing.push(name);
    }
  }

  if (missing.length) {
    console.error("");
    console.error("====================================================");
    console.error(" MOVIE NIGHT: .env НЕ ЗАПОЛНЕН");
    console.error("====================================================");
    console.error("Заполни локально:");
    for (const name of missing) console.error(`  - ${name}`);
    console.error("");
    console.error("Токен и Client Secret НИКОМУ НЕ ОТПРАВЛЯЙ.");
    console.error("====================================================");
    console.error("");
    process.exit(1);
  }
}

requireConfig();

const defaultState = () => ({
  version: 1,
  phase: "IDLE",
  movie: null,
  positionSeconds: 0,
  startedAt: null,
  autoStartAt: null,
  seekRevision: 0,
  voteEndsAt: null,
  suggestions: [],
  votes: {},

  dubVoteEndsAt: null,
  animeWinner: null,
  dubOptions: [],
  dubVotes: {},
  dubSearching: false,

  notice: null,
  lastUpdatedAt: Date.now(),
});

function normalizeState(raw) {
  const base = defaultState();
  const state = { ...base, ...(raw || {}) };

  if (
    !["IDLE", "WATCHING", "PAUSED", "VOTING", "DUB_VOTING"].includes(
      state.phase
    )
  ) {
    state.phase = "IDLE";
  }

  if (!Array.isArray(state.suggestions)) state.suggestions = [];
  if (!state.votes || typeof state.votes !== "object") state.votes = {};

  if (!Array.isArray(state.dubOptions)) state.dubOptions = [];
  if (!state.dubVotes || typeof state.dubVotes !== "object") {
    state.dubVotes = {};
  }
  state.dubSearching = Boolean(state.dubSearching);

  return state;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (error) {
    console.error("Не удалось прочитать state.json:", error);
    return defaultState();
  }
}

let state = loadState();

// Ephemeral per-socket playback reports.
// They are intentionally NOT persisted to disk.
const playbackReports = new Map();

// Short-lived server-side cache of anime search results.
// The client only receives opaque result keys; Kodik links stay authoritative
// on the backend until a proposal is accepted.
const animeSearchCache = new Map();

function saveState() {
  state.lastUpdatedAt = Date.now();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temp, STATE_FILE);
}

function currentPosition() {
  const base = Math.max(0, Number(state.positionSeconds) || 0);

  if (state.phase === "WATCHING" && state.startedAt) {
    return base + (Date.now() - Number(state.startedAt)) / 1000;
  }

  return base;
}

function parseVk(raw) {
  raw = String(raw || "").trim();
  if (!raw) return null;

  let match = raw.match(/^(-?\d+)_(\d+)(?:_([a-zA-Z0-9]+))?$/);

  if (match) {
    return {
      oid: match[1],
      id: match[2],
      hash: match[3] || null,
      url: raw,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!/(\.|^)(vkvideo\.ru|vk\.com|vk\.ru)$/i.test(url.hostname)) {
    return null;
  }

  if (url.pathname.endsWith("/video_ext.php")) {
    const oid = url.searchParams.get("oid");
    const id = url.searchParams.get("id");

    if (oid && id) {
      return {
        oid,
        id,
        hash: url.searchParams.get("hash"),
        url: raw,
      };
    }
  }

  match = url.pathname.match(/\/(?:video|clip)(-?\d+)_(\d+)/i);

  if (match) {
    return {
      oid: match[1],
      id: match[2],
      hash:
        url.searchParams.get("hash") ||
        url.searchParams.get("access_hash") ||
        null,
      url: raw,
    };
  }

  const z = url.searchParams.get("z");

  if (z) {
    match = z.match(/(?:video|clip)(-?\d+)_(\d+)/i);

    if (match) {
      return {
        oid: match[1],
        id: match[2],
        hash: null,
        url: raw,
      };
    }
  }

  return null;
}

function parseKodik(raw) {
  raw = String(raw || "").trim();
  if (!raw) return null;

  if (raw.startsWith("//")) {
    raw = `https:${raw}`;
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    return null;
  }

  const hostname = String(url.hostname || "").toLowerCase();

  if (
    hostname !== "kodik.info" &&
    hostname !== "kodikplayer.com"
  ) {
    return null;
  }

  if (!url.pathname || url.pathname === "/") {
    return null;
  }

  url.protocol = "https:";
  url.port = "";

  if (!url.searchParams.has("hide_selectors")) {
    url.searchParams.set("hide_selectors", "true");
  }

  return {
    url: url.toString(),
    kodikHost: hostname,
    kodikPath: `${url.pathname}${url.search}${url.hash || ""}`,
  };
}

function normalizeKodikPlayerUrl(raw) {
  raw = String(raw || "").trim();

  if (!raw) return null;

  if (raw.startsWith("//")) {
    raw = `https:${raw}`;
  } else if (raw.startsWith("http://")) {
    raw = `https://${raw.slice("http://".length)}`;
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const hostname = String(url.hostname || "").toLowerCase();

  if (
    hostname !== "kodik.info" &&
    hostname !== "kodikplayer.com"
  ) {
    return null;
  }

  url.protocol = "https:";
  url.port = "";

  return url.toString();
}

function cleanAnimeType(value) {
  return String(value || "").toLowerCase();
}

function isAnimeRelease(item) {
  const type = cleanAnimeType(item?.type || item?.release_type);
  return type === "anime" || type === "anime-serial";
}

function animeIdentity(item) {
  if (item?.shikimori_id) {
    return `shiki:${item.shikimori_id}`;
  }

  if (item?.kinopoisk_id) {
    return `kp:${item.kinopoisk_id}`;
  }

  const title = String(
    item?.title_orig || item?.title || ""
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return [
    "title",
    title,
    Number(item?.year) || 0,
    cleanAnimeType(item?.type || item?.release_type),
  ].join(":");
}

function normalizeSearchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/\s+/g, " ");
}

function animeSearchScore(item, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(item.title);
  const orig = normalizeSearchText(item.titleOrig);
  const other = normalizeSearchText(item.otherTitle);

  if (title === q || orig === q || other === q) return 100;
  if (title.startsWith(q) || orig.startsWith(q)) return 80;
  if (title.includes(q) || orig.includes(q) || other.includes(q)) {
    return 60;
  }

  return 20;
}

async function kodikSearch(params = {}) {
  if (!KODIK_API_KEY) {
    throw new Error(
      "KODIK_API_KEY не настроен на Bothost."
    );
  }

  const query = new URLSearchParams({
    token: KODIK_API_KEY,
  });

  for (const [key, value] of Object.entries(params)) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    query.set(key, String(value));
  }

  let response;

  try {
    response = await fetch(
      `${KODIK_API_BASE_URL}/search?${query}`,
      {
        method: "POST",
        redirect: "follow",
        cache: "no-store",
        headers: {
          "Accept": "application/json",
          "Cache-Control": "no-cache",
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Kodik API недоступен: ${error?.message || error}`
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `Kodik API HTTP ${response.status}`
    );
  }

  if (data?.error) {
    throw new Error(String(data.error));
  }

  return Array.isArray(data?.results)
    ? data.results
    : [];
}

async function searchAnimeTitles(queryText) {
  queryText = String(queryText || "").trim();

  if (queryText.length < 2) {
    throw new Error("Введи хотя бы 2 символа.");
  }

  const params = new URLSearchParams({
    search: queryText,
    limit: "8",
    order: "popularity",
  });

  let response;

  try {
    response = await fetch(
      `${SHIKIMORI_API_BASE_URL}/api/animes?${params}`,
      {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        headers: {
          "Accept": "application/json",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "User-Agent":
            "MovieNightDiscordActivity/2.0 (anime title search)",
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Shikimori недоступен: ${error?.message || error}`
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      `Shikimori API HTTP ${response.status}`
    );
  }

  if (!Array.isArray(data)) {
    throw new Error("Shikimori вернул неожиданный ответ.");
  }

  return data
    .filter((item) => item?.id && (item?.russian || item?.name))
    .slice(0, 8)
    .map((item) => {
      const airedYear =
        typeof item.aired_on === "string" &&
        /^\\d{4}/.test(item.aired_on)
          ? Number(item.aired_on.slice(0, 4))
          : null;

      const kind = String(item.kind || "").toLowerCase();

      return {
        key: `shiki:${item.id}`,
        title: String(item.russian || item.name || "Аниме"),
        titleOrig: String(item.name || ""),
        otherTitle: "",
        year: airedYear,
        type: kind === "movie" ? "anime" : "anime-serial",
        shikimoriId: String(item.id),
        kinopoiskId: null,
        episodesCount:
          Number(item.episodes) ||
          Number(item.episodes_aired) ||
          null,
        translationsCount: null,
        shikimoriKind: kind,
      };
    });
}
async function findAnimeTranslationOptions(anime) {
  if (!KODIK_API_KEY) {
    return [];
  }

  const params = {
    limit: 100,
    types: "anime,anime-serial",
  };

  if (anime.shikimoriId) {
    params.shikimori_id = anime.shikimoriId;
  } else if (anime.kinopoiskId) {
    params.kinopoisk_id = anime.kinopoiskId;
  } else {
    params.title = anime.title;
  }

  const releases = await kodikSearch(params);

  const matching = releases.filter((release) => {
    if (!isAnimeRelease(release)) return false;

    if (anime.shikimoriId) {
      return String(release.shikimori_id || "") ===
        String(anime.shikimoriId);
    }

    if (anime.kinopoiskId) {
      return String(release.kinopoisk_id || "") ===
        String(anime.kinopoiskId);
    }

    return animeIdentity(release) === anime.key;
  });

  const voice = new Map();
  const fallback = new Map();

  for (const release of matching) {
    const link = normalizeKodikPlayerUrl(release.link);
    const tr = release.translation;

    if (!link || !tr?.id) continue;

    const option = {
      id: String(tr.id),
      title: String(tr.title || "Озвучка"),
      translationType: String(
        tr.type || tr.translation_type || ""
      ),
      link,
      releaseId: String(release.id || ""),
      episodesCount:
        Number(release.episodes_count) ||
        anime.episodesCount ||
        null,
      createdAt: Date.now(),
    };

    fallback.set(option.id, option);

    if (option.translationType === "voice") {
      voice.set(option.id, option);
    }
  }

  const chosen = voice.size ? voice : fallback;

  return [...chosen.values()]
    .sort((a, b) =>
      a.title.localeCompare(b.title, "ru")
    )
    .slice(0, 30);
}

function parseTime(value) {
  value = String(value || "").trim();

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.max(0, Number(value));
  }

  const parts = value.split(":").map(Number);

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((n) => !Number.isFinite(n) || n < 0)
  ) {
    return null;
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTime(seconds) {
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

function sanitizeStateFor(userId) {
  const counts = new Map();

  for (const suggestion of state.suggestions) {
    counts.set(suggestion.id, 0);
  }

  for (const suggestionId of Object.values(state.votes)) {
    counts.set(suggestionId, (counts.get(suggestionId) || 0) + 1);
  }

  const suggestions = state.suggestions.map((item) => ({
    id: item.id,
    kind: item.kind || "MOVIE",
    title: item.title,
    year: item.year || null,
    episodesCount: item.episodesCount || null,
    proposerName: item.proposerName,
    votes: counts.get(item.id) || 0,
  }));

  const dubCounts = new Map();

  for (const option of state.dubOptions) {
    dubCounts.set(option.id, 0);
  }

  for (const optionId of Object.values(state.dubVotes)) {
    dubCounts.set(
      optionId,
      (dubCounts.get(optionId) || 0) + 1
    );
  }

  const dubOptions = state.dubOptions.map((item) => ({
    id: item.id,
    title: item.title,
    translationType: item.translationType,
    provider: item.provider || "Kodik",
    episode: Number(item.episode) || 1,
    votes: dubCounts.get(item.id) || 0,
  }));

  const mySuggestion = state.suggestions.find(
    (item) => item.proposerUserId === userId
  );

  return {
    phase: state.phase,
    movie: state.movie,
    positionSeconds: state.positionSeconds,
    startedAt: state.startedAt,
    autoStartAt: state.autoStartAt,
    seekRevision: Number(state.seekRevision) || 0,

    voteEndsAt: state.voteEndsAt,
    suggestions,
    mySuggestionId: mySuggestion?.id || null,
    myVote: state.votes[userId] || null,

    dubVoteEndsAt: state.dubVoteEndsAt,
    animeWinner: state.animeWinner
      ? {
          title: state.animeWinner.title,
          titleOrig: state.animeWinner.titleOrig || "",
          year: state.animeWinner.year || null,
          episodesCount:
            state.animeWinner.episodesCount || null,
        }
      : null,
    dubOptions,
    myDubVote: state.dubVotes[userId] || null,
    dubSearching: Boolean(state.dubSearching),

    notice: state.notice || null,

    serverNow: Date.now(),
    lateJoinPreloadSeconds: LATE_JOIN_PRELOAD_SECONDS,
  };
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "movie-night",
    time: Date.now(),
  });
});


function decodeVkEmbedUrl(value) {
  return String(value || "")
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&");
}

function extractVkEmbedMp4Files(html) {
  const files = {};

  for (const quality of [
    "144",
    "240",
    "360",
    "480",
    "720",
    "1080",
    "1440",
    "2160",
  ]) {
    const match = String(html || "").match(
      new RegExp(`"mp4_${quality}"\\s*:\\s*"([^"]+)"`, "i")
    );

    if (match) {
      files[`mp4_${quality}`] = decodeVkEmbedUrl(match[1]);
    }
  }

  return files;
}

function validVkOid(value) {
  return /^-?\d+$/.test(String(value || ""));
}

function validVkVideoId(value) {
  return /^\d+$/.test(String(value || ""));
}

function validVkHash(value) {
  return (
    value == null ||
    value === "" ||
    /^[a-zA-Z0-9_-]{1,256}$/.test(String(value))
  );
}

app.get("/api/vk-meta", async (req, res) => {
  const oid = String(req.query.oid || "");
  const id = String(req.query.id || "");
  const hash = req.query.hash == null
    ? null
    : String(req.query.hash);

  if (
    !validVkOid(oid) ||
    !validVkVideoId(id) ||
    !validVkHash(hash)
  ) {
    res.status(400).json({
      error: "Invalid VK video parameters",
    });
    return;
  }

  const params = new URLSearchParams({
    oid,
    id,
    hd: "4",
    autoplay: "0",
    js_api: "1",
  });

  if (hash) {
    params.set("hash", hash);
  }

  const url = `https://vk.com/video_ext.php?${params}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/140.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://vkvideo.ru/",
      },
    });

    const html = await response.text();

    if (!response.ok) {
      console.warn(
        `⚠️ Backend VK metadata HTTP ${response.status} for ${oid}_${id}`
      );

      res.status(502).json({
        error: `VK metadata HTTP ${response.status}`,
      });
      return;
    }

    const files = extractVkEmbedMp4Files(html);

    if (!Object.keys(files).length) {
      console.warn(
        `⚠️ Backend VK metadata returned no MP4 for ${oid}_${id}`
      );

      res.status(502).json({
        error: "VK metadata returned no MP4",
      });
      return;
    }

    console.log(
      `✅ Fresh backend VK metadata ${oid}_${id}: ` +
      `${Object.keys(files).join(", ")}`
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );
    res.setHeader("Pragma", "no-cache");

    res.json({
      ok: true,
      files,
    });
  } catch (error) {
    console.error(
      "❌ /api/vk-meta:",
      error?.message || error
    );

    res.status(502).json({
      error: "VK metadata fetch failed",
    });
  }
});

function isAllowedVkMediaHost(hostname) {
  hostname = String(hostname || "").toLowerCase();

  return (
    hostname.endsWith(".okcdn.ru") ||
    hostname.endsWith(".vkuser.net")
  );
}

let activeMediaRelayRequests = 0;
let mediaRelayRequestSerial = 0;

app.get("/api/media", async (req, res) => {
  let mediaUrl;

  try {
    mediaUrl = new URL(String(req.query.url || ""));
  } catch {
    res.status(400).send("Bad media URL");
    return;
  }

  if (
    mediaUrl.protocol !== "https:" ||
    !isAllowedVkMediaHost(mediaUrl.hostname)
  ) {
    res.status(403).send("Media host is not allowed");
    return;
  }

  const relayId = ++mediaRelayRequestSerial;
  activeMediaRelayRequests += 1;

  console.log(
    `📡 MEDIA relay#${relayId} open active=${activeMediaRelayRequests} ` +
    `host=${mediaUrl.hostname} range=${req.headers.range || "none"}`
  );

  let relayCountClosed = false;

  const markRelayClosed = (reason) => {
    if (relayCountClosed) return;
    relayCountClosed = true;
    activeMediaRelayRequests = Math.max(
      0,
      activeMediaRelayRequests - 1
    );

    console.log(
      `📡 MEDIA relay#${relayId} close active=${activeMediaRelayRequests} ` +
      `reason=${reason}`
    );
  };

  const controller = new AbortController();

  const abortUpstream = () => {
    try {
      controller.abort();
    } catch {}
  };

  req.on("aborted", () => {
    markRelayClosed("request-aborted");
    abortUpstream();
  });

  res.on("finish", () => {
    markRelayClosed("finish");
  });

  res.on("close", () => {
    markRelayClosed(
      res.writableEnded ? "close-after-end" : "client-close"
    );

    if (!res.writableEnded) {
      abortUpstream();
    }
  });

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Referer": "https://vkvideo.ru/",
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    const upstream = await fetch(mediaUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers,
      signal: controller.signal,
    });

    console.log(
      `📡 MEDIA relay#${relayId} upstream=${upstream.status} ` +
      `type=${upstream.headers.get("content-type") || "-"} ` +
      `length=${upstream.headers.get("content-length") || "-"} ` +
      `range=${upstream.headers.get("content-range") || "-"}`
    );

    if (!upstream.ok && upstream.status !== 206) {
      console.warn(
        `⚠️ Media relay HTTP ${upstream.status}: ${mediaUrl.hostname}`
      );

      markRelayClosed(`upstream-http-${upstream.status}`);

      res
        .status(upstream.status)
        .send(`VK media upstream HTTP ${upstream.status}`);

      return;
    }

    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Movie-Night-Media-Relay", "1");
    res.setHeader("X-Accel-Buffering", "no");

    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body)
      .on("error", (error) => {
        if (error?.name !== "AbortError") {
          console.error(
            "❌ Media relay stream:",
            error?.message || error
          );
        }

        if (res.headersSent) {
          res.destroy();
        } else {
          res.status(502).end();
        }
      })
      .pipe(res);
  } catch (error) {
    markRelayClosed(
      error?.name === "AbortError"
        ? "abort-error"
        : "relay-error"
    );

    if (error?.name === "AbortError") return;

    console.error(
      "❌ /api/media:",
      error?.message || error
    );

    if (!res.headersSent) {
      res.status(502).send("VK media relay failed");
    }
  }
});

// Production: Vite is built into ./dist and served by the same Express app.
// Development still uses the separate Vite dev server.
if (fs.existsSync(DIST_DIR)) {
  // Discord Activity clients can stay alive for a long time. Never cache the
  // shell/assets here: mixed client builds caused some viewers to use /kodik
  // while others used /kodikplayer in the same room.
  app.use(express.static(DIST_DIR, {
    index: false,
    maxAge: 0,
    etag: false,
    setHeaders(res) {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  }));
}

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: "/socket.io",
  cors: { origin: false },
});

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let voiceConnection = null;

async function setVoiceStatus(status) {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${VOICE_CHANNEL_ID}/voice-status`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: status ? String(status).slice(0, 500) : null,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `Voice status error ${response.status}:`,
        text.slice(0, 500)
      );
    }
  } catch (error) {
    console.error("setVoiceStatus:", error);
  }
}

function desiredVoiceStatus() {
  if (state.phase === "WATCHING" || state.phase === "PAUSED") {
    const prefix =
      state.movie?.source === "KODIK"
        ? "Смотрим аниме"
        : "Смотрим";

    return `${prefix}: ${state.movie?.title || "видео"}`;
  }

  if (state.phase === "VOTING") {
    return "Выбираем фильм или аниме";
  }

  if (state.phase === "DUB_VOTING") {
    return `Выбираем озвучку: ${
      state.animeWinner?.title || "аниме"
    }`;
  }

  return null;
}

async function syncVoiceStatus() {
  await setVoiceStatus(desiredVoiceStatus());
}

let voiceReconnectTimer = null;
let voiceJoinBusy = false;

function voiceStateLabel(connection) {
  try {
    return connection?.state?.status || "unknown";
  } catch {
    return "unknown";
  }
}

function scheduleVoiceReconnect(delayMs = 10_000) {
  if (voiceReconnectTimer) return;

  console.log(`🔁 Следующая попытка входа в voice через ${Math.round(delayMs / 1000)} сек.`);
  voiceReconnectTimer = setTimeout(async () => {
    voiceReconnectTimer = null;
    await ensureVoiceConnection();
  }, delayMs);
}

function attachVoiceDebug(connection) {
  if (connection.__movieNightDebugAttached) return;
  connection.__movieNightDebugAttached = true;

  connection.on("stateChange", (oldState, newState) => {
    console.log(`🎙 Voice state: ${oldState.status} -> ${newState.status}`);

    if (newState.status === VoiceConnectionStatus.Ready) {
      console.log("✅ Voice connection READY");
    }

    if (
      newState.status === VoiceConnectionStatus.Disconnected ||
      newState.status === VoiceConnectionStatus.Destroyed
    ) {
      scheduleVoiceReconnect(5_000);
    }
  });

  connection.on("error", (error) => {
    console.error("🎙 Voice connection error:", error);
  });

  connection.on("debug", (message) => {
    console.log("🎙 Voice debug:", message);
  });
}

async function printVoiceDiagnostics(guild, channel) {
  const me = await guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);

  const has = (flag) => Boolean(permissions?.has(flag));

  console.log("");
  console.log("=============== VOICE DIAGNOSTICS ===============");
  console.log(`Voice channel: ${channel.name} (${channel.id})`);
  console.log(`Channel type: ${channel.type}`);
  console.log(`Bot member: ${me.user.tag} (${me.id})`);
  console.log(`ViewChannel: ${has(PermissionsBitField.Flags.ViewChannel) ? "YES" : "NO"}`);
  console.log(`Connect: ${has(PermissionsBitField.Flags.Connect) ? "YES" : "NO"}`);
  console.log(`Speak: ${has(PermissionsBitField.Flags.Speak) ? "YES" : "NO"}`);
  console.log(`ManageChannels: ${has(PermissionsBitField.Flags.ManageChannels) ? "YES" : "NO"}`);
  console.log(`Channel userLimit: ${channel.userLimit ?? "n/a"}`);
  console.log(`Channel members: ${channel.members?.size ?? "n/a"}`);
  console.log("-------------------------------------------------");

  try {
    console.log(generateDependencyReport());
  } catch (error) {
    console.log("Dependency report failed:", error.message);
  }

  console.log("=================================================");
  console.log("");

  if (!has(PermissionsBitField.Flags.ViewChannel)) {
    throw new Error("У бота нет View Channel для настроенного войса.");
  }

  if (!has(PermissionsBitField.Flags.Connect)) {
    throw new Error("У бота нет Connect для настроенного войса.");
  }

  if (
    channel.userLimit &&
    channel.members &&
    channel.members.size >= channel.userLimit &&
    !has(PermissionsBitField.Flags.MoveMembers)
  ) {
    console.warn(
      "⚠ Voice channel заполнен до user limit. Discord может не прислать voice server update."
    );
  }
}

function botIsPresentInConfiguredVoice() {
  if (!bot.isReady()) return false;

  const guild = bot.guilds.cache.get(GUILD_ID);
  const voiceState = guild?.voiceStates?.cache?.get(bot.user.id);

  return voiceState?.channelId === VOICE_CHANNEL_ID;
}

async function ensureVoiceConnection() {
  if (!bot.isReady() || voiceJoinBusy) return;

  // Movie Night never sends or receives voice audio.
  // If Discord Gateway already reports the bot inside the configured channel,
  // the logical-host requirement is satisfied even if the media transport
  // (@discordjs/voice Ready) failed because of DNS/UDP/WebSocket issues.
  if (botIsPresentInConfiguredVoice()) {
    return;
  }

  voiceJoinBusy = true;

  try {
    const guild = await bot.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

    if (!channel || !channel.isVoiceBased()) {
      throw new Error("DISCORD_VOICE_CHANNEL_ID не является voice channel.");
    }

    await printVoiceDiagnostics(guild, channel);

    let existing = getVoiceConnection(GUILD_ID);

    if (existing?.state?.status === VoiceConnectionStatus.Destroyed) {
      existing = null;
    }

    if (existing) {
      voiceConnection = existing;
      attachVoiceDebug(voiceConnection);

      if (voiceConnection.state.status === VoiceConnectionStatus.Ready) {
        console.log(`✅ Бот уже подключён к войсу: ${channel.name}`);
        return;
      }

      console.log(
        `🎙 Существующее voice connection: ${voiceStateLabel(voiceConnection)}. Пробую rejoin...`
      );

      try {
        voiceConnection.rejoin({
          channelId: VOICE_CHANNEL_ID,
          selfMute: true,
          selfDeaf: true,
        });
      } catch (error) {
        console.error("voice rejoin():", error);
      }
    } else {
      console.log(`🎙 Подключаюсь к voice: ${channel.name}...`);

      voiceConnection = joinVoiceChannel({
        channelId: VOICE_CHANNEL_ID,
        guildId: GUILD_ID,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: true,
        selfDeaf: true,
      });

      attachVoiceDebug(voiceConnection);
    }

    try {
      await entersState(
        voiceConnection,
        VoiceConnectionStatus.Ready,
        30_000
      );

      console.log(`✅ Бот подключён к войсу: ${channel.name}`);
    } catch (error) {
      if (botIsPresentInConfiguredVoice()) {
        console.log(
          `✅ Бот уже находится в войсе "${channel.name}". Media Ready не требуется: бот не передаёт аудио.`
        );
        return;
      }

      console.error(
        `❌ Voice не достиг Ready за 30 сек. Текущее состояние: ${voiceStateLabel(voiceConnection)}`
      );
      console.error(
        `   ${error?.name || "Error"}: ${error?.message || error}`
      );

      scheduleVoiceReconnect(10_000);
    }
  } catch (error) {
    console.error("❌ Не удалось подключиться к voice:", error.message || error);
    scheduleVoiceReconnect(15_000);
  } finally {
    voiceJoinBusy = false;
  }
}

async function joinConfiguredVoice() {
  return ensureVoiceConnection();
}

function hasControlRole(interaction) {
  if (!interaction.inGuild()) return false;

  const roleCache = interaction.member?.roles?.cache;
  if (!roleCache) return false;

  return roleCache.some((role) => CONTROL_ROLE_IDS.has(role.id));
}

async function deny(interaction) {
  await interaction.reply({
    content: "У тебя нет роли для управления Movie Night.",
    flags: MessageFlags.Ephemeral,
  });
}

function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    const userId = socket.data.user?.id;
    if (!userId) continue;
    socket.emit("session:state", sanitizeStateFor(userId));
  }
}

function activePlaybackReportsForCurrentMovie() {
  if (!state.movie) return [];

  const key = movieKey(state.movie);
  const now = Date.now();

  return [...playbackReports.values()].filter((report) => {
    return (
      report.movieKey === key &&
      report.participating === true &&
      now - report.lastReportAt <= 15_000
    );
  });
}

function allActiveViewersFinished() {
  if (!state.movie?.duration) return false;

  const reports = activePlaybackReportsForCurrentMovie();

  // No connected/participating Activity viewers -> do not keep the room stuck.
  if (!reports.length) return true;

  const finishLine = Math.max(0, state.movie.duration - 1.25);

  return reports.every((report) => {
    return (
      report.ended === true ||
      Number(report.currentTime || 0) >= finishLine
    );
  });
}

let lastWaitingForViewersLogAt = 0;

async function startMovie(title, rawUrl) {
  const parsed = parseVk(rawUrl);

  if (!parsed) {
    throw new Error("Не понял VK Видео ссылку.");
  }

  const autoStartAt = Date.now() + MOVIE_PRELOAD_SECONDS * 1000;

  playbackReports.clear();

  state = {
    ...defaultState(),
    phase: "PAUSED",
    movie: {
      source: "VK",
      title: String(title || "").trim().slice(0, 100),
      url: parsed.url,
      oid: parsed.oid,
      id: parsed.id,
      hash: parsed.hash,
      duration: null,
    },
    positionSeconds: 0,
    startedAt: null,
    autoStartAt,
  };

  console.log(
    `⏳ Предзагрузка: ${state.movie.title}. Автостарт через ${MOVIE_PRELOAD_SECONDS} сек.`
  );

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

async function startAnime(title, rawUrl, extra = {}) {
  const parsed = parseKodik(rawUrl);

  if (!parsed) {
    throw new Error(
      "Нужна ссылка Kodik player с kodik.info или kodikplayer.com."
    );
  }

  const autoStartAt = Date.now() + MOVIE_PRELOAD_SECONDS * 1000;

  playbackReports.clear();

  state = {
    ...defaultState(),
    phase: "PAUSED",
    movie: {
      source: "KODIK",
      title: String(title || "").trim().slice(0, 100),
      url: parsed.url,
      kodikHost: parsed.kodikHost,
      kodikPath: parsed.kodikPath,
      dubTitle: extra.dubTitle
        ? String(extra.dubTitle).slice(0, 100)
        : null,
      animeKey: extra.animeKey || null,
      duration: null,
    },
    positionSeconds: 0,
    startedAt: null,
    autoStartAt,
  };

  console.log(
    `🍥 Anime preload: ${state.movie.title}. ` +
    `Kodik=${state.movie.kodikPath}. ` +
    `Автостарт через ${MOVIE_PRELOAD_SECONDS} сек.`
  );

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

async function pauseMovie() {
  if (state.phase !== "WATCHING") {
    if (state.phase === "PAUSED" && state.autoStartAt) {
      const left = Math.max(
        0,
        Math.ceil((state.autoStartAt - Date.now()) / 1000)
      );
      throw new Error(
        `Фильм уже на предзагрузке. Автостарт через ${formatTime(left)}.`
      );
    }

    throw new Error("Сейчас фильм не воспроизводится.");
  }

  state.positionSeconds = currentPosition();
  state.startedAt = null;
  state.phase = "PAUSED";
  state.autoStartAt = null;

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

async function resumeMovie() {
  if (state.phase !== "PAUSED") {
    throw new Error("Фильм сейчас не на паузе.");
  }

  if (state.autoStartAt) {
    const left = Math.max(
      0,
      Math.ceil((state.autoStartAt - Date.now()) / 1000)
    );

    throw new Error(
      `Сейчас идёт обязательная предзагрузка. Старт через ${formatTime(left)}.`
    );
  }

  state.startedAt = Date.now();
  state.phase = "WATCHING";

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

async function seekMovie(seconds) {
  if (!["WATCHING", "PAUSED"].includes(state.phase) || !state.movie) {
    throw new Error("Сейчас нет активного фильма.");
  }

  if (state.autoStartAt) {
    const left = Math.max(
      0,
      Math.ceil((state.autoStartAt - Date.now()) / 1000)
    );

    throw new Error(
      `До автостарта идёт предзагрузка. Осталось ${formatTime(left)}.`
    );
  }

  seconds = Math.max(0, Number(seconds) || 0);

  if (state.movie.duration) {
    seconds = Math.min(seconds, Math.max(0, state.movie.duration - 0.25));
  }

  state.positionSeconds = seconds;
  state.seekRevision = (Number(state.seekRevision) || 0) + 1;

  if (state.phase === "WATCHING") {
    state.startedAt = Date.now();
  }

  console.log(
    `⏩ Seek revision=${state.seekRevision} -> ${formatTime(seconds)}`
  );

  saveState();
  broadcastState();
}

async function startVoting() {
  playbackReports.clear();

  state = {
    ...defaultState(),
    phase: "VOTING",
    voteEndsAt: Date.now() + VOTING_DURATION_SECONDS * 1000,
    suggestions: [],
    votes: {},
  };

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

function runExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      options,
      (error, stdout, stderr) => {
        if (stderr?.trim()) {
          console.log(
            `🍥 Anime helper: ${stderr.trim().slice(0, 4000)}`
          );
        }

        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

async function discoverAutomaticDubOptions(anime) {
  const args = [
    path.join(ROOT, "anime_sources.py"),
    "--title",
    String(anime.title || ""),
    "--orig",
    String(anime.titleOrig || ""),
  ];

  if (anime.year) {
    args.push("--year", String(anime.year));
  }

  console.log(
    `🔎 Auto dub search: ${anime.title} ` +
    `(Shikimori=${anime.shikimoriId || "-"}, year=${anime.year || "-"})`
  );

  let stdout = "";

  try {
    const result = await runExecFile(
      "python3",
      args,
      {
        cwd: ROOT,
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      }
    );

    stdout = result.stdout;
  } catch (error) {
    // The helper intentionally exits non-zero when no sources were found.
    // Its JSON stdout still contains a useful reason, so parse it first.
    stdout = String(error?.stdout || "");

    if (!stdout.trim()) {
      throw new Error(
        `Автопоиск озвучек не запустился: ${
          error?.killed
            ? "таймаут 45 секунд"
            : error?.message || error
        }`
      );
    }
  }

  let data;

  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      "Автопоиск озвучек вернул некорректный ответ."
    );
  }

  if (!data?.ok || !Array.isArray(data.options)) {
    throw new Error(
      data?.error ||
      "AnimeGo не вернул Kodik-озвучки."
    );
  }

  const options = [];
  const seen = new Set();

  for (const raw of data.options) {
    const parsed = parseKodik(raw?.url);

    if (!parsed) continue;

    const title = String(raw?.title || "Озвучка")
      .trim()
      .slice(0, 100);

    const key = `${title.toLowerCase()}|${parsed.url}`;

    if (seen.has(key)) continue;
    seen.add(key);

    options.push({
      id: crypto.randomUUID(),
      title,
      translationType: "voice",
      link: parsed.url,
      releaseId: null,
      episodesCount: anime.episodesCount || null,
      episode: Number(raw?.episode) || 1,
      provider: String(raw?.provider || "AnimeGo/Kodik"),
      proposerUserId: null,
      proposerName: null,
      manual: false,
      createdAt: Date.now() + options.length,
    });
  }

  if (!options.length) {
    throw new Error(
      "Нашлись источники, но среди них нет поддерживаемых Kodik-ссылок."
    );
  }

  console.log(
    `✅ Auto dub search: ${anime.title} -> ${options.length} Kodik variants`
  );

  return options;
}

async function populateDubOptions({ isRetry = false } = {}) {
  if (state.phase !== "DUB_VOTING" || !state.animeWinner) {
    return false;
  }

  const animeKey = state.animeWinner.key;
  const anime = { ...state.animeWinner };

  state.dubSearching = true;
  state.dubVoteEndsAt = null;
  state.dubOptions = [];
  state.dubVotes = {};
  state.notice = isRetry
    ? "Повторно ищу доступные Kodik-озвучки…"
    : "Ищу доступные Kodik-озвучки автоматически…";

  saveState();
  broadcastState();

  let options = [];
  let discoveryError = null;

  try {
    options = await discoverAutomaticDubOptions(anime);
  } catch (error) {
    discoveryError = error;
    console.warn(
      `⚠️ Auto dub search failed for ${anime.title}:`,
      error?.message || error
    );
  }

  // The room could have moved to another phase while the scraper was working.
  if (
    state.phase !== "DUB_VOTING" ||
    state.animeWinner?.key !== animeKey
  ) {
    return false;
  }

  // If the owner later configures an official Kodik API key, keep it as a
  // secondary fallback. No key is required for the normal path.
  if (!options.length && KODIK_API_KEY) {
    try {
      options = await findAnimeTranslationOptions(anime);
      console.log(
        `✅ Official Kodik fallback -> ${options.length} variants`
      );
    } catch (error) {
      console.warn(
        "⚠️ Official Kodik fallback failed:",
        error?.message || error
      );
    }
  }

  state.dubSearching = false;
  state.dubOptions = options;
  state.dubVotes = {};

  if (options.length) {
    state.notice = null;
    state.dubVoteEndsAt =
      Date.now() + DUB_VOTING_DURATION_SECONDS * 1000;
  } else {
    state.notice =
      `Не удалось автоматически найти Kodik-озвучки. ${
        discoveryError?.message || "Источник временно недоступен."
      } Нажми «Повторить поиск».`;

    state.dubVoteEndsAt = null;
  }

  saveState();
  broadcastState();
  return options.length > 0;
}

async function startDubVoting(animeSuggestion) {
  const anime = {
    key: animeSuggestion.animeKey,
    title: animeSuggestion.title,
    titleOrig: animeSuggestion.titleOrig || "",
    year: animeSuggestion.year || null,
    type: animeSuggestion.animeType || null,
    shikimoriId: animeSuggestion.shikimoriId || null,
    kinopoiskId: animeSuggestion.kinopoiskId || null,
    episodesCount: animeSuggestion.episodesCount || null,
  };

  playbackReports.clear();

  state = {
    ...defaultState(),
    phase: "DUB_VOTING",
    animeWinner: anime,
    dubVoteEndsAt: null,
    dubOptions: [],
    dubVotes: {},
    dubSearching: true,
    notice: "Ищу доступные Kodik-озвучки автоматически…",
  };

  console.log(
    `🎙 Anime won: ${anime.title}. Starting automatic dub discovery.`
  );

  saveState();
  broadcastState();
  await syncVoiceStatus();

  // Keep the room in DUB_VOTING while discovery happens, so clients see a
  // clear loading state instead of remaining on the expired main vote.
  await populateDubOptions();
}


function chooseDubWinner() {
  if (!state.dubOptions.length) return null;

  const counts = new Map();

  for (const item of state.dubOptions) {
    counts.set(item.id, 0);
  }

  for (const optionId of Object.values(state.dubVotes)) {
    counts.set(
      optionId,
      (counts.get(optionId) || 0) + 1
    );
  }

  return [...state.dubOptions].sort((a, b) => {
    const diff =
      (counts.get(b.id) || 0) -
      (counts.get(a.id) || 0);

    if (diff !== 0) return diff;

    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  })[0];
}

async function finishDubVoting() {
  if (state.phase !== "DUB_VOTING") {
    throw new Error(
      "Сейчас нет голосования за озвучку."
    );
  }

  if (state.dubSearching) {
    throw new Error(
      "Поиск озвучек ещё не завершён."
    );
  }

  const anime = state.animeWinner;
  const winner = chooseDubWinner();

  if (!anime) {
    throw new Error("Аниме для голосования потеряно.");
  }

  if (!winner) {
    throw new Error(
      "Нет доступных Kodik-озвучек. Нажми «Повторить поиск»."
    );
  }

  await startAnime(
    anime.title,
    winner.link,
    {
      dubTitle: winner.title,
      animeKey: anime.key,
    }
  );

  return winner;
}


async function stopSession() {
  playbackReports.clear();
  state = defaultState();
  saveState();
  broadcastState();
  await syncVoiceStatus();
}

function chooseVotingWinner() {
  if (!state.suggestions.length) return null;

  const counts = new Map();

  for (const item of state.suggestions) counts.set(item.id, 0);

  for (const suggestionId of Object.values(state.votes)) {
    counts.set(suggestionId, (counts.get(suggestionId) || 0) + 1);
  }

  return [...state.suggestions].sort((a, b) => {
    const voteDiff = (counts.get(b.id) || 0) - (counts.get(a.id) || 0);
    if (voteDiff !== 0) return voteDiff;
    return Number(a.createdAt) - Number(b.createdAt);
  })[0];
}

async function finishVoting({ extendIfEmpty = true } = {}) {
  if (state.phase !== "VOTING") {
    throw new Error("Сейчас голосование не идёт.");
  }

  const winner = chooseVotingWinner();

  if (!winner) {
    if (!extendIfEmpty) {
      throw new Error("Пока никто не предложил фильм.");
    }

    // Automatic timeout with zero proposals: give another 10 minutes.
    state.voteEndsAt = Date.now() + VOTING_DURATION_SECONDS * 1000;
    saveState();
    broadcastState();
    return null;
  }

  if (winner.kind === "ANIME") {
    await startDubVoting(winner);
    return winner;
  }

  await startMovie(winner.title, winner.url);
  return winner;
}

function commandDefinition() {
  return new SlashCommandBuilder()
    .setName("movie")
    .setDescription("Управление Movie Night")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Запустить фильм")
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Название фильма")
            .setRequired(true)
            .setMaxLength(100)
        )
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("Ссылка VK Видео")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("pause").setDescription("Поставить фильм на паузу")
    )
    .addSubcommand((sub) =>
      sub.setName("resume").setDescription("Продолжить фильм")
    )
    .addSubcommand((sub) =>
      sub
        .setName("seek")
        .setDescription("Перемотать фильм")
        .addStringOption((opt) =>
          opt
            .setName("time")
            .setDescription("Например: 1:25:30, 25:30 или 90")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("skip").setDescription("Завершить фильм и начать голосование")
    )
    .addSubcommand((sub) =>
      sub
        .setName("skipvote")
        .setDescription("Закончить голосование сейчас и запустить лидера")
    )
    .addSubcommand((sub) =>
      sub.setName("voting").setDescription("Принудительно открыть голосование")
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("Полностью остановить Movie Night")
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Показать состояние Movie Night")
    );
}

function animeCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("anime")
    .setDescription("Совместный просмотр аниме через Kodik")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Запустить аниме через Kodik")
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Название аниме / серии")
            .setRequired(true)
            .setMaxLength(100)
        )
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("Ссылка Kodik Player (kodik.info)")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("pause").setDescription("Поставить аниме на паузу")
    )
    .addSubcommand((sub) =>
      sub.setName("resume").setDescription("Продолжить аниме")
    )
    .addSubcommand((sub) =>
      sub
        .setName("seek")
        .setDescription("Перемотать аниме у всех")
        .addStringOption((opt) =>
          opt
            .setName("time")
            .setDescription("Например: 12:30 или 750")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("Остановить просмотр аниме")
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Показать состояние anime-сессии")
    );
}

async function registerMovieCommand() {
  const guild = await bot.guilds.fetch(GUILD_ID);
  const commands = await guild.commands.fetch();

  for (const definition of [
    commandDefinition(),
    animeCommandDefinition(),
  ]) {
    const body = definition.toJSON();
    const existing = commands.find(
      (command) => command.name === body.name
    );

    if (existing) {
      await guild.commands.edit(existing.id, body);
      console.log(`✅ /${body.name} обновлена`);
    } else {
      await guild.commands.create(body);
      console.log(`✅ /${body.name} зарегистрирована`);
    }
  }
}

app.post("/api/token", async (req, res) => {
  try {
    const code = String(req.body?.code || "");

    if (!code) {
      return res.status(400).json({ error: "Нет OAuth code." });
    }

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });

    const json = await response.json().catch(() => ({}));

    if (!response.ok || !json.access_token) {
      console.error("OAuth exchange failed:", response.status, json);
      return res.status(502).json({
        error: "Discord OAuth exchange не удался.",
      });
    }

    res.json({
      access_token: json.access_token,
    });
  } catch (error) {
    console.error("/api/token:", error);
    res.status(500).json({ error: "OAuth server error." });
  }
});

async function getDiscordUserFromBearer(accessToken) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Bearer user check HTTP ${response.status}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActivityInstance(instanceId) {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${CLIENT_ID}/activity-instances/${encodeURIComponent(instanceId)}`,
    {
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Activity Instance HTTP ${response.status}`);
  }

  return response.json();
}

async function getActivityInstanceForJoiningUser(instanceId, userId) {
  let lastInstance = null;
  let lastError = null;

  // A user can open an already-running Activity before Discord's REST
  // representation of the instance has caught up. Do not reject that user
  // on the first request. Give Discord a short window to expose the new
  // participant in the instance.
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const instance = await getActivityInstance(instanceId);
      lastInstance = instance;
      lastError = null;

      if (
        !Array.isArray(instance.users) ||
        instance.users.includes(userId)
      ) {
        if (attempt > 1) {
          console.log(
            `✅ Activity instance participant appeared after ${attempt} checks: ${userId}`
          );
        }

        return instance;
      }

      console.log(
        `⏳ Activity instance participant not visible yet (${attempt}/8): ${userId}`
      );
    } catch (error) {
      lastError = error;
      console.log(
        `⏳ Activity instance verification retry (${attempt}/8): ${error.message || error}`
      );
    }

    if (attempt < 8) {
      await sleep(750);
    }
  }

  // If we successfully fetched an instance, return it so the normal strict
  // validation below can produce the correct rejection reason.
  if (lastInstance) return lastInstance;

  throw lastError || new Error("Activity instance недоступен.");
}

io.use(async (socket, next) => {
  try {
    const accessToken = String(socket.handshake.auth?.accessToken || "");
    const instanceId = String(socket.handshake.auth?.instanceId || "");
    const guildId = String(socket.handshake.auth?.guildId || "");
    const channelId = String(socket.handshake.auth?.channelId || "");

    if (!accessToken || !instanceId) {
      throw new Error("Нет Activity auth.");
    }

    if (guildId !== GUILD_ID) {
      throw new Error("Неверный guild.");
    }

    if (channelId !== VOICE_CHANNEL_ID) {
      throw new Error("Activity должна быть открыта в настроенном войсе.");
    }

    const user = await getDiscordUserFromBearer(accessToken);

    const instance = await getActivityInstanceForJoiningUser(
      instanceId,
      user.id
    );

    if (instance.application_id !== CLIENT_ID) {
      throw new Error("Неверный application instance.");
    }

    if (
      instance.location?.guild_id &&
      instance.location.guild_id !== GUILD_ID
    ) {
      throw new Error("Неверный instance guild.");
    }

    if (
      instance.location?.channel_id &&
      instance.location.channel_id !== VOICE_CHANNEL_ID
    ) {
      throw new Error("Неверный instance channel.");
    }

    if (
      Array.isArray(instance.users) &&
      !instance.users.includes(user.id)
    ) {
      throw new Error("Пользователь не входит в Activity instance.");
    }

    socket.data.user = user;
    socket.data.instanceId = instanceId;

    next();
  } catch (error) {
    console.error("Socket auth denied:", error.message);
    next(
      new Error(
        `Activity session verification failed: ${error.message || "unknown"}`
      )
    );
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  console.log(`🟢 Activity: ${user.global_name || user.username} (${user.id})`);

  socket.emit("session:state", sanitizeStateFor(user.id));

  // NTP-like lightweight clock sync. Client measures RTT and computes
  // server clock offset from the midpoint of the request.
  socket.on("time:sync", (_payload = {}, ack = () => {}) => {
    ack({ serverNow: Date.now() });
  });

  socket.on("player:diagnostic", (report = {}) => {
    const stage = String(report.stage || "").slice(0, 80);
    const key = String(report.movieKey || "").slice(0, 100);
    const quality = Number(report.quality) || "-";
    const mode = String(report.mode || "-").slice(0, 60);
    const error = String(report.error || "").slice(0, 180);
    const readyState = Number.isFinite(Number(report.readyState))
      ? Number(report.readyState)
      : "-";
    const networkState = Number.isFinite(Number(report.networkState))
      ? Number(report.networkState)
      : "-";

    if (!stage) return;

    console.log(
      `🎞 PLAYER ${user.global_name || user.username} (${user.id}) ` +
      `stage=${stage} q=${quality} mode=${mode} ` +
      `ready=${readyState} network=${networkState}` +
      (error ? ` error="${error}"` : "")
    );
  });

  socket.on("playback:progress", (report = {}) => {
    if (!state.movie) return;

    const key = String(report.movieKey || "");
    if (key !== movieKey(state.movie)) return;

    const currentTime = Math.max(0, Number(report.currentTime) || 0);
    const duration = Number(report.duration);

    playbackReports.set(socket.id, {
      socketId: socket.id,
      userId: user.id,
      movieKey: key,
      currentTime,
      duration: Number.isFinite(duration) ? duration : null,
      ended: Boolean(report.ended),
      buffering: Boolean(report.buffering),
      loaded: Boolean(report.loaded),
      participating: report.participating === true,
      lateJoin: Boolean(report.lateJoin),
      lastReportAt: Date.now(),
    });
  });

  socket.on("movie:metadata", ({ movieKey: key, duration } = {}) => {
    if (!state.movie || !["WATCHING", "PAUSED"].includes(state.phase)) return;
    if (key !== movieKey(state.movie)) return;

    duration = Number(duration);

    if (!Number.isFinite(duration) || duration < 10 || duration > 12 * 3600) {
      return;
    }

    // First valid client establishes duration.
    if (!state.movie.duration) {
      state.movie.duration = duration;
      saveState();
      broadcastState();
      console.log(`⏱ Duration: ${formatTime(duration)}`);
    }
  });

  socket.on("movie:ended", ({ movieKey: key } = {}) => {
    if (!state.movie || key !== movieKey(state.movie)) return;

    const previous = playbackReports.get(socket.id) || {};

    playbackReports.set(socket.id, {
      ...previous,
      socketId: socket.id,
      userId: user.id,
      movieKey: key,
      currentTime: state.movie.duration || previous.currentTime || 0,
      duration: state.movie.duration || previous.duration || null,
      ended: true,
      buffering: false,
      loaded: true,
      participating: true,
      lastReportAt: Date.now(),
    });

    console.log(
      `🏁 ${user.global_name || user.username} дошёл до конца фильма.`
    );
  });

  socket.on("anime:search", async ({ query } = {}, ack = () => {}) => {
    try {
      if (state.phase !== "VOTING") {
        throw new Error(
          "Искать аниме можно во время общего голосования."
        );
      }

      if (
        state.suggestions.some(
          (item) => item.proposerUserId === user.id
        )
      ) {
        throw new Error(
          "Ты уже предложил вариант."
        );
      }

      const results = await searchAnimeTitles(query);

      const searchId = crypto.randomUUID();
      const items = new Map();

      for (const item of results) {
        items.set(item.key, item);
      }

      animeSearchCache.set(socket.id, {
        searchId,
        expiresAt: Date.now() + 5 * 60 * 1000,
        items,
      });

      ack({
        ok: true,
        searchId,
        results: results.map((item) => ({
          key: item.key,
          title: item.title,
          titleOrig: item.titleOrig,
          year: item.year,
          type: item.type,
          episodesCount: item.episodesCount,
          translationsCount: item.translationsCount,
        })),
      });
    } catch (error) {
      ack({
        ok: false,
        error: error?.message || String(error),
      });
    }
  });

  socket.on(
    "vote:suggest-anime",
    ({ searchId, resultKey } = {}, ack = () => {}) => {
      try {
        if (state.phase !== "VOTING") {
          throw new Error("Сейчас нет общего голосования.");
        }

        if (
          state.suggestions.some(
            (item) => item.proposerUserId === user.id
          )
        ) {
          throw new Error(
            "Можно предложить только один вариант."
          );
        }

        const cached = animeSearchCache.get(socket.id);

        if (
          !cached ||
          cached.searchId !== String(searchId || "") ||
          cached.expiresAt < Date.now()
        ) {
          throw new Error(
            "Результаты поиска устарели. Нажми «Найти» ещё раз."
          );
        }

        const anime = cached.items.get(
          String(resultKey || "")
        );

        if (!anime) {
          throw new Error(
            "Это аниме больше не найдено в текущем поиске."
          );
        }

        if (
          state.suggestions.some(
            (item) =>
              item.kind === "ANIME" &&
              item.animeKey === anime.key
          )
        ) {
          throw new Error(
            "Это аниме уже предложено."
          );
        }

        state.suggestions.push({
          id: crypto.randomUUID(),
          kind: "ANIME",
          title: anime.title,
          titleOrig: anime.titleOrig,
          year: anime.year,
          episodesCount: anime.episodesCount,
          animeType: anime.type,
          animeKey: anime.key,
          shikimoriId: anime.shikimoriId,
          kinopoiskId: anime.kinopoiskId,
          proposerUserId: user.id,
          proposerName:
            user.global_name || user.username,
          createdAt: Date.now(),
        });

        animeSearchCache.delete(socket.id);

        saveState();
        broadcastState();
        ack({ ok: true });
      } catch (error) {
        ack({
          ok: false,
          error: error?.message || String(error),
        });
      }
    }
  );

  socket.on("vote:suggest", async ({ title, url } = {}, ack = () => {}) => {
    try {
      if (state.phase !== "VOTING") {
        throw new Error("Сейчас нет голосования.");
      }

      title = String(title || "").trim().slice(0, 100);
      url = String(url || "").trim();

      if (title.length < 1) {
        throw new Error("Укажи название.");
      }

      const parsed = parseVk(url);

      if (!parsed) {
        throw new Error("Нужна корректная ссылка VK Видео.");
      }

      if (
        state.suggestions.some((item) => item.proposerUserId === user.id)
      ) {
        throw new Error("Можно предложить только один фильм.");
      }

      if (
        state.suggestions.some(
          (item) => item.oid === parsed.oid && item.videoId === parsed.id
        )
      ) {
        throw new Error("Этот VK-фильм уже предложен.");
      }

      state.suggestions.push({
        id: crypto.randomUUID(),
        kind: "MOVIE",
        title,
        url,
        oid: parsed.oid,
        videoId: parsed.id,
        hash: parsed.hash,
        proposerUserId: user.id,
        proposerName: user.global_name || user.username,
        createdAt: Date.now(),
      });

      saveState();
      broadcastState();
      ack({ ok: true });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on("vote:cast", ({ suggestionId } = {}, ack = () => {}) => {
    try {
      if (state.phase !== "VOTING") {
        throw new Error("Сейчас нет голосования.");
      }

      suggestionId = String(suggestionId || "");

      if (!state.suggestions.some((item) => item.id === suggestionId)) {
        throw new Error("Такого варианта больше нет.");
      }

      state.votes[user.id] = suggestionId;
      saveState();
      broadcastState();
      ack({ ok: true });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });


  socket.on(
    "anime:refresh-dubs",
    async (_payload = {}, ack = () => {}) => {
      try {
        if (state.phase !== "DUB_VOTING") {
          throw new Error(
            "Сейчас нет голосования за озвучку."
          );
        }

        if (state.dubSearching) {
          throw new Error(
            "Поиск озвучек уже выполняется."
          );
        }

        ack({ ok: true, started: true });

        await populateDubOptions({
          isRetry: true,
        });
      } catch (error) {
        ack({
          ok: false,
          error: error?.message || String(error),
        });
      }
    }
  );

  socket.on(
    "vote:dub-cast",
    ({ optionId } = {}, ack = () => {}) => {
      try {
        if (state.phase !== "DUB_VOTING") {
          throw new Error(
            "Сейчас нет голосования за озвучку."
          );
        }

        optionId = String(optionId || "");

        if (
          !state.dubOptions.some(
            (item) => item.id === optionId
          )
        ) {
          throw new Error(
            "Такой озвучки больше нет."
          );
        }

        state.dubVotes[user.id] = optionId;

        saveState();
        broadcastState();
        ack({ ok: true });
      } catch (error) {
        ack({
          ok: false,
          error: error?.message || String(error),
        });
      }
    }
  );

  socket.on("disconnect", () => {
    playbackReports.delete(socket.id);
    animeSearchCache.delete(socket.id);
    console.log(
      `🔴 Activity ушёл: ${user.global_name || user.username} (${user.id})`
    );
  });
});

bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (
    interaction.commandName !== "movie" &&
    interaction.commandName !== "anime"
  ) {
    return;
  }

  const sub = interaction.options.getSubcommand();
  const isAnimeCommand = interaction.commandName === "anime";

  // status is readable by everyone.
  if (sub !== "status" && !hasControlRole(interaction)) {
    await deny(interaction);
    return;
  }

  // Discord invalidates an interaction if it does not receive an initial
  // response within 3 seconds. Some Movie Night operations (especially
  // anime winner -> automatic dub discovery) can take much longer, so ACK
  // every authorized slash command immediately and edit the response later.
  try {
    await interaction.deferReply({
          });
  } catch (error) {
    console.error(
      "Command defer failed:",
      error?.message || error
    );
    return;
  }

  try {
    if (isAnimeCommand) {
      if (sub === "start") {
        const title = interaction.options.getString("title", true);
        const url = interaction.options.getString("url", true);

        await startAnime(title, url);

        await interaction.editReply({
          content:
            `🍥 **${title}** загружается через Kodik. ` +
            `Общий старт через **${formatTime(MOVIE_PRELOAD_SECONDS)}**.`,
                  });
        return;
      }

      if (sub === "pause") {
        await pauseMovie();

        await interaction.editReply({
          content: `⏸ Аниме на паузе: ${formatTime(state.positionSeconds)}`,
                  });
        return;
      }

      if (sub === "resume") {
        await resumeMovie();

        await interaction.editReply({
          content: "▶ Просмотр аниме продолжен.",
                  });
        return;
      }

      if (sub === "seek") {
        const raw = interaction.options.getString("time", true);
        const seconds = parseTime(raw);

        if (seconds == null) {
          throw new Error(
            "Формат времени: 12:30, 1:02:30 или число секунд."
          );
        }

        await seekMovie(seconds);

        await interaction.editReply({
          content: `⏩ Аниме перемотано на ${formatTime(seconds)}`,
                  });
        return;
      }

      if (sub === "stop") {
        await stopSession();

        await interaction.editReply({
          content: "⏹ Anime-сессия остановлена.",
                  });
        return;
      }

      if (sub === "status") {
        if (state.movie?.source !== "KODIK") {
          await interaction.editReply({
            content: "Сейчас Kodik-аниме не запущено.",
                      });
          return;
        }

        const pos = currentPosition();
        const duration = state.movie?.duration;

        await interaction.editReply({
          content:
            `🍥 **${state.movie?.title || "Аниме"}**\n` +
            `${state.phase === "PAUSED" ? "⏸" : "▶"} ` +
            `${formatTime(pos)}` +
            `${duration ? ` / ${formatTime(duration)}` : ""}`,
                  });
        return;
      }

      return;
    }

    if (sub === "start") {
      const title = interaction.options.getString("title", true);
      const url = interaction.options.getString("url", true);

      await startMovie(title, url);

      await interaction.editReply({
        content:
          `⏳ **${title}** загружается у всех. ` +
          `Автостарт через **${formatTime(MOVIE_PRELOAD_SECONDS)}**.`,
              });
      return;
    }

    if (sub === "pause") {
      await pauseMovie();

      await interaction.editReply({
        content: `⏸ Пауза на ${formatTime(state.positionSeconds)}`,
              });
      return;
    }

    if (sub === "resume") {
      await resumeMovie();

      await interaction.editReply({
        content: "▶ Просмотр продолжен.",
              });
      return;
    }

    if (sub === "seek") {
      const raw = interaction.options.getString("time", true);
      const seconds = parseTime(raw);

      if (seconds == null) {
        throw new Error("Формат времени: 1:25:30, 25:30 или число секунд.");
      }

      await seekMovie(seconds);

      await interaction.editReply({
        content: `⏩ Перемотано на ${formatTime(seconds)}`,
              });
      return;
    }

    if (sub === "skipvote") {
      if (state.phase === "DUB_VOTING") {
        const dub = await finishDubVoting();

        await interaction.editReply({
          content:
            `🎙 Выбрана озвучка **${dub.title}**. ` +
            `Предзагрузка ${formatTime(MOVIE_PRELOAD_SECONDS)}, ` +
            `затем общий старт.`,
                  });
        return;
      }

      const winner = await finishVoting({
        extendIfEmpty: false,
      });

      if (!winner) {
        throw new Error(
          "Не удалось завершить голосование."
        );
      }

      await interaction.editReply({
        content:
          winner.kind === "ANIME"
            ? `🍥 **${winner.title}** выбрано. Теперь голосуем за озвучку.`
            : `⏭ Голосование завершено. **${winner.title}** выбран. ` +
              `Предзагрузка ${formatTime(MOVIE_PRELOAD_SECONDS)}, затем общий старт.`,
              });
      return;
    }

    if (sub === "skip" || sub === "voting") {
      await startVoting();

      await interaction.editReply({
        content: `🗳 Голосование открыто на ${Math.floor(
          VOTING_DURATION_SECONDS / 60
        )} мин.`,
              });
      return;
    }

    if (sub === "stop") {
      await stopSession();

      await interaction.editReply({
        content: "⏹ Movie Night остановлен.",
              });
      return;
    }

    if (sub === "status") {
      if (state.phase === "IDLE") {
        await interaction.editReply({
          content: "Movie Night сейчас не запущен.",
                  });
        return;
      }

      if (state.phase === "VOTING") {
        const left = Math.max(
          0,
          Math.ceil((state.voteEndsAt - Date.now()) / 1000)
        );

        await interaction.editReply({
          content:
            `🗳 Идёт голосование\n` +
            `Вариантов: **${state.suggestions.length}**\n` +
            `Осталось: **${formatTime(left)}**`,
                  });
        return;
      }

      if (state.phase === "DUB_VOTING") {
        const left = Math.max(
          0,
          Math.ceil(
            (state.dubVoteEndsAt - Date.now()) / 1000
          )
        );

        await interaction.editReply({
          content:
            `🎙 Голосуем за озвучку **${
              state.animeWinner?.title || "аниме"
            }**\n` +
            `Озвучек: **${state.dubOptions.length}**\n` +
            `Осталось: **${formatTime(left)}**`,
                  });
        return;
      }

      const pos = currentPosition();
      const duration = state.movie?.duration;

      if (state.phase === "PAUSED" && state.autoStartAt) {
        const left = Math.max(
          0,
          Math.ceil((state.autoStartAt - Date.now()) / 1000)
        );

        await interaction.editReply({
          content:
            `⏳ **${state.movie?.title || "Фильм"}**\n` +
            `Предзагрузка у зрителей\n` +
            `Общий старт через: **${formatTime(left)}**\n` +
            `Позиция старта: **0:00**`,
                  });
        return;
      }

      await interaction.editReply({
        content:
          `🎬 **${state.movie?.title || "Фильм"}**\n` +
          `${state.phase === "PAUSED" ? "⏸" : "▶"} ` +
          `${formatTime(pos)}` +
          `${duration ? ` / ${formatTime(duration)}` : ""}`,
              });
    }
  } catch (error) {
    console.error("Command error:", error);

    const payload = {
      content: `Ошибка: ${error.message}`,
          };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: payload.content,
      }).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

bot.once("clientReady", async () => {
  console.log(`🤖 Вошёл как ${bot.user.tag}`);

  try {
    await registerMovieCommand();
  } catch (error) {
    console.error("registerMovieCommand:", error);
  }

  try {
    await joinConfiguredVoice();
  } catch (error) {
    console.error("joinConfiguredVoice:", error);
  }

  // Fresh/idle startup should never leave Activity on a useless black screen.
  // If a movie/vote was persisted, that state is preserved instead.
  if (state.phase === "IDLE") {
    console.log("🗳 Нет активной сессии — автоматически открываю голосование.");
    await startVoting();
  } else {
    await syncVoiceStatus();
    broadcastState();
  }
});

// Keep the bot physically present in the configured voice channel.
setInterval(async () => {
  if (!bot.isReady()) return;

  if (!botIsPresentInConfiguredVoice()) {
    await ensureVoiceConnection();
  }
}, 30_000);

// Re-assert the authoritative voice status.
// If a moderator/user manually changes the channel status, Movie Night restores it.
// 10 seconds keeps it responsive without hammering Discord's REST endpoint.
let voiceStatusSyncBusy = false;
setInterval(async () => {
  if (!bot.isReady() || voiceStatusSyncBusy) return;

  voiceStatusSyncBusy = true;
  try {
    await syncVoiceStatus();
  } catch (error) {
    console.error("voice status enforcement:", error);
  } finally {
    voiceStatusSyncBusy = false;
  }
}, 10_000);

setInterval(async () => {
  try {
    if (
      state.phase === "PAUSED" &&
      state.movie &&
      state.autoStartAt &&
      Date.now() >= state.autoStartAt
    ) {
      const scheduledStartAt = Number(state.autoStartAt);

      state.phase = "WATCHING";
      state.positionSeconds = 0;
      // Preserve the exact scheduled start timestamp. This prevents the
      // backend interval delay from shifting the authoritative timeline.
      state.startedAt = scheduledStartAt;
      state.autoStartAt = null;

      console.log(
        `▶ Общий автостарт: ${state.movie.title} @ ${new Date(scheduledStartAt).toISOString()}`
      );

      saveState();
      broadcastState();
      await syncVoiceStatus();
      return;
    }

    if (
      state.phase === "WATCHING" &&
      state.movie?.duration &&
      currentPosition() >= state.movie.duration
    ) {
      if (allActiveViewersFinished()) {
        console.log("🏁 Все активные зрители дошли до конца.");
        await startVoting();
        return;
      }

      const now = Date.now();

      if (now - lastWaitingForViewersLogAt >= 10_000) {
        lastWaitingForViewersLogAt = now;

        const reports = activePlaybackReportsForCurrentMovie();
        const unfinished = reports.filter(
          (report) =>
            !report.ended &&
            Number(report.currentTime || 0) <
              Math.max(0, state.movie.duration - 1.25)
        );

        console.log(
          `⏳ Серверный таймер дошёл до конца, ждём зрителей: ${unfinished.length}`
        );
      }

      return;
    }

    if (
      state.phase === "VOTING" &&
      state.voteEndsAt &&
      Date.now() >= state.voteEndsAt
    ) {
      await finishVoting({ extendIfEmpty: true });
      return;
    }

    if (
      state.phase === "DUB_VOTING" &&
      state.dubVoteEndsAt &&
      Date.now() >= state.dubVoteEndsAt
    ) {
      await finishDubVoting();
      return;
    }

    // Authoritative resync packet.
    if (state.phase === "WATCHING" || state.phase === "PAUSED") {
      broadcastState();
    }
  } catch (error) {
    console.error("session tick:", error);
  }
}, 2000);

// Discord Activity uses the root path. In production, return index.html for
// ordinary GET navigation while leaving /api and /socket.io untouched.
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    fs.existsSync(path.join(DIST_DIR, "index.html")) &&
    !req.path.startsWith("/api/") &&
    !req.path.startsWith("/socket.io")
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    return res.sendFile(path.join(DIST_DIR, "index.html"));
  }

  next();
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Movie Night: 0.0.0.0:${PORT}`);
  console.log(`💾 State: ${STATE_FILE}`);
});

bot.login(BOT_TOKEN);
