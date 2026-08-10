import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

const EPISODE_VOTING_DURATION_SECONDS = Math.max(
  10,
  Number(process.env.EPISODE_VOTING_DURATION_SECONDS) || 30
);

const NEXT_EPISODE_VOTING_DURATION_SECONDS = 15;

// V9.30: OP/ED use real per-episode intervals instead of a fixed +90 sec.
const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const ANISKIP_API_BASE_URL = "https://api.aniskip.com/v2";

const KODIK_API_KEY = String(process.env.KODIK_API_KEY || "").trim();

const KODIK_API_BASE_URL = String(
  process.env.KODIK_API_BASE_URL || "https://kodikapi.com"
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
const REQUIRED_CLIENT_BUILD = "9.33";

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.BROWSER_PUBLIC_URL ||
  ""
)
  .trim()
  .replace(/\/+$/, "");

const BROWSER_TICKET_TTL_MS = 60_000;
const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

  episodeVoteEndsAt: null,
  episodeNumbers: [],
  episodeVotes: {},
  selectedDub: null,

  nextEpisodeVoteEndsAt: null,
  nextEpisodeVotes: {},

  skipVotes: { OP: {}, ED: {} },

  notice: null,
  lastUpdatedAt: Date.now(),
});

function normalizeState(raw) {
  const base = defaultState();
  const state = { ...base, ...(raw || {}) };

  if (
    ![
      "IDLE",
      "WATCHING",
      "PAUSED",
      "VOTING",
      "DUB_VOTING",
      "EPISODE_VOTING",
      "NEXT_EPISODE_VOTING",
    ].includes(state.phase)
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

  if (!Array.isArray(state.episodeNumbers)) state.episodeNumbers = [];
  if (!state.episodeVotes || typeof state.episodeVotes !== "object") {
    state.episodeVotes = {};
  }
  if (!state.nextEpisodeVotes || typeof state.nextEpisodeVotes !== "object") {
    state.nextEpisodeVotes = {};
  }
  if (!state.skipVotes || typeof state.skipVotes !== "object") {
    state.skipVotes = { OP: {}, ED: {} };
  }
  if (!state.skipVotes.OP || typeof state.skipVotes.OP !== "object") {
    state.skipVotes.OP = {};
  }
  if (!state.skipVotes.ED || typeof state.skipVotes.ED !== "object") {
    state.skipVotes.ED = {};
  }
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

const browserTickets = new Map();
const browserSessions = new Map();

function cleanupBrowserAuth() {
  const now = Date.now();

  for (const [token, item] of browserTickets) {
    if (!item || item.expiresAt <= now) {
      browserTickets.delete(token);
    }
  }

  for (const [token, item] of browserSessions) {
    if (!item || item.expiresAt <= now) {
      browserSessions.delete(token);
    }
  }
}

function createOpaqueBrowserToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function browserPublicBaseUrl(socket = null) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  // Best-effort fallback for hosts that preserve their own public hostname.
  const headers = socket?.handshake?.headers || {};
  const forwardedHost = String(
    headers["x-forwarded-host"] ||
    headers.host ||
    ""
  )
    .split(",")[0]
    .trim();

  const forwardedProto = String(
    headers["x-forwarded-proto"] || "https"
  )
    .split(",")[0]
    .trim();

  if (
    forwardedHost &&
    !/discord(?:says)?\.com$/i.test(forwardedHost) &&
    !/discord(?:says)?\.com:/i.test(forwardedHost)
  ) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  return "";
}

function isPhoneUserAgent(value) {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(
    String(value || "")
  );
}

function browserSocketsForUser(userId) {
  return [...io.sockets.sockets.values()].filter(
    (candidate) =>
      candidate.data.sessionKind === "browser" &&
      candidate.data.user?.id === userId
  );
}

function activitySocketsForUser(userId) {
  return [...io.sockets.sockets.values()].filter(
    (candidate) =>
      candidate.data.sessionKind === "activity" &&
      candidate.data.user?.id === userId
  );
}

function notifyBrowserPresence(userId, active) {
  for (const activitySocket of activitySocketsForUser(userId)) {
    activitySocket.emit("browser:presence", {
      active: Boolean(active),
    });
  }
}

const animeMalIdCache = new Map();
const animeSkipTimesCache = new Map();

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

  let stdout = "";

  try {
    const result = await runExecFile(
      "python3",
      [
        path.join(ROOT, "anime_sources.py"),
        "--mode",
        "search",
        "--query",
        queryText,
      ],
      {
        cwd: ROOT,
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      }
    );

    stdout = result.stdout;
  } catch (error) {
    stdout = String(error?.stdout || "");

    if (!stdout.trim()) {
      throw new Error(
        `AnimeGo поиск не запустился: ${error?.message || error}`
      );
    }
  }

  let data;

  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error("AnimeGo вернул некорректный ответ поиска.");
  }

  if (!data?.ok || !Array.isArray(data.results)) {
    throw new Error(data?.error || "AnimeGo ничего не нашёл.");
  }

  return data.results.slice(0, 10).map((item) => ({
    key: `animego:${crypto.randomUUID()}`,
    title: String(item.title || "Аниме").slice(0, 120),
    titleOrig: "",
    animeUrl: String(item.url || ""),
    thumbnail: String(item.thumbnail || ""),
    year: null,
    type: "anime-serial",
    episodesCount: null,
    translationsCount: null,
  }));
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

function connectedActivityUserIds() {
  const ids = new Set();

  if (typeof io === "undefined") return ids;

  for (const socket of io.sockets.sockets.values()) {
    const userId = socket.data.user?.id;
    if (userId) ids.add(userId);
  }

  return ids;
}

function skipMajorityThreshold() {
  const viewers = connectedActivityUserIds().size;
  return Math.max(1, Math.floor(viewers / 2) + 1);
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
  for (const option of state.dubOptions) dubCounts.set(option.id, 0);
  for (const optionId of Object.values(state.dubVotes)) {
    dubCounts.set(optionId, (dubCounts.get(optionId) || 0) + 1);
  }

  const dubOptions = state.dubOptions.map((item) => ({
    id: item.id,
    title: item.title,
    translationType: item.translationType,
    provider: item.provider || "Kodik",
    episode: Number(item.episode) || 1,
    votes: dubCounts.get(item.id) || 0,
  }));

  const episodeCounts = new Map();
  for (const episode of state.episodeNumbers) {
    episodeCounts.set(Number(episode), 0);
  }
  for (const episode of Object.values(state.episodeVotes)) {
    const value = Number(episode);
    episodeCounts.set(value, (episodeCounts.get(value) || 0) + 1);
  }

  const mySuggestion = state.suggestions.find(
    (item) => item.proposerUserId === userId
  );

  const opVotes = Object.keys(state.skipVotes?.OP || {}).length;
  const edVotes = Object.keys(state.skipVotes?.ED || {}).length;
  const majority = skipMajorityThreshold();

  const nextVotes = {
    NEXT: Object.values(state.nextEpisodeVotes || {}).filter(
      (value) => value === "NEXT"
    ).length,
    OTHER: Object.values(state.nextEpisodeVotes || {}).filter(
      (value) => value === "OTHER"
    ).length,
  };

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
          episodesCount: state.animeWinner.episodesCount || null,
        }
      : null,
    dubOptions,
    myDubVote: state.dubVotes[userId] || null,
    dubSearching: Boolean(state.dubSearching),

    episodeVoteEndsAt: state.episodeVoteEndsAt,
    episodeNumbers: state.episodeNumbers,
    episodeVoteCounts: [...episodeCounts.entries()].map(
      ([episode, votes]) => ({ episode, votes })
    ),
    myEpisodeVote: Number(state.episodeVotes[userId]) || null,
    selectedDub: state.selectedDub
      ? { title: state.selectedDub.title }
      : null,

    nextEpisodeVoteEndsAt: state.nextEpisodeVoteEndsAt,
    nextEpisodeVotes: nextVotes,
    myNextEpisodeVote: state.nextEpisodeVotes[userId] || null,

    skipVote: state.movie?.source === "KODIK"
      ? {
          threshold: majority,
          viewers: connectedActivityUserIds().size,
          opVotes,
          edVotes,
          myOp: Boolean(state.skipVotes?.OP?.[userId]),
          myEd: Boolean(state.skipVotes?.ED?.[userId]),
          segments: {
            OP: getAnimeSkipSegment("OP"),
            ED: getAnimeSkipSegment("ED"),
          },
        }
      : null,

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


