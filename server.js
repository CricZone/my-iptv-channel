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
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Live Server Active');
});

app.get('/status', (req, res) => {
  res.json({
    streaming: isStreaming,
    currentVideo: currentIndex + 1,
    totalVideos: playlist.length,
    streamUrl: '/live/stream.m3u8'
  });
});

let playlist = [];
let currentIndex = 0;
let ffmpegProcess = null;
let ytdlpProcess = null;
let isStreaming = false;

function loadPlaylist() {
  if (!fs.existsSync(playlistFile)) return false;

  playlist = fs.readFileSync(playlistFile, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return playlist.length > 0;
}

function startStream() {
  if (isStreaming) return;

  if (!loadPlaylist()) {
    setTimeout(startStream, 3000);
    return;
  }

  if (currentIndex >= playlist.length) {
    currentIndex = 0; // ৫০০ শেষ হলে আবার প্রথম থেকে
  }

  const rawUrl = playlist[currentIndex];
  isStreaming = true;

  console.log(`[STREAM] Starting Video [${currentIndex + 1}/${playlist.length}] -> ${rawUrl}`);

  // yt-dlp ড্রাইভ লিঙ্ক সরাসরি ডিকোড করে পাইপ দিয়ে পাঠাবে (কোনো 403 ব্লক খাবে না)
  ytdlpProcess = spawn('yt-dlp', [
    '-o', '-',
    '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    rawUrl
  ]);

  // FFmpeg পাইপ থেকে ভিডিও নিয়ে সাথে সাথে HLS তৈরি করবে
  const ffmpegArgs = [
    '-re',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(liveDir, 'seg_%03d.ts'),
    m3u8File
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  // পাইপ কানেকশন
  ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('Opening')) {
      console.log(`[FFMPEG] ${msg.trim()}`);
    }
  });

  ytdlpProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ERROR:')) {
      console.error(`[YT-DLP ERROR] ${msg.trim()}`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[STREAM] Video finished. Next video starting...`);
    cleanupAndNext();
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[STREAM ERROR]:', err);
    cleanupAndNext();
  });
}

function cleanupAndNext() {
  if (ytdlpProcess) {
    ytdlpProcess.kill();
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    ffmpegProcess = null;
  }
  isStreaming = false;
  currentIndex = (currentIndex + 1) % playlist.length;
  setTimeout(startStream, 1500);
}

// Render স্লিপ প্রিভেন্টার
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }
}, 3 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  fs.readdir(liveDir, (err, files) => {
    if (!err) {
      for (const file of files) {
        fs.unlink(path.join(liveDir, file), () => {});
      }
    }
    startStream();
  });
});
