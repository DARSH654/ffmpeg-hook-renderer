import { http } from '@google-cloud/functions-framework';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

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
      console.error('[FFMPEG-RENDER-ERROR] Missing parameters');
      return res.status(400).json({ error: 'Missing required videoUrl or overlayText parameters.' });
    }

    const cleanVideoUrl = encodeURI(decodeURI(videoUrl));
    console.log(`[FFMPEG-STEP 1/6] Processing Video URL: "${cleanVideoUrl}"`);

    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `input_${ts}.mp4`);
    const outputPath = path.join(tmpDir, `output_${ts}.mp4`);
    const fontPath = path.join(tmpDir, 'font.ttf');
    tempFiles.push(inputPath, outputPath);

    // 1. Download & validate font
    if (!fs.existsSync(fontPath) || fs.statSync(fontPath).size === 0) {
      console.log('[FFMPEG-STEP 2/6] Downloading Montserrat-Bold font...');
      const fontRes = await axios({
        url: 'https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-700-normal.ttf',
        responseType: 'arraybuffer'
      });
      fs.writeFileSync(fontPath, Buffer.from(fontRes.data));
      console.log(`[FFMPEG-STEP 2/6] Font downloaded successfully. Size: ${fs.statSync(fontPath).size} bytes`);
    } else {
      console.log(`[FFMPEG-STEP 2/6] Using existing font file. Size: ${fs.statSync(fontPath).size} bytes`);
    }

    // 2. Download video
    console.log('[FFMPEG-STEP 3/6] Downloading input video...');
    const videoRes = await axios({ url: cleanVideoUrl, method: 'GET', responseType: 'arraybuffer' });
    fs.writeFileSync(inputPath, Buffer.from(videoRes.data));
    console.log(`[FFMPEG-STEP 3/6] Input video downloaded successfully. Size: ${fs.statSync(inputPath).size} bytes`);

    // 3. Wrap text into lines
    const { lines, wordCount } = wrapText(overlayText);
    console.log(`[FFMPEG-STEP 4/6] Word wrap calculation complete. Words: ${wordCount} | Lines: ${lines.length}`);
    lines.forEach((l, idx) => console.log(`   Line ${idx + 1}: "${l}"`));

    // 4. Font size divisor calculation
    let fontSizeDivisor;
    if (wordCount > 18) fontSizeDivisor = 20;
    else if (wordCount > 10) fontSizeDivisor = 17;
    else fontSizeDivisor = 14;

    const N = lines.length;
    const D = fontSizeDivisor;
    const cleanFontPath = fontPath.replace(/\\/g, '/');
    const calculatedFontSize = Math.round(1080 / D); 

    console.log(`[FFMPEG-STEP 5/6] Calculated Font Size: ${calculatedFontSize}px (Divisor: ${D})`);

    // 5. Create temp text files for each line & build filter chain
    const filters = lines.map((line, i) => {
      const textFilePath = path.join(tmpDir, `line_${ts}_${i}.txt`);
      fs.writeFileSync(textFilePath, line, 'utf8');
      tempFiles.push(textFilePath);

      const cleanTextPath = textFilePath.replace(/\\/g, '/');
      const yExpr = `(h*0.72)-(${N}*${calculatedFontSize}*0.7)+(${i}*${calculatedFontSize}*1.4)`;

      const filterStr = `drawtext=fontfile=${cleanFontPath}:textfile=${cleanTextPath}:fontcolor=white:fontsize=${calculatedFontSize}:box=0:borderw=3:bordercolor=black:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${yExpr}`;
      console.log(`   Filter ${i + 1}: ${filterStr}`);
      return filterStr;
    });

    // 6. Run FFmpeg with full debug event listeners
    console.log('[FFMPEG-STEP 6/6] Spawning FFmpeg process...');
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(filters)
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a copy'])
        .on('start', (commandLine) => {
          console.log('[FFMPEG-EXEC-CMD] Executing FFmpeg command:');
          console.log(commandLine);
        })
        .on('stderr', (stderrLine) => {
          console.log(`[FFMPEG-STDERR] ${stderrLine}`);
        })
        .on('end', () => {
          console.log('[FFMPEG-STEP 6/6] FFmpeg execution ended successfully.');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('[FFMPEG-EXEC-FAILED] FFmpeg crashed.');
          console.error('[FFMPEG-EXEC-FAILED-STDOUT]:', stdout);
          console.error('[FFMPEG-EXEC-FAILED-STDERR]:', stderr);
          reject(err);
        })
        .save(outputPath);
    });

    console.log('[FFMPEG-RENDER] Render completed successfully!');
    const renderedBuffer = fs.readFileSync(outputPath);
    const base64Video = `data:video/mp4;base64,${renderedBuffer.toString('base64')}`;

    return res.status(200).json({ success: true, processedVideoUrl: base64Video });

  } catch (err) {
    console.error('[FFMPEG-RENDER CATCH-ERROR]:', err);
    return res.status(500).json({ error: 'FFmpeg video rendering failed', details: err.message });
  } finally {
    tempFiles.forEach(f => {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      } catch (_) {}
    });
  }
});
