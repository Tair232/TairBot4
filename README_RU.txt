MOVIE NIGHT V9 — CLEAN REBUILD
===============================

ЭТО НЕ ЕЩЁ ОДИН ПАТЧ V8 PLAYER.

V9 сделан заново:
- bot/backend/voting взяты из V8.6;
- видеоплеер переписан вокруг простого механизма рабочего V6/V7;
- внешний fullscreen полностью отсутствует;
- старые loadingMovieKey/autoplay patch-цепочки V8.x не используются.


КАК ТЕПЕРЬ ЖИВЁТ ФИЛЬМ
----------------------
1. Сервер присылает WATCHING + movie.
2. Activity создаёт ОДИН <video>.
3. Activity получает свежий VK embed HTML.
4. Из него берутся mp4_*.
5. Порядок:
   1080 -> 720 -> 480 -> 360 -> 240 -> 144
6. src ставится на /vkmedia/{subdomain}.
7. После loadedmetadata источник считается успешно загруженным.
8. НИКАКОГО await video.play() в загрузочной цепочке нет.
9. Бот дальше только синхронизирует:
   - currentTime
   - play
   - pause

Пока идёт один фильм <video> НЕ пересоздаётся.


ЧИСТОЕ ПОЛОТНО
--------------
Когда фильм играет:
- нет controls;
- нет title;
- нет качества;
- нет status;
- нет кнопок;
- нет диагностики;
- нет fullscreen;
- только video на 100% Activity.

Если Discord блокирует autoplay со звуком:
появляется только:
  ▶ Нажмите, чтобы начать просмотр

После клика она исчезает.


ПЕРЕХОД ПОСЛЕ ГОЛОСОВАНИЯ
--------------------------
VOTING:
  movie player полностью уничтожается.

Голосование закончилось:
  backend -> WATCHING
  -> создаётся НОВЫЙ один video
  -> загружается победивший VK фильм
  -> vote UI полностью исчезает.


СИНХРОНИЗАЦИЯ
-------------
Каждую секунду клиент сравнивает:
  local currentTime
с:
  server position

Если расхождение > ~1.35 сек:
  currentTime исправляется.

PAUSED:
  video.pause()
  position берётся строго от сервера.

WATCHING:
  video.play()
  не awaited;
  если autoplay blocked/pending > 1.8 сек:
    появляется кнопка одного клика.


VK SIGNED URL
-------------
Если MP4 поток умер или signed URL истёк:
V9 НЕ продолжает использовать старые ссылки.

Он заново:
  fetch /vk/video_ext.php
  -> получает СВЕЖИЕ mp4_*
  -> запускает поток снова.


BOT / COMMANDS
--------------
Сохраняются:
/movie start
/movie pause
/movie resume
/movie seek
/movie skip
/movie skipvote
/movie voting
/movie stop
/movie status

Контрольные роли и voice ID уже находятся в .env,
который ты копируешь из прошлой версии.


START
-----
1. Закрой старый START_MOVIE_NIGHT.bat.
2. Текущий tunnel можешь оставить.
3. Скопируй свой рабочий .env из V8.x в V9.
4. Запусти:
   START_MOVIE_NIGHT.bat

V9 унаследовал IPv6 localhost fix:
  Vite -> ::1:5173

То есть текущий cloudflared с:
  http://localhost:5173
должен попадать в Activity.

Mappings остаются:
  /                      -> текущий trycloudflare
  /vk                    -> vk.com
  /vkmedia/{subdomain}   -> {subdomain}.okcdn.ru


ТЕСТОВОЕ VK VIDEO
-----------------
https://vkvideo.ru/video-22822305_456241864

Пример:
/movie start title:Тест url:https://vkvideo.ru/video-22822305_456241864


ЕСЛИ ЧТО-ТО НЕ ЗАПУСТИЛОСЬ
--------------------------
Открой Discord DevTools console и ищи строки:

  [PLAYER] selected 1080p
  [PLAYER] metadata ...
  [PLAYER] playing ...
  [PLAYER] autoplay rejected ...
  [SYNC] seek ...

Теперь плеер логирует этапы отдельно и не должен маскировать
реальную ошибку бесконечным loader.


