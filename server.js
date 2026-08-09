import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
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
  voteEndsAt: null,
  suggestions: [],
  votes: {},
  lastUpdatedAt: Date.now(),
});

function normalizeState(raw) {
  const base = defaultState();
  const state = { ...base, ...(raw || {}) };

  if (!["IDLE", "WATCHING", "PAUSED", "VOTING"].includes(state.phase)) {
    state.phase = "IDLE";
  }

  if (!Array.isArray(state.suggestions)) state.suggestions = [];
  if (!state.votes || typeof state.votes !== "object") state.votes = {};

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
  return movie ? `${movie.oid}_${movie.id}_${movie.hash || ""}` : "";
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
    title: item.title,
    proposerName: item.proposerName,
    votes: counts.get(item.id) || 0,
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
    voteEndsAt: state.voteEndsAt,
    suggestions,
    mySuggestionId: mySuggestion?.id || null,
    myVote: state.votes[userId] || null,
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

// Production: Vite is built into ./dist and served by the same Express app.
// Development still uses the separate Vite dev server.
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, {
    index: "index.html",
    maxAge: "1h",
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
    return `Смотрим: ${state.movie?.title || "фильм"}`;
  }

  if (state.phase === "VOTING") {
    return "Выбираем следующий фильм";
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

  if (state.phase === "WATCHING") {
    state.startedAt = Date.now();
  }

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

async function registerMovieCommand() {
  const guild = await bot.guilds.fetch(GUILD_ID);
  const commands = await guild.commands.fetch();
  const existing = commands.find((command) => command.name === "movie");
  const body = commandDefinition().toJSON();

  if (existing) {
    await guild.commands.edit(existing.id, body);
    console.log("✅ /movie обновлена");
  } else {
    await guild.commands.create(body);
    console.log("✅ /movie зарегистрирована");
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

    const [user, instance] = await Promise.all([
      getDiscordUserFromBearer(accessToken),
      getActivityInstance(instanceId),
    ]);

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
    next(new Error("Activity session verification failed"));
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

  socket.on("disconnect", () => {
    playbackReports.delete(socket.id);
    console.log(
      `🔴 Activity ушёл: ${user.global_name || user.username} (${user.id})`
    );
  });
});

bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "movie") return;

  const sub = interaction.options.getSubcommand();

  // /movie status is readable by everyone.
  if (sub !== "status" && !hasControlRole(interaction)) {
    await deny(interaction);
    return;
  }

  try {
    if (sub === "start") {
      const title = interaction.options.getString("title", true);
      const url = interaction.options.getString("url", true);

      await startMovie(title, url);

      await interaction.reply({
        content:
          `⏳ **${title}** загружается у всех. ` +
          `Автостарт через **${formatTime(MOVIE_PRELOAD_SECONDS)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "pause") {
      await pauseMovie();

      await interaction.reply({
        content: `⏸ Пауза на ${formatTime(state.positionSeconds)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "resume") {
      await resumeMovie();

      await interaction.reply({
        content: "▶ Просмотр продолжен.",
        flags: MessageFlags.Ephemeral,
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

      await interaction.reply({
        content: `⏩ Перемотано на ${formatTime(seconds)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "skipvote") {
      const winner = await finishVoting({ extendIfEmpty: false });

      await interaction.reply({
        content:
          `⏭ Голосование завершено. **${winner.title}** выбран. ` +
          `Предзагрузка ${formatTime(MOVIE_PRELOAD_SECONDS)}, затем общий старт.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "skip" || sub === "voting") {
      await startVoting();

      await interaction.reply({
        content: `🗳 Голосование открыто на ${Math.floor(
          VOTING_DURATION_SECONDS / 60
        )} мин.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "stop") {
      await stopSession();

      await interaction.reply({
        content: "⏹ Movie Night остановлен.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "status") {
      if (state.phase === "IDLE") {
        await interaction.reply({
          content: "Movie Night сейчас не запущен.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (state.phase === "VOTING") {
        const left = Math.max(
          0,
          Math.ceil((state.voteEndsAt - Date.now()) / 1000)
        );

        await interaction.reply({
          content:
            `🗳 Идёт голосование\n` +
            `Вариантов: **${state.suggestions.length}**\n` +
            `Осталось: **${formatTime(left)}**`,
          flags: MessageFlags.Ephemeral,
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

        await interaction.reply({
          content:
            `⏳ **${state.movie?.title || "Фильм"}**\n` +
            `Предзагрузка у зрителей\n` +
            `Общий старт через: **${formatTime(left)}**\n` +
            `Позиция старта: **0:00**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          `🎬 **${state.movie?.title || "Фильм"}**\n` +
          `${state.phase === "PAUSED" ? "⏸" : "▶"} ` +
          `${formatTime(pos)}` +
          `${duration ? ` / ${formatTime(duration)}` : ""}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.error("Command error:", error);

    const payload = {
      content: `Ошибка: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
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
    return res.sendFile(path.join(DIST_DIR, "index.html"));
  }

  next();
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Movie Night: 0.0.0.0:${PORT}`);
  console.log(`💾 State: ${STATE_FILE}`);
});

bot.login(BOT_TOKEN);
