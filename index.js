import { http } from '@google-cloud/functions-framework';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

// Smart word-wrapping function (breaks text into ~22-25 char lines)
function wrapText(text, maxCharsPerLine = 22) {
  const words = text.trim().split(/\s+/);
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
  return lines;
}

http('helloHttp', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const tempFiles = [];

  try {
    const { videoUrl, overlayText } = req.body || {};
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing required videoUrl parameter.' });
    }

    const textToRender = overlayText || 'Default Hook Text';
    const cleanVideoUrl = encodeURI(decodeURI(videoUrl));
    console.log(`[FFMPEG-RENDER] Downloading video: "${cleanVideoUrl}"`);

    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `input_${ts}.mp4`);
    const outputPath = path.join(tmpDir, `output_${ts}.mp4`);
    tempFiles.push(inputPath, outputPath);

    // Download Video
    const videoRes = await axios({ url: cleanVideoUrl, method: 'GET', responseType: 'arraybuffer' });
    fs.writeFileSync(inputPath, Buffer.from(videoRes.data));

    // Resolve Montserrat Font
    let fontPath = path.join(process.cwd(), 'Montserrat-Bold.ttf');
    if (!fs.existsSync(fontPath)) {
      const systemFonts = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/freefont/FreeMono.ttf'
      ];
      fontPath = systemFonts.find(f => fs.existsSync(f)) || '';
    }

    const escapedFontPath = fontPath ? fontPath.replace(/\\/g, '/').replace(/:/g, '\\:') : '';
    const fontOption = escapedFontPath ? `fontfile='${escapedFontPath}':` : '';

    // Smart Multi-line Text Wrapping
    const wrappedLines = wrapText(textToRender, 24);
    const lineFiles = [];

    // Write each line into a temporary text file to handle special characters cleanly in FFmpeg
    wrappedLines.forEach((lineStr, index) => {
      const lineFilePath = path.join(tmpDir, `line_${ts}_${index}.txt`);
      fs.writeFileSync(lineFilePath, lineStr, 'utf8');
      tempFiles.push(lineFilePath);
      lineFiles.push(lineFilePath.replace(/\\/g, '/').replace(/:/g, '\\:'));
    });

    // Proportional Dynamic Scaling (w/20 for font, w/180 for border)
    // 720p  -> 36px font, 4px border
    // 1080p -> 54px font, 6px border
    // 4K    -> 1080px font, 12px border
    const N = wrappedLines.length;
    const startY = `(h*0.72)`;

    const videoFilters = lineFiles.map((linePath, i) => {
      // Stacking offset scales dynamically with video width (lineHeight ≈ (w/20) * 1.25)
      const yPos = `${startY}+(${i}*(w/20)*1.25)`;
      return `drawtext=${fontOption}textfile='${linePath}':fontsize=w/20:fontcolor=white:borderw=w/180:bordercolor=black:x=(w-text_w)/2:y=${yPos}`;
    });

    console.log(`[FFMPEG-RENDER] Rendering ${wrappedLines.length} lines with dynamic resolution scaling...`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(videoFilters)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 128k',
          '-shortest'
        ])
        .on('start', (cmd) => console.log('[FFMPEG CMD]', cmd))
        .on('stderr', (line) => console.log('[FFMPEG STDERR]', line))
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    console.log('[FFMPEG-RENDER] Success! Encoding output to Base64...');
    const renderedBuffer = fs.readFileSync(outputPath);
    const base64Video = `data:video/mp4;base64,${renderedBuffer.toString('base64')}`;

    return res.status(200).json({ success: true, processedVideoUrl: base64Video });

  } catch (err) {
    console.error('[FFMPEG-RENDER ERROR]:', err);
    return res.status(500).json({ error: 'FFmpeg rendering failed', details: err.message });
  } finally {
    tempFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    });
  }
});
