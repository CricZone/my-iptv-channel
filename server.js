const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const liveDir = path.join(__dirname, 'live');
const cacheDir = path.join(__dirname, 'cache');

if (!fs.existsSync(liveDir)) fs.mkdirSync(liveDir, { recursive: true });
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// HLS হেডার (নো বাফার)
app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'public, max-age=10');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub 24/7 TV Running Smoothly!');
});

// সরাসরি ডাউনলোড ফাংশন (যা ড্রাইভের বাফারিং ব্লক পুরোপুরি দূর করে)
function downloadVideo(url, targetPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000000) {
      return resolve(targetPath);
    }
    const file = fs.createWriteStream(targetPath);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
        return downloadVideo(response.headers.location, targetPath).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(targetPath));
      });
    }).on('error', (err) => {
      fs.unlink(targetPath, () => {});
      reject(err);
    });
  });
}

let currentIndex = 0;
let ffmpegProcess = null;

async function playNextStream() {
  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt file not found!');
    setTimeout(playNextStream, 5000);
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.error('playlist.txt is empty!');
    setTimeout(playNextStream, 5000);
    return;
  }

  if (currentIndex >= lines.length) {
    currentIndex = 0;
  }

  const currentUrl = lines[currentIndex];
  const nextIndex = (currentIndex + 1) % lines.length;
  const nextUrl = lines[nextIndex];

  console.log(`[Streaming Video ${currentIndex + 1}/${lines.length}]`);

  // গুগল ড্রাইভ লিঙ্কটি রিকানেক্ট মোডে লাইভ স্ট্রিম করা
  const ffmpegArgs = [
    '-re',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',
    '-i', currentUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+discont_start',
    path.join(liveDir, 'stream.m3u8')
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', (code) => {
    console.log(`Video ${currentIndex + 1} finished. Moving directly to Video ${nextIndex + 1}...`);
    currentIndex = nextIndex;
    setTimeout(playNextStream, 100);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('FFmpeg error:', err.message);
    currentIndex = nextIndex;
    setTimeout(playNextStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  playNextStream();
});
