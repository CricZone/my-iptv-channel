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

      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0'
      );

      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.setHeader(
        'Content-Type',
        'application/vnd.apple.mpegurl'
      );

    } else if (filePath.endsWith('.ts')) {

      // Segment cache করা যাবে
      res.setHeader(
        'Cache-Control',
        'public, max-age=120, immutable'
      );

      res.setHeader(
        'Content-Type',
        'video/mp2t'
      );
    }
  }
}));

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get('/', (req, res) => {
  res.send('BDStreamHub Non-Stop 24/7 Linear Live Running!');
});

app.get('/status', (req, res) => {

  res.json({
    streaming: isStreaming,
    currentVideo: currentIndex + 1,
    totalVideos: playlist.length,
    retryCount,
    pid: ffmpegProcess ? ffmpegProcess.pid : null,
    playlistExists: fs.existsSync(m3u8File)
  });

});

/* =========================================================
   GOOGLE DRIVE URL
========================================================= */

function parseDirectUrl(url) {

  url = url.trim();

  let fileId = '';

  const match1 = url.match(
    /\/d\/([a-zA-Z0-9_-]+)/
  );

  const match2 = url.match(
    /[?&]id=([a-zA-Z0-9_-]+)/
  );

  if (match1 && match1[1]) {

    fileId = match1[1];

  } else if (match2 && match2[1]) {

    fileId = match2[1];

  }

  if (fileId) {

    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  }

  return url;
}

/* =========================================================
   PLAYLIST
========================================================= */

let playlist = [];
let currentIndex = 0;

function loadPlaylist() {

  if (!fs.existsSync(playlistFile)) {

    console.error('❌ playlist.txt not found');

    playlist = [];

    return false;
  }

  playlist = fs.readFileSync(
    playlistFile,
    'utf8'
  )
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean);

  console.log(
    `📺 Loaded ${playlist.length} videos`
  );

  return playlist.length > 0;
}

/* =========================================================
   STREAM STATE
========================================================= */

let ffmpegProcess = null;
let isStreaming = false;

let retryCount = 0;

const MAX_RETRIES = 3;

/* =========================================================
   UNIQUE SEGMENT PREFIX
========================================================= */

function createSegmentPattern() {

  const uniqueId =
    `${Date.now()}_${process.pid}`;

  return path.join(
    liveDir,
    `seg_${uniqueId}_%06d.ts`
  );
}

/* =========================================================
   START STREAM
========================================================= */

