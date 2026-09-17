const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// live ডিরেক্টরি নিশ্চিত করা
const liveDir = path.join(__dirname, 'live');
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// স্ট্যাটিক HLS ফাইল সার্ভ করা
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
  res.send('BDStreamHub Cloud IPTV Server is Running!');
});

// লাইভ স্ট্রিম ইঞ্জিন
function startStream() {
  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt not found!');
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  const videoUrl = lines[0];
  console.log('Starting stream for:', videoUrl);

  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', videoUrl,
    '-vf', "drawtext=text='BDStreamHub TV':x=w-tw-30:y=30:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=5,drawtext=text='Welcome to BDStreamHub - Watch Live Movies and Entertainment Non-Stop!':x=w-mod(max(t\\,0)*100\\,w+tw):y=h-40:fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=8",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-b:v', '1500k',
    '-maxrate', '1600k',
    '-bufsize', '3000k',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    // লগ ট্র্যাক (প্রয়োজন হলে দেখতে পারেন)
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`FFmpeg stopped with code ${code}, restarting...`);
    setTimeout(startStream, 2000);
  });
}

// সার্ভার চালু ও স্ট্রিম শুরু
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
