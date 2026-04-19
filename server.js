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
//  Temp Directory Management
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
        try {
            if (file && fs.existsSync(file)) fs.unlinkSync(file);
        } catch (err) {
            console.warn('Cleanup error:', err.message);
        }
    }
}

// Clean files matching a pattern (for yt-dlp which may create multiple files)
function cleanupPattern(baseName) {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const file of files) {
            if (file.startsWith(baseName)) {
                try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch {}
            }
        }
    } catch {}
}

// Periodically clean old temp files
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
//  URL Detection
// ─────────────────────────────────────────────
function isSupportedBySite(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url);
}

// ─────────────────────────────────────────────
//  Download with yt-dlp
//  Downloads audio and returns the actual file path
// ─────────────────────────────────────────────
function downloadWithYtDlp(url, jobId) {
    return new Promise((resolve, reject) => {
        // Use %(ext)s so yt-dlp controls the extension
        const outputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

        const args = [
            '--no-check-certificates',
            '--no-playlist',
            '-f', 'bestaudio/best',         // Download best audio stream directly
            '--ffmpeg-location', path.dirname(ffmpegPath), // Tell yt-dlp where ffmpeg is
            '-o', outputTemplate,
            '--no-warnings',
            '--no-simulate',
            '--print', 'after_move:filepath', // Print the actual output file path
            url
        ];

        console.log(`📥 yt-dlp downloading: ${url}`);
        console.log(`   args: ${args.join(' ')}`);

        execFile(YT_DLP_PATH, args, {
            timeout: 180000, // 3 minute timeout
            maxBuffer: 50 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('yt-dlp error:', error.message);
                if (stderr) console.error('yt-dlp stderr:', stderr);
                return reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
            }

            if (stdout) console.log('yt-dlp stdout:', stdout.trim());
            if (stderr) console.log('yt-dlp stderr:', stderr.trim());

            // Method 1: Use the printed filepath from --print
            const printedPath = stdout.trim().split('\n').filter(l => l.trim()).pop();
            if (printedPath && fs.existsSync(printedPath)) {
                const size = fs.statSync(printedPath).size;
                console.log(`   ✅ Found via --print: ${printedPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
                return resolve(printedPath);
            }

            // Method 2: Scan temp dir for files matching our jobId
            const files = fs.readdirSync(TEMP_DIR)
                .filter(f => f.startsWith(jobId))
                .map(f => path.join(TEMP_DIR, f))
                .filter(f => {
                    try { return fs.statSync(f).size > 0; }
                    catch { return false; }
                });

            if (files.length > 0) {
                // Pick the largest file (most likely the actual audio)
                files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
                const found = files[0];
                const size = fs.statSync(found).size;
                console.log(`   ✅ Found via scan: ${found} (${(size / 1024 / 1024).toFixed(2)} MB)`);
                return resolve(found);
            }

            reject(new Error('yt-dlp completed but no output file found'));
        });
    });
}

// ─────────────────────────────────────────────
//  Direct Download
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

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
        try {
            return await downloadWithYtDlp(url, jobId);
        } catch (err) {
            console.warn(`⚠️ yt-dlp failed: ${err.message}`);
            console.warn('   Falling back to direct download...');
        }
    }

    // Direct download fallback
    const outputPath = path.join(TEMP_DIR, `${jobId}.input`);
    await downloadFile(url, outputPath);
    return outputPath;
}

// ─────────────────────────────────────────────
//  FFmpeg Conversion
// ─────────────────────────────────────────────
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting to WAV: ${path.basename(inputPath)}`);

        ffmpeg(inputPath)
            .audioChannels(2)
            .audioFrequency(44100)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('start', () => console.log('   FFmpeg started...'))
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
//  API ENDPOINTS
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Velo Audio Server is running',
        version: '1.2.0'
    });
});

// GET /api/audio/convert → Raw WAV binary
app.get('/api/audio/convert', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL parameter is required.' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎵 Audio Convert | Job: ${jobId}`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    try {
        // Download
        downloadedPath = await smartDownload(url, jobId);

        // Convert to WAV
        await convertToWav(downloadedPath, wavPath);

        // Send
        const wavBuffer = fs.readFileSync(wavPath);
        console.log(`📤 Sending WAV: ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.send(wavBuffer);

    } catch (err) {
        console.error(`❌ Error: ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath, wavPath);
        cleanupPattern(jobId);
    }
});

// GET /api/video/audio → JSON { success, audioData (base64), metadata }
app.get('/api/video/audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL parameter is required.' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎬 Video Audio Extract | Job: ${jobId}`);
    console.log(`   URL: ${url}`);
    console.log(`${'═'.repeat(50)}`);

    try {
        // Download
        downloadedPath = await smartDownload(url, jobId);

        // Convert to WAV
        await convertToWav(downloadedPath, wavPath);

        // Metadata
        const metadata = await getMetadata(wavPath);

        // Base64 encode
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
        console.error(`❌ Error: ${err.message}\n`);
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

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Velo Audio Server v1.2                ║');
    console.log(`║   Port: ${PORT}                             ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   /api/audio/convert  (URL → WAV)       ║');
    console.log('║   /api/video/audio    (Video → Audio)   ║');
    console.log('║   /api/audio/info     (Metadata)        ║');
    console.log('║   GÜNCEL SİSTEM V2                      ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`   ffmpeg: ${ffmpegPath}`);
    console.log(`   yt-dlp: ${YT_DLP_PATH}`);
    console.log('');
});
