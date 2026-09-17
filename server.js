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

// সুপার-ফাস্ট নো-বাফার হেডার
app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'public, max-age=60');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Zero-Buffer Drive Live Running!');
});

// গুগল ড্রাইভ ডাইরেক্ট স্ট্রিম কনভার্টার
function parseDirectUrl(url) {
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`;
    }
  }
  return url;
}

function startStream() {
  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt file not found!');
    setTimeout(startStream, 5000);
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.error('playlist.txt is empty!');
    setTimeout(startStream, 5000);
    return;
  }

  const sourceUrl = parseDirectUrl(lines[0]);
  console.log('Streaming directly from Google Drive:', sourceUrl);

  // ০ বাফার রুল: রেন্ডার কোনো রিকোডিং করবে না, সরাসরি গুগল ড্রাইভ থেকে প্যাকেট নিয়ে HLS বানাবে (CPU ব্যবহার ০%)
  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', (code) => {
    console.log(`Stream ended (${code}). Restarting in 2s...`);
    setTimeout(startStream, 2000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
