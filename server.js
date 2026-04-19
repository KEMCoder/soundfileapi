const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

// ─────────────────────────────────────────────
//  FFmpeg Configuration
// ─────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors());

// ─────────────────────────────────────────────
//  yt-dlp Binary Path
// ─────────────────────────────────────────────
// yt-dlp is downloaded during build step on Render
// Locally on Windows, it looks for yt-dlp.exe in PATH or project root
function getYtDlpPath() {
    // Check project root first (Render deployment)
    const localPath = path.join(__dirname, 'yt-dlp');
    if (fs.existsSync(localPath)) return localPath;

    // Windows: check for .exe
    const winPath = path.join(__dirname, 'yt-dlp.exe');
    if (fs.existsSync(winPath)) return winPath;

    // Fallback to system PATH
    return 'yt-dlp';
}

const YT_DLP_PATH = getYtDlpPath();
console.log(`yt-dlp path: ${YT_DLP_PATH}`);

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
    return /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url);
}

function isInstagram(url) {
    return /instagram\.com/i.test(url);
}

function isSupportedBySite(url) {
    // URLs that yt-dlp can handle (video/social media platforms)
    return isYouTube(url) || isInstagram(url) ||
        /tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url);
}

// ─────────────────────────────────────────────
//  Download Functions
// ─────────────────────────────────────────────

// Download using yt-dlp (YouTube, Instagram, TikTok, etc.)
function downloadWithYtDlp(url, outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '--no-check-certificates',
            '--no-playlist',           // Single video only
            '-x',                       // Extract audio
            '--audio-format', 'wav',    // Convert to WAV
            '--audio-quality', '0',     // Best quality
            '-o', outputPath,           // Output path
            '--no-warnings',
            '--prefer-free-formats',
            url
        ];

        console.log(`📥 yt-dlp downloading: ${url}`);

        execFile(YT_DLP_PATH, args, {
            timeout: 120000, // 2 minute timeout
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('yt-dlp error:', error.message);
                console.error('yt-dlp stderr:', stderr);
                return reject(new Error(`yt-dlp failed: ${error.message}`));
            }

            console.log('yt-dlp stdout:', stdout);

            // yt-dlp might change the extension, find the actual file
            const dir = path.dirname(outputPath);
            const baseName = path.basename(outputPath, path.extname(outputPath));

            // Look for the output file (yt-dlp may add different extension)
            const possibleExts = ['.wav', '.opus', '.webm', '.m4a', '.mp3', '.ogg'];
            let foundFile = null;

            if (fs.existsSync(outputPath)) {
                foundFile = outputPath;
            } else {
                for (const ext of possibleExts) {
                    const tryPath = path.join(dir, baseName + ext);
                    if (fs.existsSync(tryPath)) {
                        foundFile = tryPath;
                        break;
                    }
                }
            }

            if (!foundFile) {
                // Try to find any recently created file in temp dir
                const files = fs.readdirSync(dir)
                    .filter(f => f.startsWith(baseName))
                    .map(f => path.join(dir, f));

                if (files.length > 0) {
                    foundFile = files[0];
                }
            }

            if (!foundFile || !fs.existsSync(foundFile)) {
                return reject(new Error('yt-dlp completed but output file not found'));
            }

            // If the found file isn't the expected path, rename it
            if (foundFile !== outputPath) {
                try {
                    fs.renameSync(foundFile, outputPath);
                } catch {
                    // If rename fails, copy instead
                    fs.copyFileSync(foundFile, outputPath);
                    try { fs.unlinkSync(foundFile); } catch {}
                }
            }

            console.log(`   ✅ yt-dlp download complete`);
            resolve();
        });
    });
}

// Download a file from a direct URL
async function downloadFile(url, outputPath) {
    console.log(`📥 Direct downloading: ${url}`);

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            console.log(`   ✅ Direct download complete`);
            resolve();
        });
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

// Smart download - picks the right method based on URL
async function smartDownload(url, outputPath) {
    if (isSupportedBySite(url)) {
        // Use yt-dlp for video/social platforms
        try {
            await downloadWithYtDlp(url, outputPath);
            return;
        } catch (err) {
            console.warn(`⚠️ yt-dlp failed, trying direct download: ${err.message}`);
            // Fall through to direct download
        }
    }

    // Direct download for regular URLs
    await downloadFile(url, outputPath);

    // Verify file was downloaded
    if (!fs.existsSync(outputPath)) {
        throw new Error('Download failed - no file created');
    }

    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
        throw new Error('Download failed - empty file');
    }

    console.log(`   📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
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

        command.on('start', (cmd) => {
            console.log(`🔄 FFmpeg converting...`);
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

// Get metadata from an audio/video file
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

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Velo Audio Server is running',
        version: '1.1.0',
        endpoints: {
            '/api/audio/convert': 'Convert audio file to WAV (returns raw binary)',
            '/api/video/audio': 'Extract audio from video (returns JSON with base64)',
            '/api/audio/info': 'Get audio file metadata'
        }
    });
});

// ─────────────────────────────────────────────
//  GET /api/audio/convert
//  Returns: Raw WAV binary data
// ─────────────────────────────────────────────
app.get('/api/audio/convert', async (req, res) => {
    const { url, audioFormat } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL parameter is required.'
        });
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎵 Audio Convert Request`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    const inputPath = generateTempPath('input');
    const outputPath = generateTempPath('wav');

    try {
        await smartDownload(url, inputPath);
        await convertToWav(inputPath, outputPath);

        const wavBuffer = fs.readFileSync(outputPath);
        console.log(`📤 Sending WAV: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.send(wavBuffer);

    } catch (err) {
        console.error('❌ Audio convert error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(inputPath, outputPath);
    }
});

// ─────────────────────────────────────────────
//  GET /api/video/audio
//  Returns: JSON { success, audioData (base64), metadata }
// ─────────────────────────────────────────────
app.get('/api/video/audio', async (req, res) => {
    const { url, audioFormat } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL parameter is required.'
        });
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎬 Video Audio Extract Request`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    const inputPath = generateTempPath('input');
    const outputPath = generateTempPath('wav');

    try {
        await smartDownload(url, inputPath);
        await convertToWav(inputPath, outputPath);

        const metadata = await getMetadata(outputPath);
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
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(inputPath, outputPath);
    }
});

// ─────────────────────────────────────────────
//  GET /api/audio/info
// ─────────────────────────────────────────────
app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL parameter is required.' });
    }

    const inputPath = generateTempPath('input');

    try {
        await smartDownload(url, inputPath);
        const metadata = await getMetadata(inputPath);
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(inputPath);
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `Endpoint not found: ${req.method} ${req.path}`
    });
});

// ─────────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Velo Audio Server v1.1                ║');
    console.log(`║   Running on port ${PORT}                  ║`);
    console.log('║   Ready to accept requests              ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   Endpoints:                            ║');
    console.log('║   • /api/audio/convert  (URL → WAV)     ║');
    console.log('║   • /api/video/audio   (Video → Audio)  ║');
    console.log('║   • /api/audio/info    (Get metadata)   ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
