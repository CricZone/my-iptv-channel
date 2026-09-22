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
  res.send('BDStreamHub Live Running!');
});

app.get('/status', (req, res) => {
  res.json({
    streaming: isStreaming,
    currentVideo: currentIndex + 1,
    totalVideos: playlist.length,
    streamUrl: '/live/stream.m3u8'
  });
});

/* =========================================================
   গুগল ড্রাইভ ডিরেক্ট স্ট্রিম হ্যান্ডলার
========================================================= */
function getDirectStreamUrl(rawUrl) {
  let cleanUrl = rawUrl.trim();
  const fileIdMatch = cleanUrl.match(/(?:id=|\/d\/)([a-zA-Z0-9_-]+)/);

  if (fileIdMatch && fileIdMatch[1]) {
    const fileId = fileIdMatch[1];
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  }
  return cleanUrl;
}

let playlist = [];
let currentIndex = 0;
let ffmpegProcess = null;
let isStreaming = false;

function loadPlaylist() {
  if (!fs.existsSync(playlistFile)) {
    return false;
  }

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
    currentIndex = 0;
  }

  const rawUrl = playlist[currentIndex];
  const streamInput = getDirectStreamUrl(rawUrl);
  isStreaming = true;

  console.log(`[STREAM] Starting Video [${currentIndex + 1}/${playlist.length}]`);

  // Render CPU বাঁচানোর জন্য আল্ট্রা-লাইট কপি মোড
  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '0',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '10',
    '-multiple_requests', '1',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', streamInput,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',      // CPU 0% খরচ হবে, কোনো ল্যাগ বা ক্র্যাশ করবে না
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

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('Opening')) {
      console.log(msg.trim());
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[STREAM] Video [${currentIndex + 1}] Finished. Moving to next.`);
    isStreaming = false;
    ffmpegProcess = null;
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 1000);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[STREAM ERROR]:', err);
    isStreaming = false;
    ffmpegProcess = null;
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 2000);
  });
}

// Render স্লিপ প্রিভেন্টার
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }
}, 3 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  // আগের জমে থাকা ক্যাশ ডিলিট
  fs.readdir(liveDir, (err, files) => {
    if (!err) {
      for (const file of files) {
        fs.unlink(path.join(liveDir, file), () => {});
      }
    }
    startStream();
  });
});
