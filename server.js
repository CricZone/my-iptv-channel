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

// লাইভ ডিরেক্টরি তৈরি
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

/* =========================================================
   HLS STATIC SERVER (ক্যাশিং ও ফ্রিজিং প্রিভেনশন)
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
  res.send('BDStreamHub 24/7 Live Engine Running!');
});

app.get('/status', (req, res) => {
  res.json({
    streaming: isStreaming,
    currentVideo: currentIndex + 1,
    totalVideos: playlist.length,
    streamUrl: '/live/stream.m3u8'
  });
});

/* =========================================================
   গুগল ড্রাইভ ডিরেক্ট স্ট্রিম বাইপাস
========================================================= */
function getDirectStreamUrl(rawUrl) {
  return new Promise((resolve) => {
    let cleanUrl = rawUrl.trim();

    // /view অথবা uc?id যে ফরম্যাটেই থাকুক ফাইল আইডি বের করা
    const fileIdMatch = cleanUrl.match(/(?:id=|\/d\/)([a-zA-Z0-9_-]+)/);

    if (fileIdMatch && fileIdMatch[1]) {
      const fileId = fileIdMatch[1];
      // ভাইরাস স্ক্যান ওয়ার্নিং বাইপাস করার কনফার্মড এন্ডপয়েন্ট
      const directGoogleUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
      return resolve(directGoogleUrl);
    }

    // ড্রাইভ ছাড়া অন্য লিংক থাকলে yt-dlp দিয়ে হ্যান্ডেল করবে
    const ytdlp = spawn('yt-dlp', [
      '-g',
      '-f', 'best[ext=mp4]/best',
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
        resolve(cleanUrl);
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

/* =========================================================
   প্লেলিস্ট লোড
========================================================= */
function loadPlaylist() {
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt file not found!');
    return false;
  }

  playlist = fs.readFileSync(playlistFile, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return playlist.length > 0;
}

/* =========================================================
   নন-স্টপ লাইভ স্ট্রিম কোর ইঞ্জিন
========================================================= */
async function startStream() {
  if (isStreaming) return;

  if (!loadPlaylist()) {
    console.log('Playlist is empty. Retrying in 5 seconds...');
    setTimeout(startStream, 5000);
    return;
  }

  // ৫০০ বা সব ভিডিও শেষ হলে আবার ১ নম্বর থেকে শুরু
  if (currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  const rawUrl = playlist[currentIndex];
  console.log(`[STREAM] Playing Video [${currentIndex + 1}/${playlist.length}]`);

  const streamInput = await getDirectStreamUrl(rawUrl);
  isStreaming = true;

  const ffmpegArgs = [
    '-re',
    // নেটওয়ার্ক বা ড্রাইভ কানেকশন ড্রপ প্রতিরোধ
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '0',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '10',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-i', streamInput,
    // রেজোলিউশন ও অডিও স্ট্যান্ডার্ডাইজেশন
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '50',
    '-keyint_min', '50',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '15',
    // ভিডিও পরিবর্তনের সময় প্লেয়ার হ্যাং ও বাফারিং ঠেকানোর ফ্ল্যাগ
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start',
    '-hls_segment_filename', path.join(liveDir, 'seg_%08d.ts'),
    m3u8File
  ];

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('fatal')) {
      console.error(`[FFMPEG ERROR]: ${msg.trim()}`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[STREAM] Video [${currentIndex + 1}] ended (Exit code: ${code})`);
    isStreaming = false;
    ffmpegProcess = null;

    // পুরো ভিডিও সফলভাবে শেষ হওয়ার পর পরবর্তী ভিডিওতে যাবে
    currentIndex = (currentIndex + 1) % playlist.length;
    setTimeout(startStream, 1000);
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[STREAM ERROR]:', err.message);
    isStreaming = false;
    ffmpegProcess = null;

    // কোনো এরর হলে স্কিপ না করে একই ভিডিও আবার চালানোর চেষ্টা করবে
    setTimeout(startStream, 3000);
  });
}

// Render স্লিপ প্রতিরোধে সেলফ-পিং
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }
}, 3 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);

  // ক্যাশ ফাইল পরিষ্কার করে স্ট্রিম চালু
  fs.readdir(liveDir, (err, files) => {
    if (!err) {
      for (const file of files) {
        fs.unlink(path.join(liveDir, file), () => {});
      }
    }
    startStream();
  });
});
