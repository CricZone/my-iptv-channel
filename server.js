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

// জিরো বাফার ও ফাস্ট লোডিং হেডার
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
  res.send('BDStreamHub Multi-Source Live Server Running Smoothly!');
});

// গুগল ড্রাইভ HD কনফার্মেশন ও ডাইরেক্ট লিঙ্ক হ্যান্ডলার
function parseDirectUrl(url) {
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      // বড় ফাইলের ক্ষেত্রে গুগল ড্রাইভ ভাইরাস স্ক্যান পেজ বাইপাস করে সরাসরি HD ফাইল আনা
      return `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`;
    }
  }
  return url;
}

function startStream() {
  const playlistFile = path.join(__dirname, 'playlist.txt');
  if (!fs.existsSync(playlistFile)) {
    console.error('playlist.txt file not found!');
    return;
  }

  const lines = fs.readFileSync(playlistFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.error('playlist.txt is empty!');
    return;
  }

  let rawSource = lines[0];
  let sourceUrl = parseDirectUrl(rawSource);
  
  // ফাইল যদি লোকাল গিটহাব রিপোজিটরির ভেতরে থাকে
  if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
    sourceUrl = path.join(__dirname, sourceUrl);
  }

  console.log('Final Source Stream:', sourceUrl);

  let ffmpegArgs = [];

  // ১. সোর্স যদি সরাসরি .m3u8 হয় (Zero CPU Relay - নো বাফারিং)
  if (sourceUrl.includes('.m3u8')) {
    console.log('Mode: Direct HLS Relay');
    ffmpegArgs = [
      '-re',
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
      '-i', sourceUrl,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments',
      path.join(liveDir, 'stream.m3u8')
    ];
  } 
  // ২. সোর্স যদি Google Drive, Archive.org বা লোকাল MP4 হয়
  else {
    console.log('Mode: Optimized Dynamic Stream');
    ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      '-i', sourceUrl,
      '-vf', "scale=1280:-2,drawtext=text='BDStreamHub TV':x=w-tw-25:y=25:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4,drawtext=text='Welcome to BDStreamHub Live - 24/7 Entertainment':x=w-mod(max(t\\,0)*80\\,w+tw):y=h-35:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=5",
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '1200k',
      '-maxrate', '1500k',
      '-bufsize', '2500k',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-f', 'hls',
      '-hls_time', '3',
      '-hls_list_size', '8',
      '-hls_flags', 'delete_segments+split_by_time',
      path.join(liveDir, 'stream.m3u8')
    ];
  }

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    // FFmpeg লগের জন্য এটি সাইলেন্ট রাখা হয়েছে
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`Stream stopped (${code}). Auto-restarting in 2s...`);
    setTimeout(startStream, 2000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
