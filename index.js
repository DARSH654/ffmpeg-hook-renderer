import { http } from '@google-cloud/functions-framework';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

http('helloHttp', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const tempFiles = [];

  try {
    const { videoUrl } = req.body || {};
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing required videoUrl parameter.' });
    }

    const cleanVideoUrl = encodeURI(decodeURI(videoUrl));
    console.log(`[TEST-RENDER] Downloading video: "${cleanVideoUrl}"`);

    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `input_${ts}.mp4`);
    const outputPath = path.join(tmpDir, `output_${ts}.mp4`);
    tempFiles.push(inputPath, outputPath);

    // Download Video
    const videoRes = await axios({ url: cleanVideoUrl, method: 'GET', responseType: 'arraybuffer' });
    fs.writeFileSync(inputPath, Buffer.from(videoRes.data));

    // Find custom font file or fallback system monospace font
    let fontPath = path.join(process.cwd(), 'Montserrat-Bold.ttf');
    if (!fs.existsSync(fontPath)) {
      // Fallback paths on Linux system if custom TTF file isn't uploaded yet
      const systemFonts = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/freefont/FreeMono.ttf'
      ];
      fontPath = systemFonts.find(f => fs.existsSync(f)) || '';
    }

    // Sanitize font path for FFmpeg filter syntax (escape colon and backslashes)
    const escapedFontPath = fontPath ? fontPath.replace(/\\/g, '/').replace(/:/g, '\\:') : '';
    const fontOption = escapedFontPath ? `fontfile='${escapedFontPath}':` : '';

    // Drawtext Filter:
    // - text='Hi'
    // - fontsize=36
    // - borderw=4:bordercolor=black
    // - Centered horizontally, 72% screen height
    const simpleFilter = `drawtext=${fontOption}text='Hi':fontsize=36:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.72`;

    console.log('[TEST-RENDER] Running simple FFmpeg render with filter:', simpleFilter);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(simpleFilter)
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

    console.log('[TEST-RENDER] Success! Encoding output...');
    const renderedBuffer = fs.readFileSync(outputPath);
    const base64Video = `data:video/mp4;base64,${renderedBuffer.toString('base64')}`;

    return res.status(200).json({ success: true, processedVideoUrl: base64Video });

  } catch (err) {
    console.error('[TEST-RENDER ERROR]:', err);
    return res.status(500).json({ error: 'Test render failed', details: err.message });
  } finally {
    tempFiles.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    });
  }
});
