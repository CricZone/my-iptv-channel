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
const outputPlaylist = path.join(liveDir, 'stream.m3u8');

// ==================================================
// Create live folder
// ==================================================

if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// ==================================================
// Delete old HLS files
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
          fs.unlinkSync(path.join(liveDir, file));
        } catch (err) {
          console.log(`Delete error: ${file}`);
        }
      }
    }

    console.log('Old HLS files cleaned.');
  } catch (err) {
    console.log('Cleanup error:', err.message);
  }
}

// Clean when server starts
cleanLiveFiles();

// ==================================================
// Serve HLS files
// ==================================================

app.use('/live', express.static(liveDir, {
  etag: false,

  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (filePath.endsWith('.m3u8')) {
      res.set(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );

      res.set(
        'Content-Type',
        'application/vnd.apple.mpegurl'
      );
    }

    if (filePath.endsWith('.ts')) {
      res.set(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );

      res.set(
        'Content-Type',
        'video/mp2t'
      );
    }
  }
}));

// ==================================================
// Home
// ==================================================

app.get('/', (req, res) => {
  res.send('BDStreamHub Sequential Live Streaming V2 Running!');
});

// ==================================================
// Read playlist.txt
// ==================================================

function getPlaylist() {
  if (!fs.existsSync(playlistFile)) {
    return [];
  }

  try {
    return fs.readFileSync(playlistFile, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => {
        return line && !line.startsWith('#');
      });
  } catch (err) {
    console.log('Playlist read error:', err.message);
    return [];
  }
}

// ==================================================
// Remove old playlist
// ==================================================

function removeOldPlaylist() {
  try {
    if (fs.existsSync(outputPlaylist)) {
      fs.unlinkSync(outputPlaylist);
    }
  } catch (err) {
    console.log(
      'Could not remove old playlist:',
      err.message
    );
  }
}

// ==================================================
// State
// ==================================================

let currentIndex = 0;
let isStreaming = false;
let ffmpegProcess = null;
let stopping = false;

// ==================================================
// Start next stream
// ==================================================

function startStream() {

  if (isStreaming || stopping) {
    return;
  }

  const playlist = getPlaylist();

  // No playlist
  if (playlist.length === 0) {
    console.log('playlist.txt is empty or missing.');

    setTimeout(startStream, 3000);
    return;
  }

  // Reset index
  if (currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  // IMPORTANT:
  // URL is already a direct Google Drive URL.
  // No URL conversion is performed.

  const sourceUrl = playlist[currentIndex];

  console.log('');
  console.log('==========================================');
  console.log(
    `▶ Playing Video ${currentIndex + 1} / ${playlist.length}`
  );
  console.log('==========================================');

  isStreaming = true;

  // Remove old playlist before new FFmpeg session
  removeOldPlaylist();

  // ==================================================
  // FFmpeg
  // ==================================================

  const ffmpegArgs = [

    // Read at real-time speed
    '-re',

    // Network reconnect
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '5',

    // User Agent
    '-user_agent',
    'Mozilla/5.0',

    // Input
    '-i',
    sourceUrl,

    // ==================================================
    // VIDEO ENCODING
    // ==================================================

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-tune',
    'zerolatency',

    '-pix_fmt',
    'yuv420p',

    // 30 FPS
    '-r',
    '30',

    // Keyframe every 2 seconds
    '-g',
    '60',

    '-keyint_min',
    '60',

    // Consistent GOP
    '-sc_threshold',
    '0',

    // ==================================================
    // AUDIO ENCODING
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

    // 4 second segments
    '-hls_time',
    '4',

    // Keep 6 segments
    '-hls_list_size',
    '6',

    // MPEG-TS
    '-hls_segment_type',
    'mpegts',

    // HLS flags
    '-hls_flags',
    'delete_segments+independent_segments+omit_endlist+discont_start',

    // Delete extra old segments
    '-hls_delete_threshold',
    '2',

    // Segment numbering
    '-start_number',
    '0',

    // Segment filename
    '-hls_segment_filename',
    path.join(
      liveDir,
      'segment_%06d.ts'
    ),

    // Output playlist
    outputPlaylist
  ];

  // ==================================================
  // Start FFmpeg
  // ==================================================

  ffmpegProcess = spawn(
    'ffmpeg',
    ffmpegArgs
  );

  // ==================================================
  // FFmpeg logs
  // ==================================================

  ffmpegProcess.stderr.on('data', (data) => {

    const message = data.toString();

    // Show errors
    if (
      message.includes('Error') ||
      message.includes('error') ||
      message.includes('Invalid') ||
      message.includes('failed')
    ) {
      console.log(
        '[FFmpeg]',
        message.trim()
      );
    }
  });

  // ==================================================
  // FFmpeg error
  // ==================================================

  ffmpegProcess.on('error', (err) => {

    console.log(
      'FFmpeg process error:',
      err.message
    );

    isStreaming = false;
    ffmpegProcess = null;

    goToNextVideo(1000);
  });

  // ==================================================
  // FFmpeg closed
  // ==================================================

  ffmpegProcess.on('close', (code, signal) => {

    console.log(
      `FFmpeg closed | code=${code} | signal=${signal}`
    );

    isStreaming = false;
    ffmpegProcess = null;

    if (stopping) {
      return;
    }

    // Go to next video
    goToNextVideo(500);
  });
}

// ==================================================
// Go to next video
// ==================================================

function goToNextVideo(delay = 500) {

  const playlist = getPlaylist();

  if (playlist.length === 0) {
    setTimeout(startStream, 3000);
    return;
  }

  currentIndex++;

  // Start again from first video
  if (currentIndex >= playlist.length) {
    currentIndex = 0;
  }

  console.log(
    `Next video → ${currentIndex + 1}/${playlist.length}`
  );

  setTimeout(
    startStream,
    delay
  );
}

// ==================================================
// Start Server
// ==================================================

const server = app.listen(PORT, () => {

  console.log('');
  console.log('==========================================');
  console.log('BDStreamHub Streaming Server V2');
  console.log('==========================================');

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    'HLS: /live/stream.m3u8'
  );

  console.log('==========================================');

  startStream();
});

// ==================================================
// Graceful Shutdown
// ==================================================

function shutdown() {

  if (stopping) {
    return;
  }

  stopping = true;

  console.log(
    'Stopping BDStreamHub server...'
  );

  if (ffmpegProcess) {

    try {
      ffmpegProcess.kill('SIGTERM');
    } catch (err) {
      console.log(
        'FFmpeg stop error:',
        err.message
      );
    }
  }

  server.close(() => {

    console.log(
      'Server stopped.'
    );

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000);
}

// ==================================================
// Shutdown events
// ==================================================

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);
