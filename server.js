const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const liveDir = path.join(__dirname, 'live');
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// প্রতিবার স্ট্রিম শুরুর আগে পুরনো কোনো আবর্জনা/ক্যাশ থাকলে তা ডিলিট করা
function clearOldCache() {
  if (fs.existsSync(liveDir)) {
    const files = fs.readdirSync(liveDir);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(liveDir, file));
      } catch (e) {}
    }
  }
}

app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'no-cache, no-store');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Non-Stop Engine Running!');
});

function parseDirectUrl(url) {
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`;
    }
  }
  return url;
}

let currentIndex = 0;
let isStreaming = false;

function startStream() {
  if (isStreaming) return;

  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    setTimeout(startStream, 3000);
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    setTimeout(startStream, 3000);
    return;
  }

  if (currentIndex >= lines.length) {
    currentIndex = 0;
  }

  const rawUrl = lines[currentIndex];
  const sourceUrl = parseDirectUrl(rawUrl);
  console.log(`[Playing ${currentIndex + 1}/${lines.length}]: ${sourceUrl}`);

  isStreaming = true;

  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', () => {
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 200);
  });

  ffmpegProcess.on('error', () => {
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  clearOldCache(); // সার্ভার রান হতেই ডিরেক্টরি ফ্রেশ হবে
  console.log(`Server running on port ${PORT}`);
  startStream();
});
