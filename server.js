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

// ক্যাশ কন্ট্রোল: m3u8 ক্যাশ হবে না, কিন্তু ts ফাইল কিছু সময় ক্যাশ থাকবে
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
  res.send('BDStreamHub Continuous Streamer Active!');
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
let globalSequence = 0; // সিকোয়েন্স কখনো ০ হবে না, সারাক্ষণ সামনের দিকে বাড়বে

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

  // FFmpeg আর্গুমেন্ট
  // -avoid_negative_ts make_zero: টাইমস্ট্যাম্প এরর বন্ধ করে
  // -start_number: সিকোয়েন্স কখনো পেছনে ফিরবে না
  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
    '-i', sourceUrl,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-start_number', `${globalSequence}`,
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  // সেগমেন্ট তৈরি হলে সিকোয়েন্স কাউন্ট বাড়ানো
  ffmpegProcess.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('Opening') && text.includes('.ts')) {
      globalSequence++;
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`Video finished. Next starting...`);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 150); // সাথে সাথে পরের ভিডিও ধরবে
  });

  ffmpegProcess.on('error', (err) => {
    console.error('Stream error:', err.message);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
