const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors());

// ==================================================
// PATHS
// ==================================================

const liveDir = path.join(__dirname, 'live');
const playlistFile = path.join(__dirname, 'playlist.txt');
const outputPlaylist = path.join(liveDir, 'stream.m3u8');

// ==================================================
// CREATE LIVE DIRECTORY
// ==================================================

if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, {
    recursive: true
  });
}

// ==================================================
// CLEAN OLD HLS FILES
// ONLY RUNS WHEN SERVER STARTS
// ==================================================

function cleanLiveFiles() {
  try {
    const files = fs.readdirSync(liveDir);

    for (const file of files) {

      if (
        file.endsWith('.ts') ||
        file.endsWith('.m3u8') ||
        file.endsWith('.tmp')
      ) {

        try {
          fs.unlinkSync(
            path.join(liveDir, file)
          );

        } catch (err) {

          console.log(
            `Could not delete ${file}`
          );
        }
      }
    }

    console.log(
      'Old HLS files cleaned.'
    );

  } catch (err) {

    console.log(
      'Cleanup error:',
      err.message
    );
  }
}

// Clean only when server starts
cleanLiveFiles();

// ==================================================
// HLS STATIC FILE SERVER
// ==================================================

app.use(
  '/live',
  express.static(liveDir, {

    etag: false,

    setHeaders: (res, filePath) => {

      // CORS
      res.set(
        'Access-Control-Allow-Origin',
        '*'
      );

      // M3U8
      if (filePath.endsWith('.m3u8')) {

        res.set(
          'Cache-Control',
          'no-cache, no-store, must-revalidate'
        );

        res.set(
          'Pragma',
          'no-cache'
        );

        res.set(
          'Expires',
          '0'
        );

        res.set(
          'Content-Type',
          'application/vnd.apple.mpegurl'
        );
      }

      // TS
      if (filePath.endsWith('.ts')) {

        res.set(
          'Cache-Control',
          'public, max-age=2'
        );

        res.set(
          'Content-Type',
          'video/mp2t'
        );
      }
    }
  })
);

// ==================================================
// HOME
// ==================================================

app.get('/', (req, res) => {

  res.send(
    'BDStreamHub Sequential Live Streaming V3 Running!'
  );

});

// ==================================================
// PLAYLIST READER
// ==================================================

function getPlaylist() {

  if (!fs.existsSync(playlistFile)) {
    return [];
  }

  try {

    return fs.readFileSync(
      playlistFile,
      'utf8'
    )
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => {

        return (
          line &&
          !line.startsWith('#')
        );

      });

  } catch (err) {

    console.log(
      'Playlist read error:',
      err.message
    );

    return [];
  }
}

// ==================================================
// STREAM STATE
// ==================================================

let currentIndex = 0;

let isStreaming = false;

let ffmpegProcess = null;

let stopping = false;

// Unique session number
let sessionNumber = 0;

// ==================================================
// START STREAM
// ==================================================

