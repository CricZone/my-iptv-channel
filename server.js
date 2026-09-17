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

app.use('/live', express.static(liveDir, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.set('Cache-Control', 'public, max-age=60');
      res.set('Content-Type', 'video/mp2t');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('BDStreamHub Live Server Running 100% Smoothly!');
});

function startStream() {
  const videoPath = path.join(__dirname, 'video', 'branded.mp4');
  
  if (!fs.existsSync(videoPath)) {
    console.error('branded.mp4 not found yet!');
    return;
  }

  console.log('Broadcasting branded video with 0% CPU...');

  // কোনো এনকোডিং ছাড়া সরাসরি লাইভ স্ট্রিমিং (-c copy)
  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', videoPath,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.on('close', (code) => {
    console.log(`Stream ended (${code}), looping again...`);
    setTimeout(startStream, 1000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
