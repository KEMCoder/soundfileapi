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

const TEMP_DIR = path.join(os.tmpdir(), 'velo-audio');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function generateId() { return crypto.randomUUID(); }

function cleanup(...files) {
    for (const f of files) try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
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

function isYouTube(url) { return /youtube\.com|youtu\.be|music\.youtube\.com/i.test(url); }
function isPlatform(url) { return /youtube\.com|youtu\.be|music\.youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|soundcloud\.com|dailymotion\.com|vimeo\.com|twitch\.tv|facebook\.com/i.test(url); }
function extractYouTubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

// ─────────────────────────────────────────────
//  STRATEGY 1: yt-dlp Mobile Workaround
// ─────────────────────────────────────────────
function downloadWithYtDlpDesktop(url, jobId) {
    return new Promise((resolve, reject) => {
        const tpl = path.join(TEMP_DIR, `${jobId}-desktop.%(ext)s`);
        const args = [
            '--no-check-certificates', '--no-playlist',
            '-f', 'bestaudio/best',
            '--ffmpeg-location', path.dirname(ffmpegPath),
            '-o', tpl, '--no-warnings', '--no-cache-dir',
            '--extractor-args', 'youtube:player_client=web',
            url
        ];

        console.log(`   🔧 yt-dlp (Desktop)...`);
        execFile(YT_DLP_PATH, args, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`yt-dlp-desktop: ${stderr || err.message}`));
            const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(`${jobId}-desktop`)).map(f => path.join(TEMP_DIR, f)).filter(f => { try { return fs.statSync(f).size > 0; } catch { return false; } });
            if (files.length === 0) return reject(new Error('yt-dlp: no output'));
            resolve(files[0]);
        });
    });
}

function downloadWithYtDlpMobile(url, jobId) {
    return new Promise((resolve, reject) => {
        const tpl = path.join(TEMP_DIR, `${jobId}-mobile.%(ext)s`);
        const args = [
            '--no-check-certificates', '--no-playlist',
            '-f', 'bestaudio/best',
            '--ffmpeg-location', path.dirname(ffmpegPath),
            '-o', tpl, '--no-warnings', '--no-cache-dir',
            // IOS/Android workaround to bypass web bot checks
            '--extractor-args', 'youtube:player_client=ios,android,mweb',
            url
        ];

        console.log(`   📱 yt-dlp (Mobile Workaround)...`);
        execFile(YT_DLP_PATH, args, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`yt-dlp-mobile: ${stderr || err.message}`));
            const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(`${jobId}-mobile`)).map(f => path.join(TEMP_DIR, f)).filter(f => { try { return fs.statSync(f).size > 0; } catch { return false; } });
            if (files.length === 0) return reject(new Error('yt-dlp: no output'));
            resolve(files[0]);
        });
    });
}

// ─────────────────────────────────────────────
//  STRATEGY 2: Cobalt
// ─────────────────────────────────────────────
const COBALT_INSTANCES = [
    'https://cobalt-api.meowing.de',
    'https://capi.3kh0.net',
    'https://blossom.imput.net',
];

async function downloadWithCobalt(url, outputPath) {
    let lastError = null;
    for (const api of COBALT_INSTANCES) {
        try {
            console.log(`   🔷 Cobalt: ${api}`);
            const res = await axios.post(api, { url: url, downloadMode: 'audio', audioFormat: 'best' }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 15000, httpsAgent: permissiveAgent });
            if (res.data.status === 'error') throw new Error(res.data.error?.code || JSON.stringify(res.data.error));
            const downloadUrl = res.data.url;
            if (!downloadUrl) throw new Error('No download URL');
            const audioRes = await axios({ method: 'GET', url: downloadUrl, responseType: 'stream', timeout: 120000, maxContentLength: 200 * 1024 * 1024, httpsAgent: permissiveAgent });
            const writer = fs.createWriteStream(outputPath);
            audioRes.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
            return outputPath;
        } catch (err) { lastError = err; }
    }
    throw new Error(`Cobalt failed: ${lastError?.message}`);
}

// ─────────────────────────────────────────────
//  SMART DOWNLOAD
// ─────────────────────────────────────────────
async function smartDownload(url, jobId) {
    const out = path.join(TEMP_DIR, `${jobId}.audio`);
    const errors = [];

    if (isPlatform(url)) {
        // 1. Mobile Workaround
        try { return await downloadWithYtDlpMobile(url, jobId); } catch (e) { errors.push(e.message); }
        // 2. Cobalt Proxy
        try { return await downloadWithCobalt(url, out); } catch (e) { errors.push(e.message); }
        // 3. Desktop Workaround
        try { return await downloadWithYtDlpDesktop(url, jobId); } catch (e) { errors.push(e.message); }

        throw new Error(`All methods failed.\n${errors.join('\n')}`);
    }

    // Direct
    const writer = fs.createWriteStream(out);
    const res = await axios({ method: 'GET', url, responseType: 'stream', timeout: 120000, httpsAgent: permissiveAgent });
    res.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    return out;
}

// ─────────────────────────────────────────────
//  FFmpeg
// ─────────────────────────────────────────────
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Converting to WAV...`);
        ffmpeg(inputPath).audioChannels(2).audioFrequency(44100).audioCodec('pcm_s16le').format('wav')
            .on('end', resolve).on('error', reject).save(outputPath);
    });
}
function getMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, meta) => {
            if (err) return reject(err);
            const a = meta.streams.find(s => s.codec_type === 'audio');
            resolve({ duration: parseFloat(meta.format.duration) || 0, sampleRate: parseInt(a?.sample_rate) || 44100, channels: parseInt(a?.channels) || 2, codec: a?.codec_name || 'unknown' });
        });
    });
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: '2.2 (Mobile Bypass Workaround)' }));

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
        res.set({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
        res.send(buf);
    } catch (err) {
        console.error(`❌ ${err.message}\n`);
        res.status(500).json({ success: false, error: err.message });
    } finally { cleanup(dl, wavPath); cleanupPattern(jobId); }
});

app.get('/api/video/audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });
    const jobId = generateId();
    const wavPath = path.join(TEMP_DIR, `${jobId}-out.wav`);
    let dl = null;
    try {
        dl = await smartDownload(url, jobId);
        await convertToWav(dl, wavPath);
        const meta = await getMetadata(wavPath);
        const buf = fs.readFileSync(wavPath);
        res.json({ success: true, audioData: buf.toString('base64'), metadata: { duration: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels } });
    } catch (err) { res.status(500).json({ success: false, error: err.message });
    } finally { cleanup(dl, wavPath); cleanupPattern(jobId); }
});
app.get('/api/audio/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });
    const jobId = generateId();
    let dl = null;
    try { dl = await smartDownload(url, jobId); res.json({ success: true, metadata: await getMetadata(dl) });
    } catch (err) { res.status(500).json({ success: false, error: err.message });
    } finally { cleanup(dl); cleanupPattern(jobId); }
});

app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  Velo Audio Server v2.2 (Mobile Fix)   ║`);
    console.log(`╚════════════════════════════════════════╝\n`);
});
