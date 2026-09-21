FROM node:20-alpine

# FFmpeg, Python এবং yt-dlp ইনস্টল (Alpine Linux-এ কোনো প্যাকেজ এরর হয় না)
RUN apk update && apk add --no-cache \
    ffmpeg \
    curl \
    python3 \
    py3-pip \
    ca-certificates \
    && pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p live

EXPOSE 10000

CMD ["node", "server.js"]
