// server.js (more robust; replace your existing file)
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(morgan('tiny'));
app.use(cors({ origin: '*' })); // allow all origins for the frontend
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit for api endpoints
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
});
app.use('/api', limiter);

// Utility: fetch with retries and strong headers
async function fetchWithRetries(url, tries = 3, timeout = 15000) {
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.instagram.com/',
  };

  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await axios.get(url, {
        headers: commonHeaders,
        timeout,
        maxRedirects: 5,
        validateStatus: status => status < 500 // treat 4xx as success for handling
      });
      return resp;
    } catch (err) {
      lastErr = err;
      // small backoff
      await new Promise(r => setTimeout(r, 500 + i * 300));
    }
  }
  throw lastErr;
}

// Helper: try multiple extraction strategies
function extractVideoFromHtml(html) {
  const $ = cheerio.load(html);

  // 1) og:video
  const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo && ogVideo.startsWith('http')) return { video: ogVideo };

  // 2) ld+json
  const ld = $('script[type="application/ld+json"]').html();
  if (ld) {
    try {
      const parsed = JSON.parse(ld);
      if (parsed && parsed.contentUrl) return { video: parsed.contentUrl };
    } catch (e) { /* ignore */ }
  }

  // 3) window._sharedData
  let found = null;
  $('script').each((i, el) => {
    const s = $(el).html();
    if (!s) return;
    if (s.includes('window._sharedData')) {
      const m = s.match(/window\._sharedData\s*=\s*(\{.*\});/s);
      if (m && m[1]) {
        try {
          const parsed = JSON.parse(m[1]);
          const shortcode_media = parsed?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
          if (shortcode_media) {
            const v = shortcode_media.video_url || shortcode_media.display_resources?.slice(-1)[0]?.src;
            if (v) found = v;
          }
        } catch (e) { /* ignore */ }
      }
    }
  });
  if (found) return { video: found };

  // 4) raw match for "video_url"
  const simpleMatch = html.match(/"video_url":"([^"]+)"/);
  if (simpleMatch && simpleMatch[1]) {
    const decoded = simpleMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
    return { video: decoded };
  }

  // 5) No video
  return null;
}

// Endpoint: fetch metadata (thumbnail + video direct url)
app.get('/api/getVideo', async (req, res) => {
  try {
    const igUrl = (req.query.url || '').trim();
    if (!igUrl) return res.status(400).json({ error: 'Missing url query parameter' });

    // Validate URL
    let parsed;
    try {
      parsed = new URL(igUrl);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!/instagram\.com$/i.test(parsed.hostname) && !parsed.hostname.includes('instagram.com')) {
      return res.status(400).json({ error: 'URL must be an instagram.com link' });
    }

    // Fetch HTML
    let resp;
    try {
      resp = await fetchWithRetries(igUrl, 3, 15000);
    } catch (err) {
      console.error('Fetch error:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'Server error while fetching Instagram page' });
    }

    // handle 4xx responses gracefully
    if (resp.status === 403 || resp.status === 429) {
      // Instagram likely blocked the request or rate-limited
      return res.status(502).json({ error: 'Instagram blocked the request (403/429). Try again later or use a proxy.' });
    }
    if (resp.status === 404) {
      return res.status(404).json({ error: 'Instagram post not found (404).' });
    }

    const html = resp.data;
    const extracted = extractVideoFromHtml(html);

    if (!extracted || !extracted.video) {
      // try a fallback: og:image
      const $ = cheerio.load(html);
      const thumbnail = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || null;
      return res.status(404).json({ error: 'Could not extract video URL. The post may be image-only, private, or Instagram changed its structure.', thumbnail });
    }

    // thumbnail
    const $ = cheerio.load(html);
    const thumbnail = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || null;

    return res.json({
      video: extracted.video,
      thumbnail,
      source: igUrl,
    });
  } catch (err) {
    console.error('Error in /api/getVideo:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Endpoint: proxy the video to force download (stream)
app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = (req.query.video || '').trim();
    if (!videoUrl) return res.status(400).json({ error: 'Missing video query parameter' });

    // basic validation
    try { new URL(videoUrl); } catch (e) { return res.status(400).json({ error: 'Invalid video URL' }); }

    const response = await axios({
      url: videoUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': 'https://www.instagram.com/',
      },
      timeout: 20000
    });

    // mirror content-type
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    const filename = 'instagram_video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.data.pipe(res);
  } catch (err) {
    console.error('Error in /api/download:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to download/stream video' });
  }
});

// Optional: simple root page
app.get('/', (req, res) => res.send('InstaSavePro backend is running.'));

app.listen(PORT, () => {
  console.log(`InstaSavePro backend listening on ${PORT}`);
});
