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
      res.setHeader('Cache-Control', 'public, max-age=300, immutable');
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

function getDirectStreamUrl(rawUrl) {
  return new Promise((resolve) => {
    let cleanUrl = rawUrl.trim();
    const fileIdMatch = cleanUrl.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]+)/);

    if (fileIdMatch && fileIdMatch[1]) {
      cleanUrl = `https://drive.google.com/file/d/${fileIdMatch[1]}/view`;
    }

    const ytdlp = spawn('yt-dlp', [
      '-g',
      '-f', 'best',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      cleanUrl
    ]);

    let outputUrl = '';
    ytdlp.stdout.on('data', (data) => {
      outputUrl += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && outputUrl.trim().startsWith('http')) {
        resolve(outputUrl.trim().split('\n')[0]);
      } else {
        if (fileIdMatch && fileIdMatch[1]) {
          resolve(`https://drive.usercontent.google.com/download?id=${fileIdMatch[1]}&export=download&confirm=t`);
        } else {
          resolve(cleanUrl);
        }
      }
    });

    ytdlp.on('error', () => {
      resolve(cleanUrl);
    });
  });
}

let playlist = [];
let currentIndex = 0;

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

let ffmpegProcess = null;
let isStreaming = false;

async function startStream() {
  if (isStreaming) return;

  if (!loadPlaylist()) {
    setTimeout(startStream, 3000);
    return;
  }

  if (currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  const rawUrl = playlist[currentIndex];
  console.log(`Starting Video [${currentIndex + 1}/${playlist.length}]`);

  const streamInput = await getDirectStreamUrl(rawUrl);
  isStreaming = true;

  // বাফারিং এবং স্মুথ প্লেব্যাকের জন্য অপটিমাইজড আর্গুমেন্ট
  const ffmpegArgs = [
    '-re',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', streamInput,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '20',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(liveDir, 'seg_%05d.ts'),
    m3u8File
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('failed')) {
      console.error(msg.trim());
    }
  });

  ffmpegProcess.on('close', () => {
    isStreaming = false;
    ffmpegProcess = null;
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 500);
  });

  ffmpegProcess.on('error', () => {
    isStreaming = false;
    ffmpegProcess = null;
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 2000);
  });
}

// Render যাতে সার্ভিসকে স্লিপে না পাঠায় তার জন্য সেলফ-পিং
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startStream();
});
