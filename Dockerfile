FROM node:24-bookworm-slim

WORKDIR /usr/src/movie-night

# Anime translation discovery (AnimeGo -> Kodik) runs in a tiny Python helper.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && pip3 install --break-system-packages --no-cache-dir anicli_api==0.9.2 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
