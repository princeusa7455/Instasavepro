// server.js (refactored)
// - Move middlewares before route definitions
// - Remove duplicate app.listen
// - Apply rate limiter before /api routes
// - Add host whitelist for /api/download to reduce SSRF risk
// - Improve proxy streaming error handling and headers

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares (register before routes)
app.use(morgan('tiny'));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic rate limiting - adjust as needed
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Default Home Route
app.get('/', (req, res) => {
  res.send('InstaSavePro Server is Running Successfully 🚀');
});

// Test API Route
app.get('/api', (req, res) => {
  res.json({
    status: 'success',
    message: 'API Working Perfectly!',
  });
});

// Helper: try multiple ways to extract video URL from Instagram page HTML
async function extractFromHtml(html) {
  const $ = cheerio.load(html);

  // 1) Try og:video meta tag
  const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo && ogVideo.startsWith('http')) {
    return { video: ogVideo };
  }

  // 2) Look for JSON inside <script type="application/ld+json">
  const ld = $('script[type="application/ld+json"]').html();
  if (ld) {
    try {
      const parsed = JSON.parse(ld);
      if (parsed && parsed.contentUrl) {
        return { video: parsed.contentUrl };
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // 3) Instagram sometimes embeds JSON in <script>window._sharedData = {...}</script>
  let found = null;
  $('script').each((i, el) => {
    const scriptText = $(el).html();
    if (!scriptText) return;
    if (scriptText.includes('window._sharedData')) {
      try {
        const jsonMatch = scriptText.match(/window\._sharedData\s*=\s*(\{.*\});?/s);
        if (jsonMatch && jsonMatch[1]) {
          const parsed = JSON.parse(jsonMatch[1]);
          const entry = parsed?.entry_data;
          if (entry) {
            // Find any shortcode_media in the entry_data structure
            try {
              const values = Object.values(entry);
              for (const v of values) {
                if (Array.isArray(v)) {
                  const post = v[0]?.graphql?.shortcode_media;
                  const videoUrl = post?.video_url || post?.display_resources?.slice?.(-1)[0]?.src;
                  if (videoUrl) {
                    found = videoUrl;
                    break;
                  }
                }
              }
            } catch (e) {
              // continue
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }
  });
  if (found) return { video: found };

  // 4) As a fallback, try searching for "video_url" in raw HTML
  const simpleMatch = html.match(/"video_url":"([^"]+)"/);
  if (simpleMatch && simpleMatch[1]) {
    const decoded = simpleMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
    return { video: decoded };
  }

  // 5) No video found
  return null;
}

// Utility to check if a URL hostname is allowed for media proxying
const MEDIA_HOST_WHITELIST = [
  'cdninstagram.com',
  'instagram.com',
  'fbcdn.net',
  'fna.fbcdn.net',
  'akamaihd.net',
  'cdninstagram',
];

function isAllowedMediaHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return MEDIA_HOST_WHITELIST.some((allowed) => h.includes(allowed));
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

    // Only allow instagram domains for scraping
    if (!parsed.hostname.toLowerCase().includes('instagram.com')) {
      return res.status(400).json({ error: 'URL must be an instagram.com link' });
    }

    // Fetch HTML of the Instagram page
    const resp = await axios.get(igUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
    });

    const html = resp.data;

    // Extract video URL
    const extracted = await extractFromHtml(html);
    if (!extracted || !extracted.video) {
      return res.status(404).json({ error: 'Could not extract video URL. The page structure may have changed or the post may not be a video.' });
    }

    // Try to get thumbnail (og:image)
    const $ = cheerio.load(html);
    const thumbnail = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || null;

    // Respond with video and thumbnail
    return res.json({
      video: extracted.video,
      thumbnail,
      source: igUrl,
    });
  } catch (err) {
    console.error('Error in /api/getVideo:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error while fetching Instagram page' });
  }
});