function startStream() {

  if (isStreaming) {

    console.log(
      '⚠️ FFmpeg already running'
    );

    return;
  }

  if (!loadPlaylist()) {

    console.log(
      '⏳ Playlist unavailable. Retrying...'
    );

    setTimeout(
      startStream,
      5000
    );

    return;
  }

  if (currentIndex >= playlist.length) {

    currentIndex = 0;
  }

  const rawUrl =
    playlist[currentIndex];

  const sourceUrl =
    parseDirectUrl(rawUrl);

  console.log('');
  console.log(
    '========================================'
  );

  console.log(
    `▶️ Playing ${currentIndex + 1}/${playlist.length}`
  );

  console.log(
    `URL: ${sourceUrl}`
  );

  console.log(
    `Retry: ${retryCount}/${MAX_RETRIES}`
  );

  console.log(
    '========================================'
  );

  isStreaming = true;

  const segmentPattern =
    createSegmentPattern();

  /*
    append_list:
    পুরোনো HLS playlist-এর সঙ্গে নতুন segment যোগ করবে।

    delete_segments:
    অনেক পুরোনো segment delete করবে।

    discont_start:
    নতুন ভিডিও শুরু হলে HLS discontinuity দেবে।

    omit_endlist:
    live playlist হিসেবে রাখবে।

    temp_file:
    সম্পূর্ণ segment/playlist তৈরি হওয়ার পর publish করবে।
  */

  const hlsFlags =
    'append_list+delete_segments+discont_start+omit_endlist+temp_file';

  const ffmpegArgs = [

    // Input real-time speed
    '-re',

    // HTTP reconnect
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '10',

    // Network timeout
    '-rw_timeout', '30000000',

    // HTTP User-Agent
    '-user_agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',

    // Input
    '-i',
    sourceUrl,

    /*
      বর্তমান system-এ CPU বাঁচানোর জন্য copy।
    */
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',

    // HLS
    '-f', 'hls',

    // 4 sec target segment
    '-hls_time', '4',

    /*
      30 segment × 4 sec ≈ 120 sec
      live window
    */
    '-hls_list_size', '30',

    /*
      অতিরিক্ত segment রেখে দেবে।
      Slow client-এর জন্য নিরাপদ।
    */
    '-hls_delete_threshold', '10',

    // Segment filename
    '-hls_segment_filename',
    segmentPattern,

    // HLS flags
    '-hls_flags',
    hlsFlags,

    // MPEG-TS
    '-hls_segment_type',
    'mpegts',

    // Final playlist
    m3u8File
  ];

  console.log(
    '🚀 Starting FFmpeg...'
  );

  ffmpegProcess =
    spawn('ffmpeg', ffmpegArgs);

  /* =====================================================
     FFmpeg STDERR
  ===================================================== */

  ffmpegProcess.stderr.on(
    'data',
    data => {

      const message =
        data.toString().trim();

      if (message) {

        console.log(
          `[FFmpeg] ${message}`
        );
      }

    }
  );

  /* =====================================================
     FFmpeg ERROR
  ===================================================== */

  ffmpegProcess.on(
    'error',
    error => {

      console.error(
        '❌ FFmpeg spawn error:',
        error.message
      );

      isStreaming = false;

      ffmpegProcess = null;

      handleStreamFailure();
    }
  );

  /* =====================================================
     FFmpeg CLOSE
  ===================================================== */

  ffmpegProcess.on(
    'close',
    code => {

      console.log(
        `🛑 FFmpeg closed. Code: ${code}`
      );

      isStreaming = false;

      ffmpegProcess = null;

      /*
        code 0:
        সাধারণত ভিডিও শেষ হয়েছে।

        non-zero:
        error/crash/network/input problem হতে পারে।
      */

      if (code === 0) {

        console.log(
          `✅ Video ${currentIndex + 1} finished normally`
        );

        retryCount = 0;

        currentIndex =
          (currentIndex + 1) %
          playlist.length;

        /*
          খুব ছোট delay,
          কিন্তু 50ms-এর মতো অতিরিক্ত aggressive নয়।
        */

        setTimeout(
          startStream,
          300
        );

      } else {

        console.error(
          `❌ Video ${currentIndex + 1} failed with code ${code}`
        );

        handleStreamFailure();
      }

    }
  );
}

/* =========================================================
   FAILURE HANDLER
========================================================= */

function handleStreamFailure() {

  retryCount++;

  /*
    প্রথম 3 বার একই ভিডিও retry
  */

  if (
    retryCount <= MAX_RETRIES
  ) {

    console.log(
      `🔄 Retrying same video... ${retryCount}/${MAX_RETRIES}`
    );

    setTimeout(
      startStream,
      3000
    );

    return;
  }

  /*
    3 বার fail করলে পরের ভিডিও
  */

  console.error(
    `⚠️ Video failed ${MAX_RETRIES} times. Skipping.`
  );

  retryCount = 0;

  currentIndex =
    (currentIndex + 1) %
    playlist.length;

  setTimeout(
    startStream,
    1000
  );
}

/* =========================================================
   CLEAN SHUTDOWN
========================================================= */

function shutdown() {

  console.log(
    '🛑 Shutting down...'
  );

  if (ffmpegProcess) {

    ffmpegProcess.kill(
      'SIGTERM'
    );
  }

  process.exit(0);
}

process.on(
  'SIGTERM',
  shutdown
);

process.on(
  'SIGINT',
  shutdown
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

    console.log(
      `📡 HLS: /live/stream.m3u8`
    );

    startStream();
  }
);