const ANIME_HLS_SECRET = randomBytes(32);

function isValidKodikPlayerUrl(raw) {
  let url;

  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = String(url.hostname || "").toLowerCase();

  if (
    host !== "kodikplayer.com" &&
    host !== "kodik.info"
  ) {
    return false;
  }

  return /^\/(?:seria|serial|season|video|film|episode|uv)\/\d+\/[A-Za-z0-9_-]+\/\d{3,4}p\/?$/i
    .test(url.pathname);
}

function animeRelaySignature(url, referer) {
  return createHmac("sha256", ANIME_HLS_SECRET)
    .update(String(url))
    .update("\n")
    .update(String(referer || ""))
    .digest("base64url");
}

function createAnimeRelayUrl(url, referer) {
  const encodedUrl = Buffer
    .from(String(url), "utf8")
    .toString("base64url");

  const encodedReferer = Buffer
    .from(String(referer || ""), "utf8")
    .toString("base64url");

  const sig = animeRelaySignature(url, referer);

  return (
    `/api/anime-hls?u=${encodeURIComponent(encodedUrl)}` +
    `&r=${encodeURIComponent(encodedReferer)}` +
    `&s=${encodeURIComponent(sig)}`
  );
}

function verifyAnimeRelayUrl(encodedUrl, encodedReferer, signature) {
  let url;
  let referer;

  try {
    url = Buffer
      .from(String(encodedUrl || ""), "base64url")
      .toString("utf8");

    referer = Buffer
      .from(String(encodedReferer || ""), "base64url")
      .toString("utf8");
  } catch {
    return null;
  }

  const expected = Buffer.from(
    animeRelaySignature(url, referer),
    "utf8"
  );

  const actual = Buffer.from(
    String(signature || ""),
    "utf8"
  );

  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  const host = String(parsed.hostname || "").toLowerCase();

  // Signed URLs are generated only by our resolver/manifest rewriter.
  // Still reject obvious local/private targets.
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return null;
  }

  return {
    url: parsed.toString(),
    referer,
  };
}

function absoluteHlsUrl(value, baseUrl) {
  try {
    return new URL(String(value || ""), baseUrl).toString();
  } catch {
    return null;
  }
}

function rewriteHlsManifest(text, baseUrl, referer) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return line;
      }

      if (!trimmed.startsWith("#")) {
        const absolute = absoluteHlsUrl(trimmed, baseUrl);

        return absolute
          ? createAnimeRelayUrl(absolute, referer)
          : line;
      }

      // EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, I-FRAME playlists, etc.
      return line.replace(
        /URI=(?:"([^"]+)"|([^,]+))/gi,
        (match, quoted, bare) => {
          const value = quoted || bare;
          const absolute = absoluteHlsUrl(value, baseUrl);

          if (!absolute) return match;

          return `URI="${createAnimeRelayUrl(
            absolute,
            referer
          )}"`;
        }
      );
    })
    .join("\n");
}


