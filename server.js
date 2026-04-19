const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─────────────────────────────────────────────
//  FFmpeg Configuration
// ─────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (Roblox HttpService doesn't need it, but useful for browser testing)
app.use(cors());

// ─────────────────────────────────────────────
//  Temp Directory Management
// ─────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'velo-audio');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateTempPath(ext) {
    return path.join(TEMP_DIR, `${crypto.randomUUID()}.${ext}`);
}

function cleanup(...files) {
    for (const file of files) {
        try {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (err) {
            console.warn('Cleanup error:', err.message);
        }
    }
}

// Periodically clean old temp files (older than 10 minutes)
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > 10 * 60 * 1000) {
                fs.unlinkSync(filePath);
            }
        }
    } catch {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  URL Detection Helpers
// ─────────────────────────────────────────────
function isYouTube(url) {
    return /youtube\.com|youtu\.be/i.test(url);
}

function isInstagram(url) {
    return /instagram\.com/i.test(url);
}

function isDirectAudioFile(url) {
    return /\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)(\?|$)/i.test(url);
}

function isDirectVideoFile(url) {
    return /\.(mp4|avi|mov|mkv|webm|flv)(\?|$)/i.test(url);
}

// ─────────────────────────────────────────────
//  Download Functions
// ─────────────────────────────────────────────

