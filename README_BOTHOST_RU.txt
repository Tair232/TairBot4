MOVIE NIGHT V9.6 — BOTHOST READY
================================

Эта версия предназначена для постоянного хостинга на Bothost.

Главное отличие от локальной версии:
- Cloudflare Tunnel НЕ нужен.
- Vite dev server НЕ нужен.
- npm run build собирает Activity в dist/.
- Express отдаёт dist/, /api и Socket.IO с ОДНОГО порта.
- Сервер слушает 0.0.0.0 и PORT от Bothost.
- state.json хранится в /app/data/state.json и переживает redeploy.
- .env намеренно НЕ включён в архив. Секреты добавляются в панели Bothost.

Рекомендуемый Bothost port:
3000

Переменные окружения в Bothost:
DISCORD_CLIENT_ID=1535948196663009321
DISCORD_GUILD_ID=1492151172570808390
DISCORD_VOICE_CHANNEL_ID=1535996973260341320
CONTROL_ROLE_IDS=1530493427043667989,1492151556596826165,1529931653164826624
DISCORD_BOT_TOKEN=<YOUR BOT TOKEN>
DISCORD_CLIENT_SECRET=<YOUR CLIENT SECRET>
VOTING_DURATION_SECONDS=600
MOVIE_PRELOAD_SECONDS=60
LATE_JOIN_PRELOAD_SECONDS=180

VITE_DISCORD_CLIENT_ID больше не нужен: Client ID публичный и встроен в клиент.

BOTHOST:
- Включить "Использовать домен".
- Порт: 3000.
- Включить "Использовать собственный Dockerfile".
- Dockerfile находится в корне.
- Репозиторий: GitHub/GitLab, ветка main.
- После deploy открыть:
  https://ТВОЙ-ДОМЕН/health
  Должен быть JSON с "ok": true.

DISCORD DEVELOPER PORTAL -> ACTIVITIES -> URL MAPPINGS:
Заменить ТОЛЬКО старый Cloudflare root mapping:

/ -> ТВОЙ-ДОМЕН.bothost.tech

Оставить:
/vk -> vk.com
/vkmedia/{subdomain} -> {subdomain}.okcdn.ru
/vkuser/{subdomain} -> {subdomain}.vkuser.net

В target root mapping обычно указывается hostname без https://,
как и при старом trycloudflare mapping.

OAuth2 Redirect:
https://127.0.0.1
оставить как есть.

После смены URL Mapping:
полностью закрыть Discord Activity и открыть заново.


V9.7 FLAT STRUCTURE
===================
Чтобы избежать ошибки Vite:
  Failed to resolve /src/main.js

production-файлы клиента и сервера перенесены в корень:

  main.js
  style.css
  server.js

index.html теперь использует:
  /main.js

Папки src/ и server/ в этой версии отсутствуют.