function startStream() {

  if (
    isStreaming ||
    stopping
  ) {
    return;
  }

  const playlist = getPlaylist();

  // ------------------------------------------------
  // No playlist
  // ------------------------------------------------

  if (playlist.length === 0) {

    console.log(
      'playlist.txt is empty or missing.'
    );

    setTimeout(
      startStream,
      3000
    );

    return;
  }

  // ------------------------------------------------
  // Reset index
  // ------------------------------------------------

  if (
    currentIndex >= playlist.length
  ) {

    currentIndex = 0;
  }

  // ------------------------------------------------
  // Direct URL
  // ------------------------------------------------

  const sourceUrl =
    playlist[currentIndex];

  // New FFmpeg session ID
  sessionNumber++;

  const sessionId =
    `${Date.now()}_${sessionNumber}`;

  console.log('');
  console.log(
    '=========================================='
  );

  console.log(
    `▶ Playing Video ${currentIndex + 1} / ${playlist.length}`
  );

  console.log(
    `Session: ${sessionId}`
  );

  console.log(
    '=========================================='
  );

  isStreaming = true;

  // ==================================================
  // IMPORTANT
  //
  // DO NOT DELETE stream.m3u8 HERE
  //
  // This is what helps reduce buffering during
  // Video 1 → Video 2 transition.
  // ==================================================

  // ==================================================
  // UNIQUE SEGMENT NAME
  // ==================================================

  const segmentPattern =
    path.join(
      liveDir,
      `segment_${sessionId}_%06d.ts`
    );

  // ==================================================
  // FFMPEG ARGUMENTS
  // ==================================================

  const ffmpegArgs = [

    // ------------------------------------------------
    // REAL-TIME PLAYBACK
    // ------------------------------------------------

    '-re',

    // ------------------------------------------------
    // NETWORK RECONNECT
    // ------------------------------------------------

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_at_eof',
    '1',

    '-reconnect_delay_max',
    '5',

    // ------------------------------------------------
    // USER AGENT
    // ------------------------------------------------

    '-user_agent',
    'Mozilla/5.0',

    // ------------------------------------------------
    // INPUT
    // ------------------------------------------------

    '-i',
    sourceUrl,

    // ==================================================
    // VIDEO
    // ==================================================

    '-c:v',
    'libx264',

    // Faster encoding
    '-preset',
    'veryfast',

    '-tune',
    'zerolatency',

    // Compatible pixel format
    '-pix_fmt',
    'yuv420p',

    // ------------------------------------------------
    // 30 FPS
    // ------------------------------------------------

    '-r',
    '30',

    // ------------------------------------------------
    // KEYFRAME EVERY 2 SEC
    // ------------------------------------------------

    '-g',
    '60',

    '-keyint_min',
    '60',

    '-sc_threshold',
    '0',

    // ==================================================
    // AUDIO
    // ==================================================

    '-c:a',
    'aac',

    '-b:a',
    '128k',

    '-ar',
    '48000',

    '-ac',
    '2',

    // ==================================================
    // HLS
    // ==================================================

    '-f',
    'hls',

    // 2 second segments
    '-hls_time',
    '2',

    // Keep 6 segments
    '-hls_list_size',
    '6',

    // MPEG-TS
    '-hls_segment_type',
    'mpegts',

    // ------------------------------------------------
    // IMPORTANT HLS FLAGS
    // ------------------------------------------------

    '-hls_flags',
    'delete_segments+append_list+independent_segments+omit_endlist+discont_start',

    // ------------------------------------------------
    // Keep only a small number of old segments
    // ------------------------------------------------

    '-hls_delete_threshold',
    '1',

    // ------------------------------------------------
    // Unique segment filename
    // ------------------------------------------------

    '-hls_segment_filename',
    segmentPattern,

    // ------------------------------------------------
    // HLS output
    // ------------------------------------------------

    outputPlaylist
  ];

  // ==================================================
  // START FFMPEG
  // ==================================================

  ffmpegProcess = spawn(
    'ffmpeg',
    ffmpegArgs
  );

  // ==================================================
  // FFMPEG LOG
  // ==================================================

  ffmpegProcess.stderr.on(
    'data',
    (data) => {

      const message =
        data.toString();

      // Show important errors
      if (
        message.includes('Error') ||
        message.includes('error') ||
        message.includes('Invalid') ||
        message.includes('failed') ||
        message.includes('No such file') ||
        message.includes('Connection')
      ) {

        console.log(
          '[FFmpeg]',
          message.trim()
        );
      }
    }
  );

  // ==================================================
  // FFMPEG ERROR
  // ==================================================

  ffmpegProcess.on(
    'error',
    (err) => {

      console.log(
        'FFmpeg process error:',
        err.message
      );

      isStreaming = false;

      ffmpegProcess = null;

      if (!stopping) {

        goToNextVideo(
          800
        );
      }
    }
  );

  // ==================================================
  // FFMPEG CLOSED
  // ==================================================

  ffmpegProcess.on(
    'close',
    (code, signal) => {

      console.log(
        `FFmpeg closed | code=${code} | signal=${signal}`
      );

      isStreaming = false;

      ffmpegProcess = null;

      // Don't restart when server shutting down
      if (stopping) {
        return;
      }

      // Next video
      goToNextVideo(
        300
      );
    }
  );
}

// ==================================================
// NEXT VIDEO
// ==================================================

function goToNextVideo(
  delay = 300
) {

  const playlist =
    getPlaylist();

  // ------------------------------------------------
  // Playlist empty
  // ------------------------------------------------

  if (
    playlist.length === 0
  ) {

    console.log(
      'No videos in playlist.'
    );

    setTimeout(
      startStream,
      3000
    );

    return;
  }

  // ------------------------------------------------
  // Next index
  // ------------------------------------------------

  currentIndex++;

  // ------------------------------------------------
  // Back to first video
  // ------------------------------------------------

  if (
    currentIndex >= playlist.length
  ) {

    currentIndex = 0;

    console.log(
      '🔄 Playlist finished. Starting again from Video 1.'
    );
  }

  console.log(
    `Next video → ${currentIndex + 1}/${playlist.length}`
  );

  // ------------------------------------------------
  // Start next video
  // ------------------------------------------------

  setTimeout(
    startStream,
    delay
  );
}

// ==================================================
// START SERVER
// ==================================================

const server =
  app.listen(
    PORT,
    () => {

      console.log('');
      console.log(
        '=========================================='
      );

      console.log(
        'BDStreamHub Streaming Server V3'
      );

      console.log(
        '=========================================='
      );

      console.log(
        `Server running on port ${PORT}`
      );

      console.log(
        `HLS: /live/stream.m3u8`
      );

      console.log(
        '=========================================='
      );

      // Start streaming
      startStream();
    }
  );

// ==================================================
// GRACEFUL SHUTDOWN
// ==================================================

function shutdown() {

  if (stopping) {
    return;
  }

  stopping = true;

  console.log(
    'Stopping BDStreamHub server...'
  );

  // ------------------------------------------------
  // Stop FFmpeg
  // ------------------------------------------------

  if (ffmpegProcess) {

    try {

      ffmpegProcess.kill(
        'SIGTERM'
      );

    } catch (err) {

      console.log(
        'FFmpeg stop error:',
        err.message
      );
    }
  }

  // ------------------------------------------------
  // Close server
  // ------------------------------------------------

  server.close(
    () => {

      console.log(
        'Server stopped.'
      );

      process.exit(0);
    }
  );

  // Force exit after 5 sec
  setTimeout(
    () => {

      process.exit(0);

    },
    5000
  );
}

// ==================================================
// SHUTDOWN EVENTS
// ==================================================

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);
