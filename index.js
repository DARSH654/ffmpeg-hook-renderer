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

    // Tiered Resolution Font-Sizing Logic inside FFmpeg expressions:
    // - Width <= 480 (Low/360p)             -> Font 24px, Border 3px, LineHeight 30px
    // - 481 <= Width <= 900 (720p Benchmark) -> Font 36px, Border 4px, LineHeight 44px (LOCKED)
    // - 901 <= Width <= 1500 (1080p Full HD) -> Font 60px, Border 6px, LineHeight 72px
    // - Width > 1500 (4K/8K Ultra HD)       -> Font 110px, Border 10px, LineHeight 130px
    const fontSizeExpr = `if(lte(w,480), 24, if(lte(w,900), 36, if(lte(w,1500), 60, 110)))`;
    const borderExpr   = `if(lte(w,480), 3,  if(lte(w,900), 4,  if(lte(w,1500), 6,  10)))`;
    const lineHExpr    = `if(lte(w,480), 30, if(lte(w,900), 44, if(lte(w,1500), 72, 130)))`;

    const startY = `(h*0.72)`;

    const videoFilters = lineFiles.map((linePath, i) => {
      const yPos = `${startY}+(${i}*${lineHExpr})`;
      return `drawtext=${fontOption}textfile='${linePath}':fontsize=${fontSizeExpr}:fontcolor=white:borderw=${borderExpr}:bordercolor=black:x=(w-text_w)/2:y=${yPos}`;
    });

    console.log(`[FFMPEG-RENDER] Rendering ${wrappedLines.length} lines with Tiered Resolution Font Sizing...`);

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
