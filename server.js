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
//  FFmpeg
// ─────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ─────────────────────────────────────────────
//  yt-dlp path
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
//  Temp directory
// ─────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'velo-audio');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateId() { return crypto.randomUUID(); }

function cleanup(...files) {
    for (const file of files) {
        try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    }
}

function cleanupPattern(jobId) {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
            if (f.startsWith(jobId)) {
                try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
            }
        }
    } catch {}
}

// Auto-clean
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        for (const f of files) {
            const fp = path.join(TEMP_DIR, f);
            try { if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp); } catch {}
        }
    } catch {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  URL Detection
// ─────────────────────────────────────────────
function isYouTube(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url);
}

function isPlatformUrl(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url);
}

function extractYouTubeId(url) {
    const match = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

// ─────────────────────────────────────────────
//  STRATEGY 1: Cobalt API (free, no cookies)
//  Supports YouTube, Instagram, TikTok, etc.
// ─────────────────────────────────────────────
const COBALT_APIS = [
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekmiki.com',
    'https://cobalt.api.timelessnesses.me'
];

async function downloadWithCobalt(url, outputPath) {
    let lastError = null;

    for (const apiBase of COBALT_APIS) {
        try {
            console.log(`   🔷 Trying Cobalt: ${apiBase}`);

            const response = await axios.post(apiBase, {
                url: url,
                downloadMode: 'audio',
                audioFormat: 'best'
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            });

            const data = response.data;

            if (data.status === 'error') {
                throw new Error(`Cobalt error: ${data.error?.code || JSON.stringify(data.error)}`);
            }

            let downloadUrl = null;

            if (data.status === 'redirect' || data.status === 'stream' || data.status === 'tunnel') {
                downloadUrl = data.url;
            } else if (data.url) {
                downloadUrl = data.url;
            }

            if (!downloadUrl) {
                throw new Error(`Unknown cobalt response: ${JSON.stringify(data)}`);
            }

            console.log(`   📥 Cobalt gave download URL, downloading...`);

            // Download the audio from cobalt's URL
            const audioResponse = await axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: 200 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const writer = fs.createWriteStream(outputPath);
            audioResponse.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const size = fs.statSync(outputPath).size;
            if (size < 1000) {
                throw new Error(`Download too small (${size} bytes), probably not audio`);
            }

            console.log(`   ✅ Cobalt success: ${(size / 1024 / 1024).toFixed(2)} MB`);
            return outputPath;

        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️ Cobalt ${apiBase} failed: ${err.message}`);
        }
    }

    throw new Error(`All Cobalt APIs failed. Last error: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  STRATEGY 2: Invidious API (YouTube only)
// ─────────────────────────────────────────────
const INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://invidious.jing.rocks',
    'https://yewtu.be'
];

async function downloadWithInvidious(url, outputPath) {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('Could not extract YouTube video ID');

    let lastError = null;

    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            console.log(`   🔶 Trying Invidious: ${instance}`);

            const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const data = response.data;

            // Find best audio stream from adaptiveFormats
            const audioFormats = (data.adaptiveFormats || [])
                .filter(f => f.type && f.type.startsWith('audio/'))
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

            if (audioFormats.length === 0) {
                throw new Error('No audio streams found');
            }

            const bestAudio = audioFormats[0];
            const audioUrl = bestAudio.url;

            if (!audioUrl) throw new Error('No download URL in audio stream');

            console.log(`   📥 Invidious: downloading ${bestAudio.type} (${bestAudio.bitrate || '?'} bps)`);

            // Download the audio stream
            const audioResponse = await axios({
                method: 'GET',
                url: audioUrl,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: 200 * 1024 * 1024
            });

            const writer = fs.createWriteStream(outputPath);
            audioResponse.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const size = fs.statSync(outputPath).size;
            if (size < 1000) {
                throw new Error(`Download too small (${size} bytes)`);
            }

            console.log(`   ✅ Invidious success: ${(size / 1024 / 1024).toFixed(2)} MB`);
            return outputPath;

        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️ Invidious ${instance} failed: ${err.message}`);
        }
    }

    throw new Error(`All Invidious instances failed. Last error: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  STRATEGY 3: yt-dlp (fallback)
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
            '--extractor-args', 'youtube:player_client=web',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            '--no-cache-dir',
            url
        ];

        console.log(`   🔧 yt-dlp downloading...`);

        execFile(YT_DLP_PATH, args, {
            timeout: 180000,
            maxBuffer: 50 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (stdout) console.log('   yt-dlp:', stdout.trim());
            if (stderr) console.log('   yt-dlp err:', stderr.trim());

            if (error) {
                return reject(new Error(`yt-dlp: ${stderr || error.message}`));
            }

            const files = fs.readdirSync(TEMP_DIR)
                .filter(f => f.startsWith(jobId))
                .map(f => path.join(TEMP_DIR, f))
                .filter(f => { try { return fs.statSync(f).size > 0; } catch { return false; } });

            if (files.length === 0) {
                return reject(new Error('yt-dlp: no output file'));
            }

            files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
            console.log(`   ✅ yt-dlp: ${path.basename(files[0])}`);
            resolve(files[0]);
        });
    });
}

