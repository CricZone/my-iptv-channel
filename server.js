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

// Google Drive theke direct signed stream URL extract kora
function getDirectUrl(rawUrl) {
  return new Promise((resolve) => {
    let cleanUrl = rawUrl.trim();
    const ytdlp = spawn('yt-dlp', [
      '-g',
      '-f', 'best[ext=mp4]/best',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      cleanUrl
    ]);

    let output = '';
    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.on('close', (code) => {
      const finalUrl = output.trim().split('\n')[0];
      if (code === 0 && finalUrl.startsWith('http')) {
        resolve(finalUrl);
      } else {
        const fileIdMatch = cleanUrl.match(/(?:id=|\/d\/)([a-zA-Z0-9_-]+)/);
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
let ffmpegProcess = null;
let isStreaming = false;

function loadPlaylist() {
  if (!fs.existsSync(playlistFile)) return false;

  playlist = fs.readFileSync(playlistFile, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return playlist.length > 0;
}

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
  console.log(`[STREAM] Fetching direct URL for Video [${currentIndex + 1}/${playlist.length}]`);
  
  const streamInput = await getDirectUrl(rawUrl);
  isStreaming = true;

  console.log(`[STREAM] Started FFmpeg for Video [${currentIndex + 1}]`);

  const ffmpegArgs = [
    '-re',
    // Strong reconnect settings network drop/throttling thekabe
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '0',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '15',
    '-rw_timeout', '20000000', // 20s wait korbe network slow holeo close na hoye
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', streamInput,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start',
    '-hls_segment_filename', path.join(liveDir, 'seg_%06d.ts'),
    m3u8File
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('fatal')) {
      console.log(`[FFMPEG] ${msg.trim()}`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[STREAM] Video [${currentIndex + 1}] finished. Code: ${code}`);
    isStreaming = false;
    ffmpegProcess = null;
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 1000);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[STREAM ERROR]:', err);
    isStreaming = false;
    ffmpegProcess = null;
    setTimeout(startStream, 2000);
  });
}

// Render sleep prevention
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }
}, 3 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  fs.readdir(liveDir, (err, files) => {
    if (!err) {
      for (const file of files) {
        fs.unlink(path.join(liveDir, file), () => {});
      }
    }
    startStream();
  });
});
