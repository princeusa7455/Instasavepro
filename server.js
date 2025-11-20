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

// Middlewares
app.use(morgan('tiny'));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate Limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
});
app.use('/api', limiter);

// Home route
app.get('/', (req, res) => {
  res.send("InstaSavePro Server Running 🚀");
});

// Extract video function
async function extractFromHtml(html) {
  const $ = cheerio.load(html);

  const ogVideo = $('meta[property="og:video"]').attr("content");
  if (ogVideo) return { video: ogVideo };

  const ld = $('script[type="application/ld+json"]').html();
  if (ld) {
    try {
      const parsed = JSON.parse(ld);
      if (parsed.contentUrl) return { video: parsed.contentUrl };
    } catch {}
  }

  const script = html.match(/"video_url":"(.*?)"/);
  if (script) {
    return { video: script[1].replace(/\\u0026/g, "&") };
  }

  return null;
}

// API → Get Video URL
app.get('/api/getVideo', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "URL Required" });

    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      }
    });

    const extracted = await extractFromHtml(response.data);
    if (!extracted) return res.status(404).json({ error: "Video Not Found" });

    return res.json({ video: extracted.video });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Server Error" });
  }
});

// API → Proxy Download
app.get('/api/download', async (req, res) => {
  try {
    const videoUrl = req.query.video;
    if (!videoUrl) return res.status(400).json({ error: "Missing video URL" });

    const response = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream"
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="Video.mp4"`);

    response.data.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: "Download Failed" });
  }
});

// Static (optional)
app.use('/', express.static('public'));

// Start Server
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
