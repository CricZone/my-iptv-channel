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

// ক্যাশলেস ও স্মুথ হেডার
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
  res.send('BDStreamHub Live Server Running Smoothly!');
});

function startStream() {
  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) return;

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  const videoUrl = lines[0];
  console.log('Streaming source:', videoUrl);

  // লো-রিসোর্স ও বড় বাফার কনফিগারেশন (যাতে কখনই ফ্রেম ড্রপ না হয়)
  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', videoUrl,
    '-vf', "scale=1280:-2,drawtext=text='BDStreamHub TV':x=w-tw-20:y=20:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4,drawtext=text='Welcome to BDStreamHub - Watch Live Movies and Entertainment Non-Stop!':x=w-mod(max(t\\,0)*80\\,w+tw):y=h-35:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=6",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '1000k',
    '-maxrate', '1200k',
    '-bufsize', '2400k',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+split_by_time',
    path.join(liveDir, 'stream.m3u8')
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.on('close', (code) => {
    console.log(`Stream exited with code ${code}. Auto-restarting in 2s...`);
    setTimeout(startStream, 2000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