V9.1 — FIRST FRAME / SYNC FIX
-----------------------------
Найден основной баг чёрного экрана V9:

Backend шлёт authoritative WATCHING state примерно каждые 2 секунды.
V9 на КАЖДЫЙ такой пакет вызывал:
  applyHostState(true)

true означал FORCE SEEK.

Пока первый кадр ещё буферизовался, получалось:
  seek 0:00
  seek 0:02
  seek 0:04
  seek 0:06
  ...

VK MP4 декодер постоянно перескакивал и мог так и не начать отдавать кадры.

Исправлено:
- при первом источнике выполняется только ОДИН force seek;
- до первого события "playing" обычная синхронизация currentTime запрещена;
- повторные server state больше НЕ force-seek;
- loadeddata больше НЕ force-seek;
- после первого playing включается обычная drift correction;
- во время WATCHING hard seek только при drift > 2.25 сек;
- sync loop теперь раз в 2 сек вместо 1 сек.

VOICE:
Если Discord Gateway уже показывает бота в нужном voice channel,
V9.1 считает задачу выполненной.
Media transport Ready больше не нужен, потому что Movie Night не передаёт
и не принимает аудио через voice connection.

Поэтому ситуации вида:
  бот визуально сидит в voice
  но @discordjs/voice signalling/Ready timeout
больше не должны порождать бесконечные reconnect-логи.


V9.2 — 60 SEC PRELOAD + ONE-FRAME FIX
-------------------------------------
Изменена модель старта фильма.

РАНЬШЕ:
  winner/start
  -> server сразу WATCHING
  -> server clock сразу идёт
  -> медленный клиент буферизуется
  -> drift растёт
  -> sync пытается прыгнуть вперёд
  -> target ещё не buffered
  -> новый stall / один кадр

ТЕПЕРЬ:
  winner/start
  -> PAUSED @ 0:00
  -> autoStartAt = now + 60 sec
  -> все клиенты получают один и тот же фильм
  -> video preload="auto"
  -> у всех целая минута для VK/CDN буфера
  -> виден countdown "Общий старт через 0:59..."
  -> через 60 секунд BACKEND одновременно делает:
       phase = WATCHING
       positionSeconds = 0
       startedAt = now
  -> все начинают с 0:00.

MOVIE_PRELOAD_SECONDS=60
можно поменять локально в .env.

ВАЖНО:
Во время обязательной минуты:
/movie resume не может запустить фильм раньше;
/movie seek тоже заблокирован;
/movie pause сообщает, что фильм уже на предзагрузке.

ONE-FRAME FIX:
- waiting/stalled помечают клиент как buffering;
- пока buffering=true, sync НЕ делает hard seek;
- обычный sync никогда не seek'ает в target, которого ещё нет в video.buffered;
- threshold обычной коррекции увеличен до 3.5 сек;
- первый "playing" больше не вызывает немедленный seek;
- если клиент отстал, но server target ещё не скачан, он продолжает
  последовательное воспроизведение вместо постоянных прыжков.

В консоли появились полезные строки:
  [PLAYER] buffer 18.4s ahead @ 2.0s
  [PLAYER] waiting at ...
  [PLAYER] stalled at ...
  [SYNC] skip seek: target ... not buffered

Также устранено предупреждение discord.js про deprecated "ephemeral":
ответы команд теперь используют MessageFlags.Ephemeral.


V9.3 — AUTHORITATIVE CLOCK / LATE JOIN / END WAIT / VOLUME
==========================================================

1. ИСПРАВЛЕН РАССИНХРОН ОБЩЕГО PRELOAD
--------------------------------------
Раньше countdown строился через локальный Date.now() каждого компьютера.
Если часы Windows у людей отличались даже на 1-2 секунды, запуск тоже отличался.

Теперь клиент делает NTP-подобный time sync через Socket.IO:
  client t0
  -> backend serverNow
  -> client t1
  -> offset берётся через midpoint.

Из 5 samples используется sample с минимальным RTT.
Clock повторно синхронизируется каждые 30 секунд.

Все расчёты:
  serverPosition
  общий preload countdown
  voting countdown
используют serverNowMs(), а не локальные часы ПК.