async function probeKodikHlsCandidate(candidate, playerUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 12_000);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Safari/537.36",
    "Accept":
      "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    "Accept-Encoding": "identity",
    "Referer": playerUrl,
  };

  try {
    headers.Origin = new URL(playerUrl).origin;
  } catch {}

  try {
    const response = await fetch(String(candidate.url), {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers,
      signal: controller.signal,
    });

    const status = response.status;

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {}

      return {
        ok: false,
        status,
        reason: `HTTP ${status}`,
      };
    }

    // A CDN may return HTTP 200 with an HTML error page. Verify that the
    // candidate is actually an HLS manifest before handing it to hls.js.
    const text = await response.text();
    const manifestOk = /^\s*#EXTM3U/m.test(text);

    return {
      ok: manifestOk,
      status,
      reason: manifestOk
        ? "manifest"
        : "response is not #EXTM3U",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason:
        error?.name === "AbortError"
          ? "timeout"
          : error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/kodik-stream", async (req, res) => {
  const playerUrl = String(req.query.url || "");

  if (!isValidKodikPlayerUrl(playerUrl)) {
    res.status(400).json({
      error: "Invalid Kodik player URL",
    });
    return;
  }

  console.log(
    `🍥 KODIK HLS resolve: ${playerUrl.slice(0, 140)}`
  );

  try {
    let stdout = "";

    try {
      const result = await runExecFile(
        "python3",
        [
          path.join(ROOT, "anime_stream.py"),
          "--url",
          playerUrl,
        ],
        {
          cwd: ROOT,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
          },
        }
      );

      stdout = result.stdout;
    } catch (error) {
      stdout = String(error?.stdout || "");

      if (!stdout.trim()) {
        throw error;
      }
    }

    const data = JSON.parse(stdout.trim());

    if (!data?.ok || !Array.isArray(data.videos)) {
      throw new Error(
        data?.error || "Kodik HLS resolver returned no streams"
      );
    }

    const videos = data.videos
      .filter((item) => {
        try {
          const url = new URL(String(item?.url || ""));
          return url.protocol === "https:";
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          Number(b?.quality || 0) -
          Number(a?.quality || 0)
      );

    if (!videos.length) {
      throw new Error("Kodik HLS resolver returned no HTTPS streams");
    }

    let best = null;
    const probeResults = [];

    for (const candidate of videos) {
      const probe = await probeKodikHlsCandidate(
        candidate,
        playerUrl
      );

      const quality = Number(candidate.quality) || 0;

      probeResults.push({
        quality,
        status: probe.status,
        ok: probe.ok,
        reason: probe.reason,
      });

      console.log(
        `🔎 KODIK HLS probe ${quality || "?"}p -> ` +
        `${probe.status || "-"} ${probe.ok ? "OK" : probe.reason}`
      );

      if (probe.ok) {
        best = candidate;
        break;
      }
    }

    if (!best) {
      throw new Error(
        "Kodik CDN не вернул ни одного рабочего HLS " +
        `(${probeResults
          .map(
            (item) =>
              `${item.quality || "?"}p:${item.status || item.reason}`
          )
          .join(", ")})`
      );
    }

    const proxied = createAnimeRelayUrl(
      best.url,
      playerUrl
    );

    console.log(
      `✅ KODIK HLS: ${Number(best.quality) || "?"}p ` +
      `host=${new URL(best.url).hostname}`
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    res.json({
      ok: true,
      quality: Number(best.quality) || null,
      type: String(best.type || "m3u8"),
      url: proxied,
      available: videos.map((item) => ({
        quality: Number(item.quality) || null,
      })),
      probes: probeResults,
    });
  } catch (error) {
    console.error(
      "❌ /api/kodik-stream:",
      error?.message || error
    );

    res.status(502).json({
      error:
        error?.message ||
        "Kodik HLS resolve failed",
    });
  }
});

app.get("/api/anime-hls", async (req, res) => {
  const verified = verifyAnimeRelayUrl(
    req.query.u,
    req.query.r,
    req.query.s
  );

  if (!verified) {
    res.status(403).send("Invalid anime relay URL");
    return;
  }

  const controller = new AbortController();

  req.on("aborted", () => {
    try {
      controller.abort();
    } catch {}
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      try {
        controller.abort();
      } catch {}
    }
  });

  let upstreamUrl;

  try {
    upstreamUrl = new URL(verified.url);
  } catch {
    res.status(400).send("Bad upstream URL");
    return;
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
  };

  if (verified.referer) {
    headers.Referer = verified.referer;

    try {
      headers.Origin =
        new URL(verified.referer).origin;
    } catch {}
  }

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers,
      signal: controller.signal,
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.warn(
        `⚠️ ANIME HLS upstream ${upstream.status} ` +
        `${upstreamUrl.hostname}${upstreamUrl.pathname}`
      );

      res
        .status(upstream.status)
        .send(`Anime media upstream HTTP ${upstream.status}`);

      return;
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const isManifest =
      /mpegurl|m3u8/i.test(contentType) ||
      /\.m3u8(?:$|\?)/i.test(upstreamUrl.toString());

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Movie-Night-Anime-Relay", "1");
    res.setHeader("X-Accel-Buffering", "no");

    if (isManifest) {
      const text = await upstream.text();

      const rewritten = rewriteHlsManifest(
        text,
        upstreamUrl.toString(),
        verified.referer
      );

      res.status(200);
      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );
      res.send(rewritten);
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

      if (value) {
        res.setHeader(name, value);
      }
    }

    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body)
      .on("error", (error) => {
        if (error?.name !== "AbortError") {
          console.error(
            "❌ Anime HLS relay stream:",
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
    if (error?.name === "AbortError") return;

    console.error(
      "❌ /api/anime-hls:",
      error?.message || error
    );

    if (!res.headersSent) {
      res.status(502).send("Anime HLS relay failed");
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
    if (state.movie?.source === "KODIK") {
      const episode = Number(state.movie?.episode) || 1;
      const total = Number(state.movie?.episodesCount) || null;
      const series = total ? `серия ${episode}/${total}` : `серия ${episode}`;
      return `Смотрим аниме: ${state.movie?.title || "аниме"} • ${series}`;
    }

    return `Смотрим: ${state.movie?.title || "видео"}`;
  }

  if (state.phase === "VOTING") return "Выбираем фильм или аниме";
  if (state.phase === "DUB_VOTING") {
    return `Выбираем озвучку: ${state.animeWinner?.title || "аниме"}`;
  }
  if (state.phase === "EPISODE_VOTING") {
    return `Выбираем серию: ${state.animeWinner?.title || "аниме"}`;
  }
  if (state.phase === "NEXT_EPISODE_VOTING") {
    return `Следующая серия? ${state.movie?.title || "аниме"}`;
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


function normalizeAnimeLookupText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function animeLookupTextScore(a, b) {
  const left = normalizeAnimeLookupText(a);
  const right = normalizeAnimeLookupText(b);

  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) {
    return 78;
  }

  const aWords = new Set(left.split(" "));
  const bWords = new Set(right.split(" "));
  const common = [...aWords].filter((word) => bWords.has(word)).length;
  return Math.round((common / Math.max(aWords.size, bWords.size, 1)) * 68);
}

async function fetchJsonTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAnimeMalId(meta = {}) {
  const direct = Number(meta.knownMalId);
  if (Number.isInteger(direct) && direct > 0) return direct;

  const key = [
    meta.animeUrl || "",
    meta.titleOrig || "",
    meta.title || "",
    Number(meta.episodesCount) || 0,
    Number(meta.year) || 0,
  ].join("|");

  if (animeMalIdCache.has(key)) return animeMalIdCache.get(key);

  const queryText = `
    query ($search: String) {
      Page(page: 1, perPage: 12) {
        media(search: $search, type: ANIME) {
          idMal
          episodes
          format
          seasonYear
          title { romaji english native }
          synonyms
        }
      }
    }
  `;

  const queries = [meta.titleOrig, meta.title]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, array) =>
      array.findIndex((other) => normalizeAnimeLookupText(other) === normalizeAnimeLookupText(value)) === index
    );

  const candidates = new Map();

  for (const query of queries) {
    try {
      const data = await fetchJsonTimeout(
        ANILIST_GRAPHQL_URL,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ query: queryText, variables: { search: query } }),
        },
        6500
      );

      for (const media of data?.data?.Page?.media || []) {
        const malId = Number(media?.idMal);
        if (Number.isInteger(malId) && malId > 0) candidates.set(malId, media);
      }
    } catch (error) {
      console.warn(`⚠️ AniList skip-id lookup "${query}":`, error?.message || error);
    }
  }

  let best = null;
  const expectedEpisodes = Number(meta.episodesCount) || 0;
  const expectedYear = Number(meta.year) || 0;

  for (const [malId, media] of candidates) {
    const titles = [
      media?.title?.romaji,
      media?.title?.english,
      media?.title?.native,
      ...(Array.isArray(media?.synonyms) ? media.synonyms : []),
    ].filter(Boolean);

    let titleScore = 0;
    for (const sourceTitle of [meta.titleOrig, meta.title]) {
      for (const candidateTitle of titles) {
        titleScore = Math.max(titleScore, animeLookupTextScore(sourceTitle, candidateTitle));
      }
    }

    let score = titleScore;
    const candidateEpisodes = Number(media?.episodes) || 0;
    const candidateYear = Number(media?.seasonYear) || 0;

    if (expectedEpisodes > 1 && media?.format === "MOVIE") score -= 120;
    if (expectedEpisodes && candidateEpisodes) {
      if (expectedEpisodes === candidateEpisodes) score += 45;
      else score -= Math.min(48, Math.abs(expectedEpisodes - candidateEpisodes) * 4);
    }
    if (expectedYear && candidateYear) {
      const yearDiff = Math.abs(expectedYear - candidateYear);
      if (yearDiff === 0) score += 18;
      else score -= Math.min(30, yearDiff * 12);
    }

    if (!best || score > best.score) best = { malId, score, titleScore };
  }

  // Wrong OP/ED timing is worse than having no button at all.
  const malId = best && best.titleScore >= 55 && best.score >= 62 ? best.malId : null;
  animeMalIdCache.set(key, malId);

  console.log(
    malId
      ? `⏭ AniSkip mapping: "${meta.titleOrig || meta.title}" -> MAL ${malId} score=${best.score}`
      : `⏭ AniSkip mapping: no safe MAL match for "${meta.titleOrig || meta.title}"`
  );

  return malId;
}

function normalizeSkipSegment(raw, kind) {
  const rawType = String(raw?.skipType || raw?.type || "").toLowerCase();
  const aliases = kind === "OP" ? new Set(["op", "mixed-op"]) : new Set(["ed", "mixed-ed"]);
  if (!aliases.has(rawType)) return null;

  const start = Number(raw?.interval?.startTime ?? raw?.startTime ?? raw?.start);
  const end = Number(raw?.interval?.endTime ?? raw?.endTime ?? raw?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 300) {
    return null;
  }
  return { start, end, type: rawType };
}

