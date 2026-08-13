import { http } from '@google-cloud/functions-framework';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

// Escape special characters for FFmpeg drawtext filter
function escapeFFmpeg(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Word-wrap text into lines
function wrapText(text) {
  const cleanText = text.trim();
  const wordCount = cleanText.split(/\s+/).length;

  let maxCharsPerLine;
  if (wordCount > 18) maxCharsPerLine = 28;
  else if (wordCount > 10) maxCharsPerLine = 24;
  else maxCharsPerLine = 20;

  const words = cleanText.split(' ');
  const lines = [];
  let currentLine = '';

  words.forEach(word => {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  });
  if (currentLine) lines.push(currentLine);
  return { lines, wordCount };
}

http('helloHttp', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const tempFiles = [];

  try {
    const { videoUrl, overlayText } = req.body || {};
    if (!videoUrl || !overlayText) {
      return res.status(400).json({ error: 'Missing required videoUrl or overlayText parameters.' });
    }

    const cleanVideoUrl = encodeURI(decodeURI(videoUrl));
    console.log(`[FFMPEG-RENDER] Processing: "${cleanVideoUrl}"`);

    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `input_${ts}.mp4`);
    const outputPath = path.join(tmpDir, `output_${ts}.mp4`);
    const fontPath = path.join(tmpDir, 'font.ttf');
    tempFiles.push(inputPath, outputPath);

    // 1. Download font
    if (!fs.existsSync(fontPath)) {
      console.log('[FFMPEG-RENDER] Downloading Montserrat-Bold font...');
      const fontRes = await axios({
        url: 'https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-700-normal.ttf',
        responseType: 'arraybuffer'
      });
      fs.writeFileSync(fontPath, Buffer.from(fontRes.data));
    }

    // 2. Download video
    console.log('[FFMPEG-RENDER] Downloading input video...');
    const videoRes = await axios({ url: cleanVideoUrl, method: 'GET', responseType: 'arraybuffer' });
    fs.writeFileSync(inputPath, Buffer.from(videoRes.data));

    // 3. Wrap text into lines
    const { lines, wordCount } = wrapText(overlayText);
    console.log(`[FFMPEG-RENDER] Words: ${wordCount} | Lines: ${lines.length}\n${lines.join('\n')}`);

    // 4. Font size divisor
    let fontSizeDivisor;
    if (wordCount > 18) fontSizeDivisor = 20;
    else if (wordCount > 10) fontSizeDivisor = 17;
    else fontSizeDivisor = 14;

    const N = lines.length;
    const D = fontSizeDivisor;
    const fontFileStr = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    // 5. Build per-line drawtext filters using text= (no temp files)
    const filters = lines.map((line, i) => {
      const escapedLine = escapeFFmpeg(line);
      const yExpr = `(h*0.72)-(${N}*(w/${D})*0.7)+(${i}*(w/${D})*1.4)`;
      return `drawtext=fontfile='${fontFileStr}':text='${escapedLine}':fontcolor=white:fontsize=w/${D}:box=0:borderw=w/${D * 14}:bordercolor=black:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${yExpr}`;
    });

    console.log('[FFMPEG-RENDER] Running FFmpeg render...');
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(filters)
        .outputOptions(['-c:a copy'])
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });

    console.log('[FFMPEG-RENDER] Render completed!');
    const renderedBuffer = fs.readFileSync(outputPath);
    const base64Video = `data:video/mp4;base64,${renderedBuffer.toString('base64')}`;

    return res.status(200).json({ success: true, processedVideoUrl: base64Video });

  } catch (err) {
    console.error('[FFMPEG-RENDER ERROR]:', err);
    return res.status(500).json({ error: 'FFmpeg video rendering failed', details: err.message });
  } finally {
    tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} });
  }
});