При глобальном preload backend заранее задаёт один autoStartAt.
Клиенты могут начать ровно в этот timestamp, даже если WATCHING packet
долетел на несколько миллисекунд позже.

Backend при переходе в WATCHING ставит:
  startedAt = autoStartAt
а НЕ Date.now().

То есть authoritative timeline не сдвигается из-за interval delay.


2. ФИЛЬМ БОЛЬШЕ НЕ ЗАКАНЧИВАЕТСЯ ИЗ-ЗА ОДНОГО БЫСТРОГО ЗРИТЕЛЯ
--------------------------------------------------------------
Каждая Activity раз в секунду отправляет:
  currentTime
  ended
  buffering
  loaded
  participating

Сервер хранит только живые reports последних 15 секунд.

Когда server timer дошёл до duration:
  он НЕ открывает voting сразу.

Он ждёт, пока ВСЕ АКТИВНЫЕ participating viewers:
  ended == true
или
  currentTime >= duration - 1.25 sec.

Если пользователь закрыл Activity / отключился:
его socket report удаляется, и он больше не блокирует окончание.

movie:ended одного клиента теперь только помечает этого клиента как finished.
Он НЕ завершает фильм всем.

Если кто-то реально завис навсегда, админ всё ещё может:
/movie skip


3. LATE JOIN — 3 МИНУТЫ ПОДГОТОВКИ
----------------------------------
Если пользователь открывает Activity, когда фильм УЖЕ идёт:

Пример:
  группа смотрит 40:00
  late join preload = 180 sec

Новый пользователь НЕ пытается сразу играть 40:00.

Он:
  -> выбирает future target примерно 43:00
  -> seek на 43:00 в paused состоянии
  -> VK/CDN получает 3 минуты времени подготовить этот участок
  -> показывается:
       Подготовка к подключению
       Подключение через 2:59
  -> группа продолжает смотреть
  -> когда authoritative room доходит до ~43:00
  -> новый зритель подключается к этой же позиции.

То есть он не пытается "догнать" 3 минуты и не должен убивать
плеер множеством seek сразу после входа.

Настройка:
  LATE_JOIN_PRELOAD_SECONDS=180

Это текущие 60 секунд + ещё 120 секунд, как и было запрошено.

Если до конца фильма осталось меньше 3 минут, target автоматически
ограничивается концом фильма.


4. VOLUME HUD КАК У YOUTUBE
---------------------------
Во время фильма при движении мыши появляется снизу слева:

  🔊  ━━━━━━━━━ volume

Через 1.8 сек без движения UI сам исчезает.

Есть:
  - mute/unmute кнопка;
  - volume slider 0..100;
  - volume сохраняется локально через localStorage.

Никаких native video controls не добавлено.
Когда мышь не двигается, снова виден только фильм.


ENV
---
MOVIE_PRELOAD_SECONDS=60
LATE_JOIN_PRELOAD_SECONDS=180


V9.4 — VKUSER.NET CDN SUPPORT
=============================
Некоторые VK Video отдают MP4 не через:
  *.okcdn.ru

а через:
  *.vkuser.net

Пример:
  vk6-15.vkuser.net

V9.4 поддерживает оба варианта.

DISCORD DEVELOPER PORTAL -> ACTIVITIES -> URL MAPPINGS
------------------------------------------------------
Оставить существующие:

  /                  -> ТВОЙ_CURRENT_TRYCLOUDFLARE_HOST
  /vk                -> vk.com
  /vkmedia/{subdomain} -> {subdomain}.okcdn.ru

И ДОБАВИТЬ:

  /vkuser/{subdomain} -> {subdomain}.vkuser.net

После сохранения mapping полностью закрыть Activity в Discord
и открыть её заново.

Тестовое видео для vkuser.net:
  https://vkvideo.ru/video-162947134_456251078


V9.5 — MAIN SERVER IDS
======================
Перенесено с тестового сервера на новый Discord server.

DISCORD_GUILD_ID=1492151172570808390
DISCORD_VOICE_CHANNEL_ID=1535996973260341320

CONTROL_ROLE_IDS=1530493427043667989,1492151556596826165,1529931653164826624

Также ALLOWED_GUILD_ID в Activity client обновлён на:
1492151172570808390

Application / Client ID не менялся.