async function fetchAnimeSkipSegments(malId, episode, duration) {
  const normalizedDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
    ? Number(duration).toFixed(3)
    : "0";
  const cacheKey = `${malId}:${episode}:${normalizedDuration}`;
  if (animeSkipTimesCache.has(cacheKey)) return animeSkipTimesCache.get(cacheKey);

  const makeUrl = (episodeLength) =>
    `${ANISKIP_API_BASE_URL}/skip-times/${encodeURIComponent(malId)}/${encodeURIComponent(episode)}` +
    `?types=op&types=ed&types=mixed-op&types=mixed-ed&episodeLength=${encodeURIComponent(episodeLength)}`;

  let data = null;
  for (const episodeLength of [...new Set([normalizedDuration, "0"])]) {
    try {
      data = await fetchJsonTimeout(
        makeUrl(episodeLength),
        { cache: "no-store", headers: { "Accept": "application/json" } },
        6500
      );
      if (data?.found && Array.isArray(data?.results) && data.results.length) break;
    } catch (error) {
      if (Number(error?.status) !== 404) {
        console.warn(`⚠️ AniSkip MAL=${malId} ep=${episode}:`, error?.message || error);
      }
    }
  }

  const rows = Array.isArray(data?.results) ? data.results : [];
  const result = { OP: null, ED: null };

  for (const row of rows) {
    const op = normalizeSkipSegment(row, "OP");
    const ed = normalizeSkipSegment(row, "ED");
    if (op && !result.OP) result.OP = op;
    if (ed && !result.ED) result.ED = ed;
  }

  animeSkipTimesCache.set(cacheKey, result);
  console.log(
    `⏭ AniSkip MAL=${malId} ep=${episode}: ` +
    `OP=${result.OP ? `${result.OP.start.toFixed(2)}-${result.OP.end.toFixed(2)}` : "-"} ` +
    `ED=${result.ED ? `${result.ED.start.toFixed(2)}-${result.ED.end.toFixed(2)}` : "-"}`
  );
  return result;
}

async function ensureCurrentAnimeSkipSegments() {
  const movie = state.movie;
  if (!movie || movie.source !== "KODIK" || !movie.duration) return;
  if (movie.skipSegmentsStatus === "loading" || movie.skipSegmentsStatus === "ready") return;

  const key = movieKey(movie);
  movie.skipSegmentsStatus = "loading";
  saveState();

  try {
    const malId = await resolveAnimeMalId({
      knownMalId: movie.animeMalId,
      title: movie.title,
      titleOrig: movie.titleOrig,
      animeUrl: movie.animeUrl,
      episodesCount: movie.episodesCount,
      year: movie.animeYear,
    });

    if (!state.movie || movieKey(state.movie) !== key) return;

    if (!malId) {
      state.movie.skipSegments = { OP: null, ED: null };
      state.movie.skipSegmentsStatus = "ready";
      saveState();
      broadcastState();
      return;
    }

    const segments = await fetchAnimeSkipSegments(
      malId,
      Math.max(1, Number(state.movie.episode) || 1),
      Number(state.movie.duration)
    );

    if (!state.movie || movieKey(state.movie) !== key) return;

    state.movie.animeMalId = malId;
    state.movie.skipSegments = segments;
    state.movie.skipSegmentsStatus = "ready";
    state.skipVotes = { OP: {}, ED: {} };
    saveState();
    broadcastState();
  } catch (error) {
    if (!state.movie || movieKey(state.movie) !== key) return;
    state.movie.skipSegments = { OP: null, ED: null };
    state.movie.skipSegmentsStatus = "ready";
    saveState();
    broadcastState();
    console.warn("⚠️ OP/ED timing lookup:", error?.message || error);
  }
}

function getAnimeSkipSegment(kind) {
  if (state.movie?.source !== "KODIK") return null;
  const segment = state.movie?.skipSegments?.[String(kind || "").toUpperCase()];
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { start, end };
}

function animeSkipIsActive(kind, position = currentPosition()) {
  const segment = getAnimeSkipSegment(kind);
  if (!segment || !Number.isFinite(Number(position))) return false;
  position = Number(position);
  return position >= segment.start - 0.75 && position < segment.end - 0.15;
}