// Endpoint: proxy the video so the browser can download (avoid CORS issues and provide safe proxy)
app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = (req.query.video || '').trim();
    if (!videoUrl) return res.status(400).json({ error: 'Missing video query parameter' });

    // Basic check
    let parsed;
    try {
      parsed = new URL(videoUrl);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid video URL' });
    }

    // Restrict proxying to known CDN/instagram hosts to reduce SSRF risk
    if (!isAllowedMediaHost(parsed.hostname)) {
      return res.status(400).json({ error: 'Video host is not allowed' });
    }

    // Stream the remote video
    const response = await axios({
      url: videoUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        Accept: '*/*',
        Referer: req.query.referer || 'https://www.instagram.com/',
      },
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: null,
    });

    if (response.status !== 200) {
      console.error('Downstream returned non-200 status:', response.status);
      // attempt to forward the status code
      return res.status(502).json({ error: 'Failed to fetch remote video', status: response.status });
    }

    // Mirror important headers
    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // Suggest a filename (try to preserve remote filename if present)
    const remoteName = path.basename(parsed.pathname) || 'instagram_video';
    const ext = path.extname(remoteName) || '.mp4';
    const filename = `instagram_${Date.now()}${ext}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Pipe stream and handle errors
    response.data.on('error', (err) => {
      console.error('Stream error while proxying video:', err && err.stack ? err.stack : err);
      if (!res.headersSent) res.status(500).end('Stream error');
      else res.end();
    });

    response.data.pipe(res);
  } catch (err) {
    console.error('Error in /api/download:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to download/stream video' });
  }
});

// Serve static frontend if placed in "public" folder (optional)
app.use('/', express.static('public'));

// Start the server (single app.listen)
app.listen(PORT, () => {
  console.log(`InstaSavePro backend running on port ${PORT}`);
});  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Helper: try multiple ways to extract video URL from Instagram page HTML
async function extractFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  // 1) Try og:video meta tag
  const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:secure_url"]').attr('content');
  if (ogVideo && ogVideo.startsWith('http')) {
    return { video: ogVideo };
  }

  // 2) Look for JSON inside <script type="application/ld+json"> (sometimes contains contentUrl)
  const ld = $('script[type="application/ld+json"]').html();
  if (ld) {
    try {
      const parsed = JSON.parse(ld);
      if (parsed && parsed.contentUrl) {
        return { video: parsed.contentUrl };
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // 3) Instagram sometimes embeds JSON in <script>window._sharedData = {...}</script>
  let found = null;
  $('script').each((i, el) => {
    const scriptText = $(el).html();
    if (!scriptText) return;
    if (scriptText.includes('window._sharedData')) {
      try {
        const jsonStr = scriptText.match(/window\._sharedData\s*=\s*(\{.*\});/s);
        if (jsonStr && jsonStr[1]) {
          const parsed = JSON.parse(jsonStr[1]);
          // navigate to entry data for shortcode_media
          const entry = parsed?.entry_data;
          if (entry) {
            const postPage = Object.values(entry)[0];
            const post = postPage?.[0]?.graphql?.shortcode_media;
            const videoUrl = post?.video_url || post?.display_resources?.slice(-1)[0]?.src;
            if (videoUrl) found = videoUrl;
          }
        }
      } catch (e) {
        // ignore
      }
    }
  });
  if (found) return { video: found };

  // 4) As a fallback, try searching for "video_url" in raw HTML
  const simpleMatch = html.match(/"video_url":"([^"]+)"/);
  if (simpleMatch && simpleMatch[1]) {
    const decoded = simpleMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
    return { video: decoded };
  }

  // 5) No video found
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

    // Only allow instagram domains
    if (!parsed.hostname.includes('instagram.com') && !parsed.hostname.includes('www.instagram.com')) {
      return res.status(400).json({ error: 'URL must be an instagram.com link' });
    }

    // Fetch HTML of the Instagram page
    // Important: set a user-agent header resembling a browser to improve chance of correct HTML
    const resp = await axios.get(igUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });

    const html = resp.data;

    // Extract video URL
    const extracted = await extractFromHtml(html, igUrl);
    if (!extracted || !extracted.video) {
      return res.status(404).json({ error: 'Could not extract video URL. The page structure may have changed or the post may not be a video.' });
    }

    // Try to get thumbnail (og:image)
    const $ = cheerio.load(html);
    const thumbnail = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || null;

    // Respond with video and thumbnail
    return res.json({
      video: extracted.video,
      thumbnail: thumbnail,
      source: igUrl,
    });
  } catch (err) {
    console.error('Error in /api/getVideo:', err.message || err);
    return res.status(500).json({ error: 'Server error while fetching Instagram page' });
  }
});

// Endpoint: proxy the video so the browser can download (avoid CORS issues on some URLs)
app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = (req.query.video || '').trim();
    if (!videoUrl) return res.status(400).json({ error: 'Missing video query parameter' });

    // Basic check
    let parsed;
    try {
      parsed = new URL(videoUrl);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid video URL' });
    }

    // Stream the remote video
    const response = await axios({
      url: videoUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        Accept: '*/*',
        Referer: req.query.referer || 'https://www.instagram.com/',
      },
      timeout: 20000,
    });

    // Mirror important headers
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    // Suggest a filename
    const filename = 'instagram_video.mp4';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Pipe stream
    response.data.pipe(res);
  } catch (err) {
    console.error('Error in /api/download:', err.message || err);
    return res.status(500).json({ error: 'Failed to download/stream video' });
  }
});

// Serve static frontend if placed in "public" folder (optional)
app.use('/', express.static('public'));

app.listen(PORT, () => {
  console.log(`InstaSavePro backend running on port ${PORT}`);
});
