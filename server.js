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

// সুপার-ফাস্ট ক্যাশিং ও বাফারলেস হেডার
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
  res.send('BDStreamHub Zero-Buffer Live Server Active!');
});

function parseDirectUrl(url) {
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.usercontent.google.com/download?id=${match[1]}&export=download&confirm=t`;
    }
  }
  return url;
}

function startStream() {
  const brandedLocalVideo = path.join(__dirname, 'video', 'branded.mp4');
  const playlistFile = path.join(__dirname, 'playlist.txt');

  let sourceUrl = '';
  let isLocalBranded = false;

  // ১. অগ্রাধিকার: রিপোজিটরির ভেতরে তৈরি হওয়া ব্র্যান্ডেড ভিডিও (০% বাফার)
  if (fs.existsSync(brandedLocalVideo)) {
    sourceUrl = brandedLocalVideo;
    isLocalBranded = true;
    console.log('Source: Local Branded Video detected (Zero CPU Mode)');
  } else if (fs.existsSync(playlistFile)) {
    const lines = fs.readFileSync(playlistFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    if (lines.length > 0) {
      sourceUrl = parseDirectUrl(lines[0]);
      if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
        sourceUrl = path.join(__dirname, sourceUrl);
      }
    }
  }

  if (!sourceUrl) {
    console.error('No video source found! Retrying in 5 seconds...');
    setTimeout(startStream, 5000);
    return;
  }

  console.log('Final Source Stream:', sourceUrl);

  let ffmpegArgs = [];

  // ভিডিও যদি অলরেডি ব্র্যান্ডেড লোকাল ফাইল অথবা .m3u8 হয়:
  // কোনো রিকোডিং হবে না, CPU ব্যবহার হবে ০%, ইনস্ট্যান্ট প্লেব্যাক
  if (isLocalBranded || sourceUrl.includes('.m3u8')) {
    ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
      '-i', sourceUrl,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments',
      path.join(liveDir, 'stream.m3u8')
    ];
  } 
  // গুগল ড্রাইভ বা অন্য রিমোট সোর্সের ক্ষেত্রে লাইটওয়েট হ্যান্ডলিং (নো হেভি ফিল্টার)
  else {
    ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      '-i', sourceUrl,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '800k',
      '-maxrate', '1000k',
      '-bufsize', '1500k',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments',
      path.join(liveDir, 'stream.m3u8')
    ];
  }

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', (code) => {
    console.log(`Stream stopped (${code}). Auto-restarting in 2s...`);
    setTimeout(startStream, 2000);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startStream();
});