async function startAnime(title, rawUrl, extra = {}) {
  const parsed = parseKodik(rawUrl);

  if (!parsed) {
    throw new Error(
      "Нужна ссылка Kodik player с kodik.info или kodikplayer.com."
    );
  }

  const autoStartAt = Date.now() + MOVIE_PRELOAD_SECONDS * 1000;
  const episode = Math.max(1, Number(extra.episode) || 1);

  playbackReports.clear();

  state = {
    ...defaultState(),
    phase: "PAUSED",
    movie: {
      source: "KODIK",
      title: String(title || "").trim().slice(0, 100),
      titleOrig: String(extra.titleOrig || "").slice(0, 120),
      url: parsed.url,
      kodikHost: parsed.kodikHost,
      kodikPath: parsed.kodikPath,
      dubTitle: extra.dubTitle
        ? String(extra.dubTitle).slice(0, 100)
        : null,
      animeKey: extra.animeKey || null,
      animeUrl: extra.animeUrl || null,
      animeYear: Number(extra.year) || null,
      animeMalId: Number(extra.animeMalId) || null,
      episode,
      episodesCount: Number(extra.episodesCount) || null,
      episodeNumbers: Array.isArray(extra.episodeNumbers)
        ? extra.episodeNumbers.map(Number).filter((n) => n > 0)
        : [],
      skipSegments: { OP: null, ED: null },
      skipSegmentsStatus: "idle",
      duration: null,
    },
    positionSeconds: 0,
    startedAt: null,
    autoStartAt,
    skipVotes: { OP: {}, ED: {} },
  };

  console.log(
    `🍥 Anime preload: ${state.movie.title} • серия ${episode}. ` +
    `Озвучка=${state.movie.dubTitle || "-"}. ` +
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
    "--mode",
    "dubs",
    "--title",
    String(anime.title || ""),
  ];

  if (anime.animeUrl) {
    args.push("--anime-url", String(anime.animeUrl));
  }

  console.log(
    `🔎 Auto dub search: ${anime.title} (AnimeGo exact=${anime.animeUrl || "-"})`
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
    stdout = String(error?.stdout || "");
    if (!stdout.trim()) {
      throw new Error(
        `Автопоиск озвучек не запустился: ${error?.message || error}`
      );
    }
  }

  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Автопоиск озвучек вернул некорректный ответ.");
  }

  if (!data?.ok || !Array.isArray(data.options)) {
    throw new Error(data?.error || "AnimeGo не вернул Kodik-озвучки.");
  }

  const options = [];
  const seen = new Set();

  for (const raw of data.options) {
    const parsed = parseKodik(raw?.url);
    if (!parsed) continue;

    const title = String(raw?.title || "Озвучка").trim().slice(0, 100);
    const key = `${title.toLowerCase()}|${parsed.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    options.push({
      id: crypto.randomUUID(),
      title,
      translationType: "voice",
      link: parsed.url,
      episode: Number(raw?.episode) || 1,
      provider: String(raw?.provider || "AnimeGo/Kodik"),
      createdAt: Date.now() + options.length,
    });
  }

  if (!options.length) {
    throw new Error("Нашлись источники, но среди них нет поддерживаемых Kodik-ссылок.");
  }

  const episodeNumbers = Array.isArray(data.episodes)
    ? data.episodes.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [1];

  console.log(
    `✅ Auto dub search: ${anime.title} -> ${options.length} Kodik variants, ` +
    `episodes=${episodeNumbers.length}`
  );

  return {
    options,
    episodeNumbers,
    episodesCount: Number(data.episodesCount) || episodeNumbers.length || 1,
    animeUrl: String(data.animeUrl || anime.animeUrl || ""),
    matchedTitle: String(data.matchedTitle || anime.title || ""),
    titleOrig: String(data.titleOrig || anime.titleOrig || ""),
    year: Number(data.year) || anime.year || null,
  };
}

async function resolveAnimeEpisodeSource(anime, dub, episode) {
  const args = [
    path.join(ROOT, "anime_sources.py"),
    "--mode",
    "episode",
    "--title",
    String(anime.title || ""),
    "--anime-url",
    String(anime.animeUrl || ""),
    "--dub-title",
    String(dub.title || ""),
    "--episode",
    String(episode),
  ];

  let stdout = "";
  try {
    const result = await runExecFile("python3", args, {
      cwd: ROOT,
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = String(error?.stdout || "");
    if (!stdout.trim()) {
      throw new Error(`Не удалось получить серию ${episode}: ${error?.message || error}`);
    }
  }

  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`AnimeGo вернул некорректный ответ для серии ${episode}.`);
  }

  if (!data?.ok || !data?.url) {
    const error = new Error(
      data?.error ||
      `Не удалось найти серию ${episode} в озвучке ${dub.title}.`
    );

    error.availableEpisodes = Array.isArray(data?.episodes)
      ? data.episodes
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];

    error.episodesCount =
      Number(data?.episodesCount) ||
      error.availableEpisodes.length ||
      null;

    error.unavailableEpisode =
      Number(data?.unavailableEpisode) || null;

    error.availableDubs = Array.isArray(data?.availableDubs)
      ? data.availableDubs
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];

    throw error;
  }

  return {
    url: String(data.url),
    dubTitle: String(data.title || dub.title),
    episode: Number(data.episode) || Number(episode),
    episodeNumbers: Array.isArray(data.episodes)
      ? data.episodes.map(Number).filter((n) => n > 0)
      : anime.episodeNumbers || [],
    episodesCount: Number(data.episodesCount) || anime.episodesCount || null,
  };
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
  let discovery = null;
  let discoveryError = null;

  try {
    discovery = await discoverAutomaticDubOptions(anime);
    options = discovery.options;
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

  if (discovery) {
    state.animeWinner.animeUrl = discovery.animeUrl || state.animeWinner.animeUrl;
    state.animeWinner.episodeNumbers = discovery.episodeNumbers;
    state.animeWinner.episodesCount = discovery.episodesCount;
    state.animeWinner.titleOrig = discovery.titleOrig || state.animeWinner.titleOrig || "";
    state.animeWinner.year = discovery.year || state.animeWinner.year || null;
  }

  if (options.length) {
    state.notice = null;
    state.dubVoteEndsAt =
      Date.now() + DUB_VOTING_DURATION_SECONDS * 1000;

    saveState();
    broadcastState();
    return true;
  }

  const failedAnimeTitle =
    anime.title || "выбранного аниме";

  const reason =
    discoveryError?.message ||
    "Источник временно недоступен.";

  console.warn(
    `⚠️ No dubs for ${failedAnimeTitle}. Returning to main voting: ${reason}`
  );

  await startVoting();

  state.notice =
    `Для «${failedAnimeTitle}» не удалось найти озвучки. ` +
    "Вернулись к выбору другого фильма или аниме.";

  saveState();
  broadcastState();

  return false;
}

async function startDubVoting(animeSuggestion) {
  const anime = {
    key: animeSuggestion.animeKey,
    title: animeSuggestion.title,
    titleOrig: animeSuggestion.titleOrig || "",
    year: animeSuggestion.year || null,
    type: animeSuggestion.animeType || null,
    animeUrl: animeSuggestion.animeUrl || null,
    episodesCount: animeSuggestion.episodesCount || null,
    episodeNumbers: [],
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
    notice: "Ищу доступные озвучки выбранного AnimeGo-тайтла…",
  };

  console.log(`🎙 Anime won: ${anime.title}. Exact AnimeGo=${anime.animeUrl || "-"}`);

  saveState();
  broadcastState();
  await syncVoiceStatus();
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

async function startEpisodeVoting(anime, dub) {
  const numbers = Array.isArray(anime.episodeNumbers) && anime.episodeNumbers.length
    ? anime.episodeNumbers.map(Number).filter((n) => n > 0)
    : Array.from(
        { length: Math.max(1, Number(anime.episodesCount) || 1) },
        (_, index) => index + 1
      );

  if (numbers.length <= 1) {
    const episode = numbers[0] || 1;
    const resolved = await resolveAnimeEpisodeSource(anime, dub, episode);
    await startAnime(anime.title, resolved.url, {
      titleOrig: anime.titleOrig,
      dubTitle: resolved.dubTitle,
      animeKey: anime.key,
      animeUrl: anime.animeUrl,
      year: anime.year,
      episode,
      episodesCount: resolved.episodesCount || numbers.length,
      episodeNumbers: resolved.episodeNumbers || numbers,
    });
    return;
  }

  playbackReports.clear();
  state = {
    ...defaultState(),
    phase: "EPISODE_VOTING",
    animeWinner: { ...anime, episodeNumbers: numbers, episodesCount: numbers.length },
    selectedDub: {
      title: dub.title,
      provider: dub.provider || "AnimeGo/Kodik",
    },
    episodeNumbers: numbers,
    episodeVotes: {},
    episodeVoteEndsAt: Date.now() + EPISODE_VOTING_DURATION_SECONDS * 1000,
    notice: null,
  };

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

function chooseEpisodeWinner() {
  const numbers = state.episodeNumbers.map(Number).filter((n) => n > 0);
  if (!numbers.length) return 1;

  const counts = new Map(numbers.map((n) => [n, 0]));
  for (const raw of Object.values(state.episodeVotes)) {
    const episode = Number(raw);
    if (counts.has(episode)) counts.set(episode, counts.get(episode) + 1);
  }

  const totalVotes = Object.keys(state.episodeVotes).length;
  if (!totalVotes) return numbers.includes(1) ? 1 : numbers[0];

  return [...numbers].sort((a, b) => {
    const diff = (counts.get(b) || 0) - (counts.get(a) || 0);
    if (diff !== 0) return diff;
    return a - b;
  })[0];
}

async function finishEpisodeVoting() {
  if (state.phase !== "EPISODE_VOTING") {
    throw new Error("Сейчас нет голосования за серию.");
  }

  const anime = state.animeWinner;
  const dub = state.selectedDub;

  if (!anime || !dub) {
    throw new Error("Потеряны данные аниме или озвучки.");
  }

  const episode = chooseEpisodeWinner();

  // Claim the expired timer before network work. This prevents session tick
  // from launching the same resolver again while this one is still running.
  state.episodeVoteEndsAt = null;
  state.notice = `Проверяю серию ${episode} в озвучке «${dub.title}»…`;

  saveState();
  broadcastState();

  try {
    const resolved = await resolveAnimeEpisodeSource(
      anime,
      dub,
      episode
    );

    await startAnime(
      anime.title,
      resolved.url,
      {
        titleOrig: anime.titleOrig,
        dubTitle: resolved.dubTitle,
        animeKey: anime.key,
        animeUrl: anime.animeUrl,
        year: anime.year,
        episode,
        episodesCount:
          resolved.episodesCount ||
          anime.episodesCount,
        episodeNumbers:
          resolved.episodeNumbers ||
          anime.episodeNumbers,
      }
    );

    return episode;
  } catch (error) {
    if (state.phase !== "EPISODE_VOTING") {
      throw error;
    }

    let available = Array.isArray(
      error?.availableEpisodes
    )
      ? error.availableEpisodes
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : Array.isArray(state.episodeNumbers)
        ? state.episodeNumbers
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0)
        : [];

    const unavailableEpisode =
      Number(error?.unavailableEpisode) || null;

    if (unavailableEpisode) {
      available = available.filter(
        (value) => value !== unavailableEpisode
      );
    }

    available = [...new Set(available)]
      .sort((a, b) => a - b);

    if (!available.length) {
      const message =
        `В озвучке «${dub.title}» больше нет доступных серий. ` +
        "Возвращаю к выбору другого.";

      await startVoting();
      state.notice = message;
      saveState();
      broadcastState();
      await syncVoiceStatus();

      console.warn(
        `⚠️ Episode unavailable: ${anime.title} ` +
        `dub=${dub.title} ep=${episode}; no episodes left`
      );

      return null;
    }

    state.episodeNumbers = available;
    state.animeWinner = {
      ...state.animeWinner,
      episodeNumbers: available,
      // Keep the catalogue total in the title/status. episodeNumbers is the
      // currently usable set for this chosen dub.
      episodesCount:
        Number(error?.episodesCount) ||
        Number(state.animeWinner?.episodesCount) ||
        available.length,
    };

    for (const [userId, raw] of Object.entries(
      state.episodeVotes || {}
    )) {
      if (!available.includes(Number(raw))) {
        delete state.episodeVotes[userId];
      }
    }

    if (unavailableEpisode) {
      const dubs = Array.isArray(error?.availableDubs)
        ? error.availableDubs
        : [];

      state.notice =
        `Серия ${unavailableEpisode} недоступна в озвучке ` +
        `«${dub.title}». Я убрал её из этого голосования.` +
        (
          dubs.length
            ? ` На этой серии есть: ${dubs.slice(0, 6).join(", ")}.`
            : ""
        );
    } else {
      state.notice =
        `${error?.message || error} ` +
        "Список серий обновлён.";
    }

    state.episodeVoteEndsAt =
      Date.now() +
      EPISODE_VOTING_DURATION_SECONDS * 1000;

    saveState();
    broadcastState();
    await syncVoiceStatus();

    console.warn(
      `⚠️ Episode vote refreshed: ${anime.title} ` +
      `dub=${dub.title} failed=${episode} ` +
      `remaining=${available.length}`
    );

    // This is a handled availability problem, not a command/session error.
    return null;
  }
}


async function finishDubVoting() {
  if (state.phase !== "DUB_VOTING") {
    throw new Error("Сейчас нет голосования за озвучку.");
  }
  if (state.dubSearching) throw new Error("Поиск озвучек ещё не завершён.");

  const anime = state.animeWinner;
  const winner = chooseDubWinner();
  if (!anime) throw new Error("Аниме для голосования потеряно.");
  if (!winner) throw new Error("Нет доступных Kodik-озвучек.");

  await startEpisodeVoting(anime, winner);
  return winner;
}

async function startNextEpisodeVoting() {
  if (!state.movie || state.movie.source !== "KODIK") {
    await startVoting();
    return;
  }

  playbackReports.clear();
  state.positionSeconds = state.movie.duration || currentPosition();
  state.startedAt = null;
  state.autoStartAt = null;
  state.phase = "NEXT_EPISODE_VOTING";
  state.nextEpisodeVoteEndsAt = Date.now() + NEXT_EPISODE_VOTING_DURATION_SECONDS * 1000;
  state.nextEpisodeVotes = {};
  state.skipVotes = { OP: {}, ED: {} };
  state.notice = null;

  saveState();
  broadcastState();
  await syncVoiceStatus();
}

async function startNextAnimeEpisode() {
  const movie = state.movie;
  if (!movie || movie.source !== "KODIK") {
    await startVoting();
    return false;
  }

  const nextEpisode = (Number(movie.episode) || 1) + 1;
  const available = Array.isArray(movie.episodeNumbers)
    ? movie.episodeNumbers.map(Number).filter((n) => n > 0)
    : [];
  const maxEpisode = Number(movie.episodesCount) || (available.length ? Math.max(...available) : 0);

  if ((available.length && !available.includes(nextEpisode)) || (maxEpisode && nextEpisode > maxEpisode)) {
    await startVoting();
    return false;
  }

  const anime = {
    key: movie.animeKey,
    title: movie.title,
    titleOrig: movie.titleOrig || "",
    animeUrl: movie.animeUrl,
    year: movie.animeYear || null,
    episodeNumbers: available,
    episodesCount: maxEpisode || null,
  };
  const dub = { title: movie.dubTitle || "" };

  let resolved;

  try {
    resolved = await resolveAnimeEpisodeSource(
      anime,
      dub,
      nextEpisode
    );
  } catch (error) {
    console.warn(
      `⚠️ Next episode unavailable: ${movie.title} ` +
      `ep=${nextEpisode} dub=${dub.title}: ` +
      `${error?.message || error}`
    );

    await startVoting();
    state.notice =
      `Следующая серия ${nextEpisode} пока недоступна в озвучке ` +
      `«${dub.title || "выбранной"}». Выбираем другое.`;

    saveState();
    broadcastState();
    await syncVoiceStatus();

    return false;
  }

  await startAnime(movie.title, resolved.url, {
    titleOrig: movie.titleOrig,
    dubTitle: resolved.dubTitle,
    animeKey: movie.animeKey,
    animeUrl: movie.animeUrl,
    year: movie.animeYear || null,
    animeMalId: movie.animeMalId,
    episode: nextEpisode,
    episodesCount: resolved.episodesCount || maxEpisode,
    episodeNumbers: resolved.episodeNumbers || available,
  });

  return true;
}

async function finishNextEpisodeVoting() {
  if (state.phase !== "NEXT_EPISODE_VOTING") {
    throw new Error("Сейчас нет голосования после серии.");
  }

  const values = Object.values(state.nextEpisodeVotes || {});
  const next = values.filter((v) => v === "NEXT").length;
  const other = values.filter((v) => v === "OTHER").length;

  // Requested behavior: no votes -> next episode. A tie also keeps the series
  // going; "Смотрим другое" must actually beat "Следующая серия".
  if (other > next) {
    await startVoting();
    return "OTHER";
  }

  const started = await startNextAnimeEpisode();
  return started ? "NEXT" : "OTHER";
}

function resetSkipVotes(kind = null) {
  if (kind) {
    const key = String(kind).toUpperCase();
    if (key === "OP" || key === "ED") state.skipVotes[key] = {};
    return;
  }
  state.skipVotes = { OP: {}, ED: {} };
}

function cleanupInactiveAnimeSkipVotes() {
  if (state.movie?.source !== "KODIK" || state.phase !== "WATCHING") return false;
  let changed = false;
  const position = currentPosition();
  for (const kind of ["OP", "ED"]) {
    if (Object.keys(state.skipVotes?.[kind] || {}).length && !animeSkipIsActive(kind, position)) {
      state.skipVotes[kind] = {};
      changed = true;
    }
  }
  return changed;
}

async function applyAnimeSkipVote(kind, userId) {
  if (state.phase !== "WATCHING" || state.movie?.source !== "KODIK") {
    throw new Error("Скип доступен только во время просмотра аниме.");
  }

  kind = String(kind || "").toUpperCase();
  if (!["OP", "ED"].includes(kind)) throw new Error("Неизвестный тип скипа.");

  const segment = getAnimeSkipSegment(kind);
  if (!segment) {
    throw new Error(kind === "OP" ? "Для этой серии не найден opening." : "Для этой серии не найден ending.");
  }

  const position = currentPosition();
  if (!animeSkipIsActive(kind, position)) {
    throw new Error(kind === "OP" ? "Сейчас opening не идёт." : "Сейчас ending не идёт.");
  }

  state.skipVotes[kind][userId] = true;
  const votes = Object.keys(state.skipVotes[kind]).length;
  const threshold = skipMajorityThreshold();

  if (votes < threshold) {
    saveState();
    broadcastState();
    return { passed: false, votes, threshold, start: segment.start, end: segment.end };
  }

  // Skip exactly to the end of the real interval. ED no longer means "finish episode":
  // any post-credit scene remains playable.
  const target = Math.max(position, segment.end + 0.05);
  resetSkipVotes();
  await seekMovie(target);
  console.log(
    `⏭ ${kind} majority ${votes}/${threshold}: ` +
    `${formatTime(position)} -> ${formatTime(target)} ` +
    `(segment ${formatTime(segment.start)}-${formatTime(segment.end)})`
  );
  return { passed: true, votes, threshold, target, start: segment.start, end: segment.end };
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


app.post("/api/browser-session", (req, res) => {
  cleanupBrowserAuth();

  const ticket = String(
    req.body?.ticket || ""
  ).trim();

  if (!ticket) {
    res.status(400).json({
      error: "Нет browser ticket.",
    });
    return;
  }

  const record = browserTickets.get(ticket);

  // Ticket is one-time regardless of whether exchange succeeds afterward.
  browserTickets.delete(ticket);

  if (!record || record.expiresAt <= Date.now()) {
    res.status(401).json({
      error:
        "Ссылка устарела или уже использована. " +
        "Открой браузер снова из Discord Activity.",
    });
    return;
  }

  const browserSession =
    createOpaqueBrowserToken();

  // A fresh handoff invalidates old stored browser session tokens for
  // this user. Existing sockets are also replaced on connection.
  for (const [token, session] of browserSessions) {
    if (session?.user?.id === record.user.id) {
      browserSessions.delete(token);
    }
  }

  browserSessions.set(
    browserSession,
    {
      user: record.user,
      instanceId: record.instanceId,
      createdAt: Date.now(),
      expiresAt:
        Date.now() + BROWSER_SESSION_TTL_MS,
    }
  );

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.json({
    browser_session: browserSession,
    user_id: record.user.id,
    expires_in:
      Math.floor(BROWSER_SESSION_TTL_MS / 1000),
  });
});

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
    cleanupBrowserAuth();

    const clientBuild = String(
      socket.handshake.auth?.clientBuild || ""
    );

    if (clientBuild !== REQUIRED_CLIENT_BUILD) {
      throw new Error(
        `Клиент Movie Night устарел (${clientBuild || "unknown"}). ` +
        `Нужна версия ${REQUIRED_CLIENT_BUILD}.`
      );
    }

    const browserSessionToken = String(
      socket.handshake.auth?.browserSession || ""
    ).trim();

    if (browserSessionToken) {
      const browserSession =
        browserSessions.get(
          browserSessionToken
        );

      if (
        !browserSession ||
        browserSession.expiresAt <= Date.now()
      ) {
        browserSessions.delete(
          browserSessionToken
        );

        throw new Error(
          "Браузерная сессия истекла. " +
          "Открой Movie Night снова из Discord Activity."
        );
      }

      browserSession.expiresAt =
        Date.now() +
        BROWSER_SESSION_TTL_MS;

      socket.data.user =
        browserSession.user;
      socket.data.instanceId =
        browserSession.instanceId;
      socket.data.clientBuild =
        clientBuild;
      socket.data.sessionKind =
        "browser";
      socket.data.browserSessionToken =
        browserSessionToken;

      next();
      return;
    }

    const accessToken = String(
      socket.handshake.auth?.accessToken || ""
    );
    const instanceId = String(
      socket.handshake.auth?.instanceId || ""
    );
    const guildId = String(
      socket.handshake.auth?.guildId || ""
    );
    const channelId = String(
      socket.handshake.auth?.channelId || ""
    );

    if (!accessToken || !instanceId) {
      throw new Error("Нет Activity auth.");
    }

    if (guildId !== GUILD_ID) {
      throw new Error("Неверный guild.");
    }

    if (channelId !== VOICE_CHANNEL_ID) {
      throw new Error(
        "Activity должна быть открыта в настроенном войсе."
      );
    }

    const user =
      await getDiscordUserFromBearer(
        accessToken
      );

    const instance =
      await getActivityInstanceForJoiningUser(
        instanceId,
        user.id
      );

    if (instance.application_id !== CLIENT_ID) {
      throw new Error(
        "Неверный application instance."
      );
    }

    if (
      instance.location?.guild_id &&
      instance.location.guild_id !== GUILD_ID
    ) {
      throw new Error(
        "Неверный instance guild."
      );
    }

    if (
      instance.location?.channel_id &&
      instance.location.channel_id !==
        VOICE_CHANNEL_ID
    ) {
      throw new Error(
        "Неверный instance channel."
      );
    }

    if (
      Array.isArray(instance.users) &&
      !instance.users.includes(user.id)
    ) {
      throw new Error(
        "Пользователь не входит в Activity instance."
      );
    }

    socket.data.user = user;
    socket.data.instanceId = instanceId;
    socket.data.clientBuild = clientBuild;
    socket.data.sessionKind = "activity";

    next();
  } catch (error) {
    console.error(
      "Socket auth denied:",
      error.message
    );

    next(
      new Error(
        `Movie Night session verification failed: ${
          error.message || "unknown"
        }`
      )
    );
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  const sessionKind =
    socket.data.sessionKind || "activity";

  console.log(
    sessionKind === "browser"
      ? `🌐 Browser: ${user.global_name || user.username} (${user.id}) ` +
        `build=${socket.data.clientBuild || "unknown"}`
      : `🟢 Activity: ${user.global_name || user.username} (${user.id}) ` +
        `build=${socket.data.clientBuild || "unknown"}`
  );

  if (sessionKind === "browser") {
    // One live browser player per Discord user.
    for (const other of browserSocketsForUser(user.id)) {
      if (other.id !== socket.id) {
        other.disconnect(true);
      }
    }

    for (const activitySocket of activitySocketsForUser(user.id)) {
      playbackReports.delete(
        activitySocket.id
      );
    }

    notifyBrowserPresence(
      user.id,
      true
    );
  } else if (
    browserSocketsForUser(user.id).length
  ) {
    socket.emit("browser:presence", {
      active: true,
    });
  }

  socket.emit("session:state", sanitizeStateFor(user.id));

  socket.on(
    "browser:create-ticket",
    (_payload = {}, ack = () => {}) => {
      try {
        if (
          socket.data.sessionKind !== "activity"
        ) {
          throw new Error(
            "Browser ticket создаётся только из Discord Activity."
          );
        }

        if (
          isPhoneUserAgent(
            socket.handshake.headers[
              "user-agent"
            ]
          )
        ) {
          throw new Error(
            "Браузерный режим отключён на телефонах."
          );
        }

        const baseUrl =
          browserPublicBaseUrl(socket);

        if (!baseUrl) {
          throw new Error(
            "Не задан PUBLIC_BASE_URL. " +
            "Добавь публичный HTTPS-адрес Bothost в переменные окружения."
          );
        }

        cleanupBrowserAuth();

        const ticket =
          createOpaqueBrowserToken();

        browserTickets.set(
          ticket,
          {
            user,
            instanceId:
              socket.data.instanceId,
            createdAt: Date.now(),
            expiresAt:
              Date.now() +
              BROWSER_TICKET_TTL_MS,
          }
        );

        const url =
          `${baseUrl}/watch?t=` +
          encodeURIComponent(ticket);

        ack({
          ok: true,
          url,
          expiresIn:
            Math.floor(
              BROWSER_TICKET_TTL_MS /
              1000
            ),
        });
      } catch (error) {
        ack({
          ok: false,
          error:
            error?.message ||
            String(error),
        });
      }
    }
  );

  socket.on(
    "browser:delegated",
    () => {
      if (
        socket.data.sessionKind !==
        "activity"
      ) {
        return;
      }

      const previous =
        playbackReports.get(
          socket.id
        );

      if (previous) {
        playbackReports.set(
          socket.id,
          {
            ...previous,
            participating: false,
            lastReportAt: Date.now(),
          }
        );
      }
    }
  );

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

    if (state.movie?.source === "KODIK") {
      void ensureCurrentAnimeSkipSegments();
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
      state.movie?.source === "KODIK"
        ? `🏁 ${user.global_name || user.username} дошёл до конца серии ${state.movie?.episode || 1}.`
        : `🏁 ${user.global_name || user.username} дошёл до конца фильма.`
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
          animeUrl: anime.animeUrl,
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

  socket.on(
    "vote:episode-cast",
    ({ episode } = {}, ack = () => {}) => {
      try {
        if (state.phase !== "EPISODE_VOTING") {
          throw new Error("Сейчас нет голосования за серию.");
        }

        episode = Number(episode);
        if (!state.episodeNumbers.includes(episode)) {
          throw new Error("Такой серии нет в выбранном тайтле.");
        }

        state.episodeVotes[user.id] = episode;
        saveState();
        broadcastState();
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: error?.message || String(error) });
      }
    }
  );

  socket.on(
    "vote:next-episode",
    ({ choice } = {}, ack = () => {}) => {
      try {
        if (state.phase !== "NEXT_EPISODE_VOTING") {
          throw new Error("Сейчас нет голосования после серии.");
        }

        choice = String(choice || "").toUpperCase();
        if (!['NEXT', 'OTHER'].includes(choice)) {
          throw new Error("Неизвестный вариант.");
        }

        state.nextEpisodeVotes[user.id] = choice;
        saveState();
        broadcastState();
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: error?.message || String(error) });
      }
    }
  );

  socket.on(
    "anime:skip-vote",
    async ({ kind } = {}, ack = () => {}) => {
      try {
        const result = await applyAnimeSkipVote(kind, user.id);
        ack({ ok: true, ...result });
      } catch (error) {
        ack({ ok: false, error: error?.message || String(error) });
      }
    }
  );

  socket.on("disconnect", () => {
    playbackReports.delete(socket.id);
    animeSearchCache.delete(socket.id);

    if (
      socket.data.sessionKind ===
      "browser"
    ) {
      console.log(
        `🌐 Browser закрыт: ${user.global_name || user.username} (${user.id})`
      );

      setTimeout(() => {
        if (
          !browserSocketsForUser(
            user.id
          ).length
        ) {
          notifyBrowserPresence(
            user.id,
            false
          );
        }
      }, 1500);

      return;
    }

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

        const episode = Number(state.movie?.episode) || 1;
        const total = Number(state.movie?.episodesCount) || null;

        await interaction.editReply({
          content:
            `🍥 **${state.movie?.title || "Аниме"}**\n` +
            `🎞 Серия **${episode}${total ? `/${total}` : ""}**` +
            `${state.movie?.dubTitle ? ` · 🎙 **${state.movie.dubTitle}**` : ""}\n` +
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
      if (state.phase === "EPISODE_VOTING") {
        const episode = await finishEpisodeVoting();

        await interaction.editReply({
          content:
            episode == null
              ? "⚠️ Эта серия недоступна в выбранной озвучке. Голосование обновлено."
              : `🎞 Выбрана серия **${episode}**. Начинается предзагрузка.`,
        });

        return;
      }

      if (state.phase === "NEXT_EPISODE_VOTING") {
        const choice = await finishNextEpisodeVoting();
        await interaction.editReply({
          content: choice === "NEXT" ? "▶ Запускаю следующую серию." : "🗳 Переходим к выбору другого.",
        });
        return;
      }

      if (state.phase === "DUB_VOTING") {
        const dub = await finishDubVoting();

        await interaction.editReply({
          content:
            `🎙 Выбрана озвучка **${dub.title}**. Теперь выбираем серию.`,
                  });
        return;
      }

      if (state.phase !== "VOTING") {
        await interaction.editReply({
          content:
            "ℹ️ Сейчас голосование не идёт. " +
            "Команда /movie skipvote работает только во время голосования.",
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
        const left = Math.max(0, Math.ceil(((state.dubVoteEndsAt || Date.now()) - Date.now()) / 1000));
        await interaction.editReply({
          content:
            `🎙 Голосуем за озвучку **${state.animeWinner?.title || "аниме"}**\n` +
            `Озвучек: **${state.dubOptions.length}**\n` +
            `Осталось: **${formatTime(left)}**`,
        });
        return;
      }

      if (state.phase === "EPISODE_VOTING") {
        const left = Math.max(0, Math.ceil(((state.episodeVoteEndsAt || Date.now()) - Date.now()) / 1000));
        await interaction.editReply({
          content:
            `🎞 Выбираем серию **${state.animeWinner?.title || "аниме"}**\n` +
            `Озвучка: **${state.selectedDub?.title || "-"}**\n` +
            `Серий: **${state.episodeNumbers.length}** · Осталось: **${formatTime(left)}**`,
        });
        return;
      }

      if (state.phase === "NEXT_EPISODE_VOTING") {
        const left = Math.max(0, Math.ceil(((state.nextEpisodeVoteEndsAt || Date.now()) - Date.now()) / 1000));
        const values = Object.values(state.nextEpisodeVotes || {});
        const next = values.filter((v) => v === "NEXT").length;
        const other = values.filter((v) => v === "OTHER").length;
        await interaction.editReply({
          content:
            `🍥 Серия **${state.movie?.episode || 1}** закончилась\n` +
            `Следующая: **${next}** · Другое: **${other}**\n` +
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
            `⏳ **${state.movie?.title || "Фильм"}**${
              state.movie?.source === "KODIK"
                ? ` · серия **${state.movie?.episode || 1}${state.movie?.episodesCount ? `/${state.movie.episodesCount}` : ""}**`
                : ""
            }\n` +
            `Предзагрузка у зрителей\n` +
            `Общий старт через: **${formatTime(left)}**\n` +
            `Позиция старта: **0:00**`,
                  });
        return;
      }

      await interaction.editReply({
        content:
          `${state.movie?.source === "KODIK" ? "🍥" : "🎬"} **${state.movie?.title || "Фильм"}**\n` +
          `${state.movie?.source === "KODIK"
            ? `🎞 Серия **${state.movie?.episode || 1}${state.movie?.episodesCount ? `/${state.movie.episodesCount}` : ""}**${state.movie?.dubTitle ? ` · 🎙 **${state.movie.dubTitle}**` : ""}\n`
            : ""}` +
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
      state.movie?.source === "KODIK" &&
      cleanupInactiveAnimeSkipVotes()
    ) {
      saveState();
      broadcastState();
    }

    if (
      state.phase === "WATCHING" &&
      state.movie?.duration &&
      currentPosition() >= state.movie.duration
    ) {
      if (allActiveViewersFinished()) {
        console.log("🏁 Все активные зрители дошли до конца.");
        if (state.movie?.source === "KODIK") {
          await startNextEpisodeVoting();
        } else {
          await startVoting();
        }
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

    if (
      state.phase === "EPISODE_VOTING" &&
      state.episodeVoteEndsAt &&
      Date.now() >= state.episodeVoteEndsAt
    ) {
      await finishEpisodeVoting();
      return;
    }

    if (
      state.phase === "NEXT_EPISODE_VOTING" &&
      state.nextEpisodeVoteEndsAt &&
      Date.now() >= state.nextEpisodeVoteEndsAt
    ) {
      await finishNextEpisodeVoting();
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
