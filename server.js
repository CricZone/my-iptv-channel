const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const liveDir = path.join(__dirname, 'live');

// সার্ভার স্টার্টে পুরনো ভাঙা সেগমেন্ট ফাইল ক্লিয়ার
if (fs.existsSync(liveDir)) {
  fs.rmSync(liveDir, { recursive: true, force: true });
}
fs.mkdirSync(liveDir, { recursive: true });

// ব্রাউজার ও এক্সোপ্লেয়ারের জন্য স্ট্রং নো-ক্যাশ হেডার
app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'public, max-age=10');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Non-Stop 24/7 Live Stream Running!');
});

function parseDirectUrl(url) {
  let fileId = '';
  const match1 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const match2 = url.match(/id=([a-zA-Z0-9_-]+)/);
  
  if (match1 && match1[1]) fileId = match1[1];
  else if (match2 && match2[1]) fileId = match2[1];

  if (fileId) {
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  }
  return url;
}

let currentIndex = 0;
let isStreaming = false;
let globalSequence = 0;

function startStream() {
  if (isStreaming) return;

  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt not found!');
    setTimeout(startStream, 3000);
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.error('playlist.txt is empty!');
    setTimeout(startStream, 3000);
    return;
  }

  if (currentIndex >= lines.length) {
    currentIndex = 0;
  }

  const rawUrl = lines[currentIndex];
  const sourceUrl = parseDirectUrl(rawUrl);
  console.log(`[Playing Video ${currentIndex + 1} of ${lines.length}]: ${sourceUrl}`);

  isStreaming = true;

  // নো-এনকোডিং, জিরো সিপিইউ লোড, পিওর লাইভ টিভি ফরম্যাট
  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '5',
    '-start_number', `${globalSequence}`,
    '-hls_flags', 'delete_segments+omit_endlist',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/Opening '.*stream(\d+)\.ts'/);
    if (match && match[1]) {
      const currentNum = parseInt(match[1], 10);
      if (currentNum >= globalSequence) {
        globalSequence = currentNum + 1;
      }
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`Video ended (${code}). Seamlessly switching to next...`);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 100);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('FFmpeg error:', err.message);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
