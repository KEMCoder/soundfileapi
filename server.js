const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const axios = require('axios');
const https = require('https');
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

// HTTPS agent that accepts any certificate (needed for some Cobalt instances)
const permissiveAgent = new https.Agent({ rejectUnauthorized: false });

// ─────────────────────────────────────────────
//  yt-dlp
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
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
}

function cleanupPattern(jobId) {
    try {
        for (const f of fs.readdirSync(TEMP_DIR)) {
            if (f.startsWith(jobId)) try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
        }
    } catch {}
}

setInterval(() => {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, f);
            try { if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp); } catch {}
        }
    } catch {}
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
//  URL helpers
// ─────────────────────────────────────────────
function isYouTube(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url);
}

function isPlatform(url) {
    return /youtube\.com|youtu\.be|music\.youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url);
}

function extractYouTubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

// ─────────────────────────────────────────────
//  STRATEGY 1: Cobalt API
//  Working instances from instances.cobalt.best
// ─────────────────────────────────────────────
const COBALT_INSTANCES = [
    'https://cobalt-api.meowing.de',     // 92% uptime
    'https://capi.3kh0.net',             // 80% uptime
    'https://kityune.imput.net',         // 76% (official)
    'https://nachos.imput.net',          // 76% (official)
    'https://sunny.imput.net',           // 76% (official)
    'https://blossom.imput.net',         // 68% (official)
];

