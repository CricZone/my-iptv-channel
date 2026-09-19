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
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// নো-ক্যাশ ও লাইভ হেডার
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
  res.send('BDStreamHub Non-Stop Live Streaming Running!');
});

const LOGO_REMOTE_URL = 'https://i.postimg.cc/4yQCwk94/1789679552103.png';
const localLogoPath = path.join(__dirname, 'watermark.png');

// সার্ভার স্টার্টে একবার লোগো ডাউনলোড
function ensureLogoDownloaded(callback) {
  if (fs.existsSync(localLogoPath)) {
    return callback();
  }
  const file = fs.createWriteStream(localLogoPath);
  https.get(LOGO_REMOTE_URL, (response) => {
    response.pipe(file);
    file.on('finish', () => {
      file.close(callback);
    });
  }).on('error', (err) => {
    console.error('Logo download error:', err.message);
    callback();
  });
}

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

function getLatestMediaSequence() {
  const m3u8Path = path.join(liveDir, 'stream.m3u8');
  if (fs.existsSync(m3u8Path)) {
    try {
      const content = fs.readFileSync(m3u8Path, 'utf8');
      const match = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    } catch (e) {}
  }
  return globalSequence;
}

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

  globalSequence = Math.max(globalSequence, getLatestMediaSequence());

  // ভিডিওর ডানদিকের ওপরের কোনায় লোগো স্কেল ও পজিশন করে ওভারলে
  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
    '-i', sourceUrl,
    '-i', localLogoPath,
    '-filter_complex', '[1:v]scale=85:-1[wm];[0:v][wm]overlay=main_w-overlay_w-20:20',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '20',
    '-start_number', `${globalSequence}`,
    '-hls_flags', 'append_list+delete_segments+omit_endlist+discont_start',
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
    console.log(`Video ended with code ${code}. Loading next...`);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 150);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('FFmpeg process error:', err.message);
    isStreaming = false;
    currentIndex = (currentIndex + 1) % lines.length;
    setTimeout(startStream, 1000);
  });
}

ensureLogoDownloaded(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startStream();
  });
});
