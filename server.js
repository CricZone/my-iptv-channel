const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const liveDir = path.join(__dirname, 'live');
const playlistFile = path.join(__dirname, 'playlist.txt');
const m3u8File = path.join(liveDir, 'stream.m3u8');

if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

/* =========================================================
   HLS STATIC SERVER
========================================================= */
app.use('/live', express.static(liveDir, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Cache-Control', 'public, max-age=120, immutable');
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

/* =========================================================
   BASIC ROUTES
========================================================= */
app.get('/', (req, res) => {
  res.send('BDStreamHub Non-Stop 24/7 Linear Live Running!');
});

app.get('/status', (req, res) => {
  res.json({
    streaming: isStreaming,
    currentVideo: currentIndex + 1,
    totalVideos: playlist.length,
    retryCount,
    pid: ffmpegProcess ? ffmpegProcess.pid : null,
    playlistExists: fs.existsSync(m3u8File)
  });
});

/* =========================================================
   GOOGLE DRIVE URL CLEANER (Fixed URL Parsing)
========================================================= */
function parseDirectUrl(url) {
  url = url.trim();
  let fileId = '';

  const match1 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);

  if (match1 && match1[1]) {
    fileId = match1[1];
  } else if (match2 && match2[1]) {
    fileId = match2[1];
  }

  if (fileId) {
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  }

  return url;
}

/* =========================================================
   PLAYLIST
========================================================= */
let playlist = [];
let currentIndex = 0;

function loadPlaylist() {
  if (!fs.existsSync(playlistFile)) {
    console.error('❌ playlist.txt not found');
    playlist = [];
    return false;
  }

  playlist = fs.readFileSync(playlistFile, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  console.log(`📺 Loaded ${playlist.length} videos`);
  return playlist.length > 0;
}

/* =========================================================
   STREAM STATE
========================================================= */
let ffmpegProcess = null;
let isStreaming = false;
let retryCount = 0;
const MAX_RETRIES = 3;

/* =========================================================
   START STREAM
========================================================= */
function startStream() {
  if (isStreaming) {
    console.log('⚠️ FFmpeg already running');
    return;
  }

  if (!loadPlaylist()) {
    console.log('⏳ Playlist unavailable. Retrying in 5 seconds...');
    setTimeout(startStream, 5000);
    return;
  }

  if (currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  const rawUrl = playlist[currentIndex];
  const sourceUrl = parseDirectUrl(rawUrl);

  console.log('\n========================================');
  console.log(`▶️ Playing Video ${currentIndex + 1}/${playlist.length}`);
  console.log(`URL: ${sourceUrl}`);
  console.log('========================================');

  isStreaming = true;

  const segmentPattern = path.join(liveDir, 'stream%d.ts');
  const hlsFlags = 'append_list+delete_segments+omit_endlist+temp_file';

  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '10',
    '-rw_timeout', '30000000',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36',
    '-i', sourceUrl,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '15',
    '-hls_flags', hlsFlags,
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPattern,
    m3u8File
  ];

  console.log('🚀 Starting FFmpeg process...');
  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg.includes('error') || msg.includes('Error')) {
      console.log(`[FFmpeg] ${msg}`);
    }
  });

  ffmpegProcess.on('error', error => {
    console.error('❌ FFmpeg spawn error:', error.message);
    isStreaming = false;
    ffmpegProcess = null;
    handleStreamFailure();
  });

  ffmpegProcess.on('close', code => {
    console.log(`🛑 FFmpeg closed with exit code: ${code}`);
    isStreaming = false;
    ffmpegProcess = null;

    if (code === 0) {
      console.log(`✅ Video ${currentIndex + 1} finished normally.`);
      retryCount = 0;
      currentIndex = (currentIndex + 1) % playlist.length;
      setTimeout(startStream, 500);
    } else {
      handleStreamFailure();
    }
  });
}

/* =========================================================
   FAILURE HANDLER
========================================================= */
function handleStreamFailure() {
  retryCount++;
  if (retryCount <= MAX_RETRIES) {
    console.log(`🔄 Retrying same video... Attempt ${retryCount}/${MAX_RETRIES}`);
    setTimeout(startStream, 3000);
    return;
  }

  console.error(`⚠️ Video failed ${MAX_RETRIES} times. Moving to next video.`);
  retryCount = 0;
  currentIndex = (currentIndex + 1) % playlist.length;
  setTimeout(startStream, 1000);
}

/* =========================================================
   CLEAN SHUTDOWN
========================================================= */
function shutdown() {
  console.log('🛑 Shutting down server...');
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/* =========================================================
   START SERVER
========================================================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Stream URL: http://localhost:${PORT}/live/stream.m3u8`);
  startStream();
});