// Download a file from a direct URL
async function downloadFile(url, outputPath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 120000, // 2 minute timeout
        maxContentLength: 100 * 1024 * 1024, // 100MB max
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

// Download audio from YouTube
async function downloadYouTube(url, outputPath) {
    return new Promise((resolve, reject) => {
        try {
            const stream = ytdl(url, {
                filter: 'audioonly',
                quality: 'highestaudio'
            });

            const writer = fs.createWriteStream(outputPath);
            stream.pipe(writer);

            writer.on('finish', resolve);
            writer.on('error', reject);
            stream.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

// Smart download - picks the right method based on URL
async function smartDownload(url, outputPath) {
    console.log(`📥 Downloading: ${url}`);

    if (isYouTube(url)) {
        console.log('   → YouTube detected, using ytdl-core');
        await downloadYouTube(url, outputPath);
    } else {
        console.log('   → Direct download');
        await downloadFile(url, outputPath);
    }

    // Verify file was downloaded
    if (!fs.existsSync(outputPath)) {
        throw new Error('Download failed - no file created');
    }

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
        throw new Error('Download failed - empty file');
    }

    console.log(`   ✅ Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

// ─────────────────────────────────────────────
//  FFmpeg Conversion
// ─────────────────────────────────────────────

// Convert any audio/video file to WAV format
function convertToWav(inputPath, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath)
            .audioChannels(options.channels || 2)
            .audioFrequency(options.sampleRate || 44100)
            .audioCodec('pcm_s16le')
            .format('wav');

        // Set timeout to prevent hanging
        command.on('start', (cmd) => {
            console.log(`🔄 FFmpeg started: ${cmd}`);
        });

        command.on('progress', (progress) => {
            if (progress.percent) {
                console.log(`   ⏳ Progress: ${Math.round(progress.percent)}%`);
            }
        });

        command.on('end', () => {
            console.log('   ✅ Conversion complete');
            resolve();
        });

        command.on('error', (err) => {
            console.error('   ❌ FFmpeg error:', err.message);
            reject(err);
        });

        command.save(outputPath);
    });
}

// Get metadata (duration, sample rate, channels) from an audio/video file
function getMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);

            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            resolve({
                duration: parseFloat(metadata.format.duration) || 0,
                sampleRate: parseInt(audioStream?.sample_rate) || 44100,
                channels: parseInt(audioStream?.channels) || 2,
                codec: audioStream?.codec_name || 'unknown',
                bitrate: parseInt(metadata.format.bit_rate) || 0
            });
        });
    });
}

// ─────────────────────────────────────────────
//  API ENDPOINTS
// ─────────────────────────────────────────────

// Health check / root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: '🎵 Velo Audio Server is running',
        version: '1.0.0',
        endpoints: {
            '/api/audio/convert': 'Convert audio file to WAV (returns raw binary)',
            '/api/video/audio': 'Extract audio from video (returns JSON with base64)'
        }
    });
});

// ─────────────────────────────────────────────
//  GET /api/audio/convert
//  Converts any audio file URL to WAV format
//  Returns: Raw WAV binary data
// ─────────────────────────────────────────────
app.get('/api/audio/convert', async (req, res) => {
    const { url, audioFormat } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL parameter is required. Usage: /api/audio/convert?url=<audio_url>&audioFormat=wav'
        });
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎵 Audio Convert Request`);
    console.log(`   URL: ${url}`);
    console.log(`   Format: ${audioFormat || 'wav'}`);
    console.log(`${'═'.repeat(50)}`);

    const inputPath = generateTempPath('input');
    const outputPath = generateTempPath('wav');

    try {
        // Step 1: Download the source audio
        await smartDownload(url, inputPath);

        // Step 2: Convert to WAV
        await convertToWav(inputPath, outputPath);

        // Step 3: Send raw WAV binary
        const wavBuffer = fs.readFileSync(outputPath);

        console.log(`📤 Sending WAV: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.set('Content-Disposition', 'attachment; filename="audio.wav"');
        res.send(wavBuffer);

    } catch (err) {
        console.error('❌ Audio convert error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    } finally {
        cleanup(inputPath, outputPath);
    }
});

// ─────────────────────────────────────────────
//  GET /api/video/audio
//  Extracts audio from video URL
//  Returns: JSON { success, audioData (base64), metadata }
// ─────────────────────────────────────────────
app.get('/api/video/audio', async (req, res) => {
    const { url, audioFormat } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL parameter is required. Usage: /api/video/audio?url=<video_url>&audioFormat=wav'
        });
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎬 Video Audio Extract Request`);
    console.log(`   URL: ${url}`);
    console.log(`   Format: ${audioFormat || 'wav'}`);
    console.log(`${'═'.repeat(50)}`);

    const inputPath = generateTempPath('input');
    const outputPath = generateTempPath('wav');

    try {
        // Step 1: Download the source video/audio
        await smartDownload(url, inputPath);

        // Step 2: Convert to WAV
        await convertToWav(inputPath, outputPath);

        // Step 3: Get metadata
        const metadata = await getMetadata(outputPath);

        // Step 4: Read and base64 encode
        const wavBuffer = fs.readFileSync(outputPath);
        const base64Data = wavBuffer.toString('base64');

        console.log(`📤 Sending base64 audio: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        res.json({
            success: true,
            audioData: base64Data,
            metadata: {
                duration: metadata.duration,
                sampleRate: metadata.sampleRate,
                channels: metadata.channels,
                codec: metadata.codec,
                bitrate: metadata.bitrate,
                fileSizeBytes: wavBuffer.length
            }
        });

    } catch (err) {
        console.error('❌ Video audio extract error:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    } finally {
        cleanup(inputPath, outputPath);
    }
});

// ─────────────────────────────────────────────
//  GET /api/audio/info
//  Get metadata about an audio/video file
//  Returns: JSON with file metadata
// ─────────────────────────────────────────────
app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL parameter is required.'
        });
    }

    const inputPath = generateTempPath('input');

    try {
        await smartDownload(url, inputPath);
        const metadata = await getMetadata(inputPath);

        res.json({
            success: true,
            metadata: metadata
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    } finally {
        cleanup(inputPath);
    }
});

// ─────────────────────────────────────────────
//  Error handling
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `Endpoint not found: ${req.method} ${req.path}`,
        availableEndpoints: [
            'GET /api/audio/convert?url=<url>&audioFormat=wav',
            'GET /api/video/audio?url=<url>&audioFormat=wav',
            'GET /api/audio/info?url=<url>'
        ]
    });
});

// ─────────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   🎵 Velo Audio Server                  ║');
    console.log(`║   🌐 Running on port ${PORT}              ║`);
    console.log('║   📡 Ready to accept requests           ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   Endpoints:                            ║');
    console.log('║   • /api/audio/convert  (URL → WAV)     ║');
    console.log('║   • /api/video/audio   (Video → Audio)  ║');
    console.log('║   • /api/audio/info    (Get metadata)   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
