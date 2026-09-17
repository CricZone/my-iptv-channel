#!/bin/bash

# ফোল্ডার তৈরি
mkdir -p live

# FFmpeg কমান্ড: নন-স্টপ লুপ, ওয়াটারমার্ক লোগো এবং নিচের স্ক্রোলিং টেক্সট
ffmpeg -re -stream_loop -1 -f concat -safe 0 -i <(sed 's/^/file /' playlist.txt) \
-vf "drawtext=text='BDStreamHub TV':x=w-tw-30:y=30:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=5, \
drawtext=text='Welcome to BDStreamHub - Watch Live Sports, Movies and Entertainment Non-Stop!':x=w-mod(max(t\,0)*120\,w+tw):y=h-40:fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=8" \
-c:v libx264 -preset veryfast -b:v 1500k -maxrate 1800k -bufsize 3000k \
-c:a aac -b:a 128k -ar 44100 \
-f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments live/stream.m3u8
