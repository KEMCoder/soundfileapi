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
const { execFile } = require('child_process');

// ─────────────────────────────────────────────
//  FFmpeg Configuration
// ─────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─────────────────────────────────────────────
//  yt-dlp Binary Path
// ─────────────────────────────────────────────
function getYtDlpPath() {
    const localPath = path.join(__dirname, 'yt-dlp');
    if (fs.existsSync(localPath)) return localPath;
    const winPath = path.join(__dirname, 'yt-dlp.exe');
    if (fs.existsSync(winPath)) return winPath;
    return 'yt-dlp';
}

const YT_DLP_PATH = getYtDlpPath();

// ─────────────────────────────────────────────
//  Temp Directory
// ─────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'velo-audio');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateId() {
    return crypto.randomUUID();
}

function cleanup(...files) {
    for (const file of files) {
        try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    }
}

function cleanupPattern(jobId) {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const file of files) {
            if (file.startsWith(jobId)) {
                try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch {}
            }
        }
    } catch {}
}

// Auto-clean old files every 5 min
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        for (const file of files) {
            const fp = path.join(TEMP_DIR, file);
            try {
                if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
            } catch {}
        }
    } catch {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  URL Detection
// ─────────────────────────────────────────────
function isSupportedBySite(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url);
}

// ─────────────────────────────────────────────
//  yt-dlp Download
// ─────────────────────────────────────────────
function downloadWithYtDlp(url, jobId) {
    return new Promise((resolve, reject) => {
        const outputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

        const args = [
            '--no-check-certificates',
            '--no-playlist',
            '-f', 'bestaudio/best',
            '--ffmpeg-location', path.dirname(ffmpegPath),
            '-o', outputTemplate,
            '--no-warnings',
            // YouTube workarounds
            '--extractor-args', 'youtube:player_client=web',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            '--no-cache-dir',
            url
        ];

        console.log(`📥 yt-dlp downloading: ${url}`);

        execFile(YT_DLP_PATH, args, {
            timeout: 180000,
            maxBuffer: 50 * 1024 * 1024
        }, (error, stdout, stderr) => {
            // Log everything for debugging
            if (stdout) console.log('yt-dlp stdout:', stdout.trim());
            if (stderr) console.log('yt-dlp stderr:', stderr.trim());

            if (error) {
                console.error('yt-dlp error:', error.message);
                return reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
            }

            // Find the downloaded file by scanning for jobId in temp dir
            const files = fs.readdirSync(TEMP_DIR)
                .filter(f => f.startsWith(jobId))
                .map(f => path.join(TEMP_DIR, f))
                .filter(f => {
                    try { return fs.statSync(f).size > 0; }
                    catch { return false; }
                });

            if (files.length === 0) {
                return reject(new Error('yt-dlp completed but no output file found. Check logs above for details.'));
            }

            // Pick the largest file
            files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
            const found = files[0];
            const size = fs.statSync(found).size;
            console.log(`   ✅ Downloaded: ${path.basename(found)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
            resolve(found);
        });
    });
}

// ─────────────────────────────────────────────
//  Direct File Download
// ─────────────────────────────────────────────
async function downloadFile(url, outputPath) {
    console.log(`📥 Direct downloading: ${url}`);

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
    });

    // Check content type - reject HTML responses
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
        throw new Error('URL returned HTML instead of audio/video data. This URL cannot be downloaded directly.');
    }

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            const size = fs.statSync(outputPath).size;
            console.log(`   ✅ Downloaded: ${(size / 1024 / 1024).toFixed(2)} MB`);
            resolve(outputPath);
        });
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

// ─────────────────────────────────────────────
//  Smart Download
// ─────────────────────────────────────────────
async function smartDownload(url, jobId) {
    if (isSupportedBySite(url)) {
        // Platform URLs: ONLY use yt-dlp (direct download gives HTML)
        return await downloadWithYtDlp(url, jobId);
    }

    // Regular URLs: direct download
    const outputPath = path.join(TEMP_DIR, `${jobId}.input`);
    await downloadFile(url, outputPath);
    return outputPath;
}

// ─────────────────────────────────────────────
//  FFmpeg Convert to WAV
// ─────────────────────────────────────────────
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting: ${path.basename(inputPath)} → WAV`);

        ffmpeg(inputPath)
            .audioChannels(2)
            .audioFrequency(44100)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('end', () => {
                const size = fs.statSync(outputPath).size;
                console.log(`   ✅ WAV ready: ${(size / 1024 / 1024).toFixed(2)} MB`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`   ❌ FFmpeg error: ${err.message}`);
                reject(err);
            })
            .save(outputPath);
    });
}

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
//  ENDPOINTS
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Velo Audio Server v1.3' });
});

// GET /api/audio/convert → Raw WAV binary
app.get('/api/audio/convert', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL parameter is required.' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎵 CONVERT | ${jobId}`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    try {
        downloadedPath = await smartDownload(url, jobId);
        await convertToWav(downloadedPath, wavPath);

        const wavBuffer = fs.readFileSync(wavPath);
        console.log(`📤 Sending: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.send(wavBuffer);
    } catch (err) {
        console.error(`❌ FAILED: ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath, wavPath);
        cleanupPattern(jobId);
    }
});

// GET /api/video/audio → JSON with base64
app.get('/api/video/audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL parameter is required.' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎬 VIDEO AUDIO | ${jobId}`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    try {
        downloadedPath = await smartDownload(url, jobId);
        await convertToWav(downloadedPath, wavPath);

        const metadata = await getMetadata(wavPath);
        const wavBuffer = fs.readFileSync(wavPath);
        const base64Data = wavBuffer.toString('base64');

        console.log(`📤 Sending base64: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

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
        console.error(`❌ FAILED: ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath, wavPath);
        cleanupPattern(jobId);
    }
});

// GET /api/audio/info → metadata
app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL parameter is required.' });

    const jobId = generateId();
    let downloadedPath = null;

    try {
        downloadedPath = await smartDownload(url, jobId);
        const metadata = await getMetadata(downloadedPath);
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath);
        cleanupPattern(jobId);
    }
});

// Debug endpoint - check yt-dlp version
app.get('/api/debug', (req, res) => {
    execFile(YT_DLP_PATH, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
        res.json({
            ytdlp: {
                path: YT_DLP_PATH,
                exists: fs.existsSync(YT_DLP_PATH),
                version: stdout ? stdout.trim() : 'unknown',
                error: error ? error.message : null
            },
            ffmpeg: {
                path: ffmpegPath,
                exists: fs.existsSync(ffmpegPath)
            },
            ffprobe: {
                path: ffprobePath,
                exists: fs.existsSync(ffprobePath)
            }
        });
    });
});

// Error handlers
app.use((err, req, res, next) => {
    console.error('Unhandled:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});
app.use((req, res) => {
    res.status(404).json({ success: false, error: `Not found: ${req.path}` });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Velo Audio Server v1.3                ║');
    console.log(`║   Port: ${PORT}                             ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   /api/audio/convert  (URL → WAV)       ║');
    console.log('║   /api/video/audio    (Video → Audio)   ║');
    console.log('║   /api/audio/info     (Metadata)        ║');
    console.log('║   /api/debug          (System check) 2  ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`   ffmpeg:  ${ffmpegPath}`);
    console.log(`   ffprobe: ${ffprobePath}`);
    console.log(`   yt-dlp:  ${YT_DLP_PATH}`);
    console.log('');
});