async function downloadWithCobalt(url, outputPath) {
    let lastError = null;

    for (const api of COBALT_INSTANCES) {
        try {
            console.log(`   🔷 Cobalt: ${api}`);

            const res = await axios.post(api, {
                url: url,
                downloadMode: 'audio',
                audioFormat: 'best'
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000,
                httpsAgent: permissiveAgent
            });

            const data = res.data;

            if (data.status === 'error') {
                throw new Error(data.error?.code || JSON.stringify(data.error));
            }

            const downloadUrl = data.url;
            if (!downloadUrl) {
                throw new Error('No download URL in response');
            }

            console.log(`   📥 Downloading from Cobalt...`);

            const audioRes = await axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: 200 * 1024 * 1024,
                httpsAgent: permissiveAgent
            });

            const writer = fs.createWriteStream(outputPath);
            audioRes.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const size = fs.statSync(outputPath).size;
            if (size < 1000) throw new Error(`File too small: ${size} bytes`);

            console.log(`   ✅ Cobalt: ${(size / 1024 / 1024).toFixed(2)} MB`);
            return outputPath;

        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️ ${api}: ${err.message}`);
        }
    }

    throw new Error(`Cobalt failed: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  STRATEGY 2: Piped API (YouTube only)
// ─────────────────────────────────────────────
const PIPED_INSTANCES = [
    'https://api.piped.private.coffee',  // 100% uptime
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.r4fo.com',
    'https://piped-api.lunar.icu',
];

async function downloadWithPiped(url, outputPath) {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('No YouTube video ID found');

    let lastError = null;

    for (const api of PIPED_INSTANCES) {
        try {
            console.log(`   🟢 Piped: ${api}`);

            const res = await axios.get(`${api}/streams/${videoId}`, {
                timeout: 15000,
                httpsAgent: permissiveAgent
            });

            const streams = res.data.audioStreams;
            if (!streams || streams.length === 0) {
                throw new Error('No audio streams');
            }

            // Sort by bitrate, pick best
            streams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            const best = streams[0];

            console.log(`   📥 Piped: ${best.mimeType} @ ${best.bitrate} bps`);

            const audioRes = await axios({
                method: 'GET',
                url: best.url,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: 200 * 1024 * 1024,
                httpsAgent: permissiveAgent
            });

            const writer = fs.createWriteStream(outputPath);
            audioRes.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const size = fs.statSync(outputPath).size;
            if (size < 1000) throw new Error(`File too small: ${size} bytes`);

            console.log(`   ✅ Piped: ${(size / 1024 / 1024).toFixed(2)} MB`);
            return outputPath;

        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️ ${api}: ${err.message}`);
        }
    }

    throw new Error(`Piped failed: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  STRATEGY 3: Invidious API (YouTube only)
// ─────────────────────────────────────────────
const INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://invidious.jing.rocks',
];

async function downloadWithInvidious(url, outputPath) {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('No YouTube video ID');

    let lastError = null;

    for (const api of INVIDIOUS_INSTANCES) {
        try {
            console.log(`   🔶 Invidious: ${api}`);

            const res = await axios.get(`${api}/api/v1/videos/${videoId}`, {
                timeout: 15000,
                httpsAgent: permissiveAgent
            });

            const formats = (res.data.adaptiveFormats || [])
                .filter(f => f.type && f.type.startsWith('audio/'))
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

            if (formats.length === 0) throw new Error('No audio formats');

            const best = formats[0];
            if (!best.url) throw new Error('No URL in format');

            console.log(`   📥 Invidious: ${best.type}`);

            const audioRes = await axios({
                method: 'GET',
                url: best.url,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: 200 * 1024 * 1024,
                httpsAgent: permissiveAgent
            });

            const writer = fs.createWriteStream(outputPath);
            audioRes.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const size = fs.statSync(outputPath).size;
            if (size < 1000) throw new Error(`File too small: ${size} bytes`);

            console.log(`   ✅ Invidious: ${(size / 1024 / 1024).toFixed(2)} MB`);
            return outputPath;

        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️ ${api}: ${err.message}`);
        }
    }

    throw new Error(`Invidious failed: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  STRATEGY 4: yt-dlp (last resort)
// ─────────────────────────────────────────────
function downloadWithYtDlp(url, jobId) {
    return new Promise((resolve, reject) => {
        const tpl = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
        const args = [
            '--no-check-certificates', '--no-playlist',
            '-f', 'bestaudio/best',
            '--ffmpeg-location', path.dirname(ffmpegPath),
            '-o', tpl, '--no-warnings', '--no-cache-dir',
            '--extractor-args', 'youtube:player_client=web',
            url
        ];

        console.log(`   🔧 yt-dlp...`);
        execFile(YT_DLP_PATH, args, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (stdout) console.log('   yt-dlp:', stdout.trim());
            if (stderr) console.log('   yt-dlp err:', stderr.trim());
            if (err) return reject(new Error(`yt-dlp: ${stderr || err.message}`));

            const files = fs.readdirSync(TEMP_DIR)
                .filter(f => f.startsWith(jobId))
                .map(f => path.join(TEMP_DIR, f))
                .filter(f => { try { return fs.statSync(f).size > 0; } catch { return false; } });

            if (files.length === 0) return reject(new Error('yt-dlp: no output'));
            files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
            console.log(`   ✅ yt-dlp: ${path.basename(files[0])}`);
            resolve(files[0]);
        });
    });
}

// ─────────────────────────────────────────────
//  Direct download (regular URLs)
// ─────────────────────────────────────────────
async function downloadFile(url, outputPath) {
    console.log(`   📥 Direct: ${url}`);

    const res = await axios({
        method: 'GET', url, responseType: 'stream',
        timeout: 120000, maxContentLength: 100 * 1024 * 1024,
        httpsAgent: permissiveAgent,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/html')) throw new Error('URL returned HTML, not audio');

    const writer = fs.createWriteStream(outputPath);
    res.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    console.log(`   ✅ Direct: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
    return outputPath;
}

// ─────────────────────────────────────────────
//  SMART DOWNLOAD
// ─────────────────────────────────────────────
async function smartDownload(url, jobId) {
    const out = path.join(TEMP_DIR, `${jobId}.audio`);
    const errors = [];

    if (isPlatform(url)) {
        // 1. Cobalt
        try {
            console.log('📌 Strategy 1: Cobalt');
            return await downloadWithCobalt(url, out);
        } catch (e) { errors.push(e.message); }

        // 2. Piped (YouTube only)
        if (isYouTube(url)) {
            try {
                console.log('📌 Strategy 2: Piped');
                return await downloadWithPiped(url, out);
            } catch (e) { errors.push(e.message); }
        }

        // 3. Invidious (YouTube only)
        if (isYouTube(url)) {
            try {
                console.log('📌 Strategy 3: Invidious');
                return await downloadWithInvidious(url, out);
            } catch (e) { errors.push(e.message); }
        }

        // 4. yt-dlp
        try {
            console.log('📌 Strategy 4: yt-dlp');
            return await downloadWithYtDlp(url, jobId);
        } catch (e) { errors.push(e.message); }

        throw new Error(`All strategies failed:\n${errors.join('\n')}`);
    }

    // Regular URL
    return await downloadFile(url, out);
}

// ─────────────────────────────────────────────
//  FFmpeg
// ─────────────────────────────────────────────
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting to WAV...`);
        ffmpeg(inputPath)
            .audioChannels(2).audioFrequency(44100)
            .audioCodec('pcm_s16le').format('wav')
            .on('end', () => {
                console.log(`   ✅ WAV: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
                resolve();
            })
            .on('error', reject)
            .save(outputPath);
    });
}

function getMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, meta) => {
            if (err) return reject(err);
            const a = meta.streams.find(s => s.codec_type === 'audio');
            resolve({
                duration: parseFloat(meta.format.duration) || 0,
                sampleRate: parseInt(a?.sample_rate) || 44100,
                channels: parseInt(a?.channels) || 2,
                codec: a?.codec_name || 'unknown',
                bitrate: parseInt(meta.format.bit_rate) || 0
            });
        });
    });
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', version: '2.1' });
});

app.get('/api/audio/convert', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let dl = null;

    console.log(`\n${'═'.repeat(60)}\n🎵 CONVERT | ${url}\n${'═'.repeat(60)}`);

    try {
        dl = await smartDownload(url, jobId);
        await convertToWav(dl, wavPath);
        const buf = fs.readFileSync(wavPath);
        console.log(`📤 ${(buf.length / 1024 / 1024).toFixed(2)} MB\n`);
        res.set({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
        res.send(buf);
    } catch (err) {
        console.error(`❌ ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(dl, wavPath);
        cleanupPattern(jobId);
    }
});

app.get('/api/video/audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let dl = null;

    console.log(`\n${'═'.repeat(60)}\n🎬 VIDEO | ${url}\n${'═'.repeat(60)}`);

    try {
        dl = await smartDownload(url, jobId);
        await convertToWav(dl, wavPath);
        const meta = await getMetadata(wavPath);
        const buf = fs.readFileSync(wavPath);
        console.log(`📤 ${(buf.length / 1024 / 1024).toFixed(2)} MB base64\n`);
        res.json({
            success: true,
            audioData: buf.toString('base64'),
            metadata: { duration: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, codec: meta.codec, bitrate: meta.bitrate, fileSizeBytes: buf.length }
        });
    } catch (err) {
        console.error(`❌ ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        cleanup(dl, wavPath);
        cleanupPattern(jobId);
    }
});

app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });
    const jobId = generateId();
    let dl = null;
    try {
        dl = await smartDownload(url, jobId);
        res.json({ success: true, metadata: await getMetadata(dl) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally { cleanup(dl); cleanupPattern(jobId); }
});

app.get('/api/debug', (req, res) => {
    execFile(YT_DLP_PATH, ['--version'], { timeout: 5000 }, (err, stdout) => {
        res.json({
            version: '2.1',
            ytdlp: { path: YT_DLP_PATH, exists: fs.existsSync(YT_DLP_PATH), version: stdout?.trim() },
            ffmpeg: { exists: fs.existsSync(ffmpegPath) },
            cobalt: COBALT_INSTANCES,
            piped: PIPED_INSTANCES,
            invidious: INVIDIOUS_INSTANCES
        });
    });
});

app.use((err, req, res, next) => { res.status(500).json({ success: false, error: 'Server error' }); });
app.use((req, res) => { res.status(404).json({ success: false, error: `Not found: ${req.path}` }); });

// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  Velo Audio Server v2.1  |  Port ${PORT}  ║`);
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║  1. Cobalt   (${COBALT_INSTANCES.length} instances)          ║`);
    console.log(`║  2. Piped    (${PIPED_INSTANCES.length} instances)          ║`);
    console.log(`║  3. Invidious(${INVIDIOUS_INSTANCES.length} instances)          ║`);
    console.log(`║  4. yt-dlp   (fallback)               ║`);
    console.log(`╚════════════════════════════════════════╝\n`);
});