// ─────────────────────────────────────────────
//  STRATEGY 4: Direct download
// ─────────────────────────────────────────────
async function downloadFile(url, outputPath) {
    console.log(`   📥 Direct download: ${url}`);

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
        throw new Error('URL returned HTML, not audio');
    }

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    const size = fs.statSync(outputPath).size;
    console.log(`   ✅ Direct: ${(size / 1024 / 1024).toFixed(2)} MB`);
    return outputPath;
}

// ─────────────────────────────────────────────
//  SMART DOWNLOAD - tries all strategies
// ─────────────────────────────────────────────
async function smartDownload(url, jobId) {
    const outputPath = path.join(TEMP_DIR, `${jobId}.audio`);
    const errors = [];

    if (isPlatformUrl(url)) {
        // Strategy 1: Cobalt API (best for YouTube, Instagram, TikTok)
        try {
            console.log('🔷 Strategy 1: Cobalt API');
            return await downloadWithCobalt(url, outputPath);
        } catch (err) {
            errors.push(`Cobalt: ${err.message}`);
            console.warn(`   ❌ Cobalt failed\n`);
        }

        // Strategy 2: Invidious (YouTube only)
        if (isYouTube(url)) {
            try {
                console.log('🔶 Strategy 2: Invidious API');
                return await downloadWithInvidious(url, outputPath);
            } catch (err) {
                errors.push(`Invidious: ${err.message}`);
                console.warn(`   ❌ Invidious failed\n`);
            }
        }

        // Strategy 3: yt-dlp (last resort)
        try {
            console.log('🔧 Strategy 3: yt-dlp');
            return await downloadWithYtDlp(url, jobId);
        } catch (err) {
            errors.push(`yt-dlp: ${err.message}`);
            console.warn(`   ❌ yt-dlp failed\n`);
        }

        throw new Error(`All download strategies failed:\n${errors.join('\n')}`);
    }

    // Regular URL: direct download
    console.log('📥 Direct download');
    return await downloadFile(url, outputPath);
}

// ─────────────────────────────────────────────
//  FFmpeg
// ─────────────────────────────────────────────
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting to WAV...`);
        ffmpeg(inputPath)
            .audioChannels(2)
            .audioFrequency(44100)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('end', () => {
                const size = fs.statSync(outputPath).size;
                console.log(`   ✅ WAV: ${(size / 1024 / 1024).toFixed(2)} MB`);
                resolve();
            })
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

function getMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const a = metadata.streams.find(s => s.codec_type === 'audio');
            resolve({
                duration: parseFloat(metadata.format.duration) || 0,
                sampleRate: parseInt(a?.sample_rate) || 44100,
                channels: parseInt(a?.channels) || 2,
                codec: a?.codec_name || 'unknown',
                bitrate: parseInt(metadata.format.bit_rate) || 0
            });
        });
    });
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Velo Audio Server v2.0' });
});

// Convert → raw WAV binary
app.get('/api/audio/convert', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎵 CONVERT | ${jobId.slice(0, 8)}`);
    console.log(`   ${url}`);
    console.log(`${'═'.repeat(60)}`);

    try {
        downloadedPath = await smartDownload(url, jobId);
        await convertToWav(downloadedPath, wavPath);

        const wavBuffer = fs.readFileSync(wavPath);
        console.log(`📤 Sending ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB\n`);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', wavBuffer.length);
        res.send(wavBuffer);
    } catch (err) {
        console.error(`❌ ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath, wavPath);
        cleanupPattern(jobId);
    }
});

// Video audio extract → JSON base64
app.get('/api/video/audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let downloadedPath = null;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎬 VIDEO AUDIO | ${jobId.slice(0, 8)}`);
    console.log(`   ${url}`);
    console.log(`${'═'.repeat(60)}`);

    try {
        downloadedPath = await smartDownload(url, jobId);
        await convertToWav(downloadedPath, wavPath);

        const metadata = await getMetadata(wavPath);
        const wavBuffer = fs.readFileSync(wavPath);
        const base64Data = wavBuffer.toString('base64');

        console.log(`📤 Sending ${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB base64\n`);

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
        console.error(`❌ ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(downloadedPath, wavPath);
        cleanupPattern(jobId);
    }
});

// Metadata
app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

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

// Debug
app.get('/api/debug', (req, res) => {
    execFile(YT_DLP_PATH, ['--version'], { timeout: 5000 }, (error, stdout) => {
        res.json({
            version: '2.0',
            ytdlp: { path: YT_DLP_PATH, exists: fs.existsSync(YT_DLP_PATH), version: stdout?.trim() || 'N/A' },
            ffmpeg: { path: ffmpegPath, exists: fs.existsSync(ffmpegPath) },
            cobalt: COBALT_APIS,
            invidious: INVIDIOUS_INSTANCES
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
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Velo Audio Server v2.0                ║');
    console.log(`║   Port: ${PORT}                             ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   Download strategies:                   ║');
    console.log('║   1. Cobalt API (YouTube/Insta/TikTok)  ║');
    console.log('║   2. Invidious API (YouTube fallback)   ║');
    console.log('║   3. yt-dlp (last resort)               ║');
    console.log('║   4. Direct download (regular URLs)s    ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`   ffmpeg:  ${ffmpegPath}`);
    console.log(`   yt-dlp:  ${YT_DLP_PATH}`);
    console.log('');
});
