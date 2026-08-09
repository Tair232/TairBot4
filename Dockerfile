FROM node:24-bookworm-slim

WORKDIR /usr/src/movie-night

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

# Bothost persistently mounts /app/data. The application code/build stays
# outside /app so the platform mount cannot hide the Vite dist directory.
RUN mkdir -p /app/data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
