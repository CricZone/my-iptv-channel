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

// সুপার-ফাস্ট নো-বাফার HLS হেডার
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
  res.send('BDStreamHub Non-Stop 24/7 Live Streaming Running!');
});

// গুগল ড্রাইভ ডাইরেক্ট লিংক কনভার্টার
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
let ffmpegProcess = null;

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

  if (currentIndex >= lines.length) {
    currentIndex = 0;
  }

  const rawUrl = lines[currentIndex];
  const sourceUrl = parseDirectUrl(rawUrl);
  console.log(`[Playing Video ${currentIndex + 1}/${lines.length}]: ${rawUrl}`);

  // নন-স্টপ ও স্মুথ ট্রানজিশনের জন্য অপ্টিমাইজড আর্গুমেন্ট
  const ffmpegArgs = [
    '-re',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', sourceUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list+discont_start',
    path.join(liveDir, 'stream.m3u8')
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    // console.log(data.toString()); // ডিবাগিং এর জন্য প্রয়োজন হলে অন করতে পারেন
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`Video ${currentIndex + 1} ended. Loading next video immediately...`);
    currentIndex = (currentIndex + 1) % lines.length; // স্বয়ংক্রিয় নেক্সট লুপ
    setTimeout(startStream, 300); // গ্যাপ ০ সেকেন্ডে নামিয়ে আনা
  });

  ffmpegProcess.on('error', (err) => {
    console.error('FFmpeg error:', err.message);
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
