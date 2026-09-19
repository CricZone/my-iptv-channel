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
const concatFile = path.join(liveDir, 'concat.txt');
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
// ==================================================

function cleanLiveFiles() {
    try {
        const files = fs.readdirSync(liveDir);

        for (const file of files) {

            if (
                file.endsWith('.ts') ||
                file.endsWith('.m3u8') ||
                file.endsWith('.tmp') ||
                file === 'concat.txt'
            ) {
                try {
                    fs.unlinkSync(
                        path.join(liveDir, file)
                    );
                } catch (err) {}
            }
        }

        console.log('Old HLS files cleaned.');

    } catch (err) {
        console.log(
            'Cleanup error:',
            err.message
        );
    }
}

cleanLiveFiles();

// ==================================================
// HLS SERVER
// ==================================================

app.use(
    '/live',
    express.static(liveDir, {

        etag: false,

        setHeaders: (res, filePath) => {

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
                    'public, max-age=5'
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
        'BDStreamHub Continuous HLS Server Running!'
    );

});

// ==================================================
// READ PLAYLIST
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
// ESCAPE CONCAT URL
// ==================================================

function escapeConcatUrl(url) {

    return url
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''");
}

// ==================================================
// CREATE FFMPEG CONCAT FILE
// ==================================================

function createConcatFile() {

    const playlist = getPlaylist();

    if (playlist.length === 0) {

        console.log(
            'playlist.txt is empty.'
        );

        return false;
    }

    let content = '';

    for (const url of playlist) {

        content +=
            `file '${escapeConcatUrl(url)}'\n`;
    }

    // Loop back to first video
    for (const url of playlist) {

        content +=
            `file '${escapeConcatUrl(url)}'\n`;
    }

    try {

        fs.writeFileSync(
            concatFile,
            content,
            'utf8'
        );

        console.log(
            `Concat playlist created: ${playlist.length} videos`
        );

        return true;

    } catch (err) {

        console.log(
            'Concat file error:',
            err.message
        );

        return false;
    }
}

// ==================================================
// STATE
// ==================================================

let ffmpegProcess = null;
let stopping = false;

// ==================================================
// START CONTINUOUS FFMPEG
// ==================================================

function startStream() {

    if (
        ffmpegProcess ||
        stopping
    ) {
        return;
    }

    // ------------------------------------------------
    // Create concat file
    // ------------------------------------------------

    if (!createConcatFile()) {

        setTimeout(
            startStream,
            3000
        );

        return;
    }

    console.log('');
    console.log(
        '=========================================='
    );

    console.log(
        '▶ Starting CONTINUOUS FFmpeg stream'
    );

    console.log(
        '▶ One FFmpeg process for entire playlist'
    );

    console.log(
        '=========================================='
    );

    // ==================================================
    // FFMPEG
    // ==================================================

    const ffmpegArgs = [

        // ------------------------------------------------
        // REAL-TIME
        // ------------------------------------------------

        '-re',

        // ------------------------------------------------
        // CONCAT INPUT
        // ------------------------------------------------

        '-protocol_whitelist',
        'file,http,https,tcp,tls,crypto',

        '-f',
        'concat',

        '-safe',
        '0',

        '-i',
        concatFile,

        // ==================================================
        // VIDEO
        // ==================================================

        '-c:v',
        'libx264',

        // FAST ENCODING
        '-preset',
        'ultrafast',

        '-tune',
        'zerolatency',

        '-pix_fmt',
        'yuv420p',

        // ------------------------------------------------
        // 30 FPS
        // ------------------------------------------------

        '-r',
        '30',

        // ------------------------------------------------
        // KEYFRAME EVERY 2 SECONDS
        // ------------------------------------------------

        '-g',
        '60',

        '-keyint_min',
        '60',

        '-sc_threshold',
        '0',

        // ------------------------------------------------
        // Force keyframes every 2 seconds
        // ------------------------------------------------

        '-force_key_frames',
        'expr:gte(t,n_forced*2)',

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

        // 2 second segment
        '-hls_time',
        '2',

        // Keep 6 segments
        '-hls_list_size',
        '6',

        // MPEGTS
        '-hls_segment_type',
        'mpegts',

        // ------------------------------------------------
        // Continuous HLS
        // ------------------------------------------------

        '-hls_flags',
        'delete_segments+independent_segments+program_date_time',

        // ------------------------------------------------
        // Old segment cleanup
        // ------------------------------------------------

        '-hls_delete_threshold',
        '1',

        // ------------------------------------------------
        // Segment names
        // ------------------------------------------------

        '-hls_segment_filename',
        path.join(
            liveDir,
            'segment_%06d.ts'
        ),

        // ------------------------------------------------
        // OUTPUT
        // ------------------------------------------------

        outputPlaylist
    ];

    // ==================================================
    // START FFMPEG
    // ==================================================

    ffmpegProcess = spawn(
        'ffmpeg',
        ffmpegArgs,
        {
            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]
        }
    );

    // ==================================================
    // FFmpeg normal output
    // ==================================================

    ffmpegProcess.stdout.on(
        'data',
        data => {

            console.log(
                data.toString()
            );

        }
    );

    // ==================================================
    // FFmpeg error/log
    // ==================================================

    ffmpegProcess.stderr.on(
        'data',
        data => {

            const message =
                data.toString();

            // Print FFmpeg information
            console.log(
                '[FFmpeg]',
                message.trim()
            );
        }
    );

    // ==================================================
    // ERROR
    // ==================================================

    ffmpegProcess.on(
        'error',
        err => {

            console.log('');
            console.log(
                '❌ FFmpeg ERROR:',
                err.message
            );

            ffmpegProcess = null;

            if (!stopping) {

                setTimeout(
                    startStream,
                    2000
                );
            }
        }
    );

    // ==================================================
    // CLOSE
    // ==================================================

    ffmpegProcess.on(
        'close',
        (code, signal) => {

            console.log('');
            console.log(
                `FFmpeg stopped | code=${code} | signal=${signal}`
            );

            ffmpegProcess = null;

            if (stopping) {
                return;
            }

            // Restart continuous stream
            setTimeout(
                startStream,
                2000
            );
        }
    );
}

// ==================================================
// START SERVER
// ==================================================

const server = app.listen(
    PORT,
    () => {

        console.log('');
        console.log(
            '=========================================='
        );

        console.log(
            'BDStreamHub Continuous Streaming V4'
        );

        console.log(
            '=========================================='
        );

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            'HLS: /live/stream.m3u8'
        );

        console.log(
            '=========================================='
        );

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
        'Stopping server...'
    );

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

    server.close(
        () => {

            console.log(
                'Server stopped.'
            );

            process.exit(0);
        }
    );

    setTimeout(
        () => {

            process.exit(0);

        },
        5000
    );
}

// ==================================================
// SHUTDOWN
// ==================================================

process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);
