const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const liveDir = path.join(__dirname, 'live');

// সার্ভার স্টার্টে ডিরেক্টরি ফ্রেশ করা
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// সুপার-ফাস্ট স্ট্রং নো-ক্যাশ হেডার
app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'public, max-age=60');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Non-Stop 24/7 Linear Live Running!');
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

// ডিস্কের আসল ফাইল থেকে নিখুঁত সেগমেন্ট কাউন্টার নির্ধারণ
function getNextSequenceNumber() {
  const m3u8Path = path.join(liveDir, 'stream.m3u8');
  if (!fs.existsSync(m3u8Path)) return 0;

  try {
    const content = fs.readFileSync(m3u8Path, 'utf8');
    const matches = [...content.matchAll(/stream(\d+)\.ts/g)];
    if (matches.length > 0) {
      const highestNum = Math.max(...matches.map(m => parseInt(m[1], 10)));
      return highestNum + 1;
    }
  } catch (e) {}

  return 0;
}

function startStream() {
  if (isStreaming) return;

  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt file not found!');
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

  const currentSeq = getNextSequenceNumber();
  const m3u8Exists = fs.existsSync(path.join(liveDir, 'stream.m3u8'));

  // append_list এর সাথে নতুন ভিডিওর শুরুতে discont_start স্বয়ংক্রিয়ভাবে ডিসকন্টিনিউইটি বসাবে
  let hlsFlags = 'delete_segments+omit_endlist';
  if (m3u8Exists) {
    hlsFlags = 'append_list+delete_segments+omit_endlist+discont_start';
  }

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
    '-hls_list_size', '15', // ৬০ সেকেন্ডের সেফ লাইভ উইন্ডো (বাফার হলেও লিংক হারাবে না)
    '-start_number', `${currentSeq}`,
    '-hls_flags', hlsFlags,
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', (code) => {
    console.log(`Video ended (${code}). Seamlessly switching to next...`);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 50); // কোনো গ্যাপ ছাড়া সাথে সাথে পরের ভিডিও চালু
  });

  ffmpegProcess.on('error', (err) => {
    console.error('FFmpeg process error:', err.message);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
