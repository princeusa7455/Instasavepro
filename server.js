// server.js (updated — robust proxy + fallback + extraction)
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------- Config (via env) ----------
// If you have a paid proxy (recommended), set PROXY_PROVIDER and PROXY_KEY in Render env:
// PROXY_PROVIDER examples: "scraperapi", "scrapingbee", "scraperhero" (custom)
// PROXY_KEY: your API key
const PROXY_PROVIDER = process.env.PROXY_PROVIDER || ""; // e.g. "scraperapi"
const PROXY_KEY = process.env.PROXY_KEY || "";

// Free proxies (fallback only — unreliable)
const FREE_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://r.jina.ai/http://` + encodeURIComponent(u), // jina.ai http mirror
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`
];

// Browser-like headers
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.instagram.com/"
};

// small helper sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// try to fetch with axios and return { ok, status, data, err }
async function tryFetch(url, opts = {}, timeout = 15000) {
  try {
    const resp = await axios.get(url, {
      headers: opts.headers || DEFAULT_HEADERS,
      timeout,
      maxRedirects: 6,
      validateStatus: (s) => s < 500 // treat 4xx as handled below
    });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    return { ok: false, err };
  }
}

// Build provider proxy URL if configured (paid)
function buildProviderProxyUrl(provider, key, targetUrl) {
  if (!provider || !key) return null;
  provider = provider.toLowerCase();
  if (provider === "scraperapi") {
    // https://api.scraperapi.com?api_key=KEY&url=TARGET
    return `http://api.scraperapi.com?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(targetUrl)}&render=true`;
  }
  if (provider === "scrapingbee") {
    // https://app.scrapingbee.com/api/v1?api_key=KEY&url=TARGET&render_js=true
    return `https://app.scrapingbee.com/api/v1?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(targetUrl)}&render_js=true`;
  }
  // Add more providers here as needed
  return null;
}

// Robust fetch sequence:
// 1) If paid provider configured => try that
// 2) Try direct fetch (may be blocked by IG) with strong headers
// 3) Try free proxies in sequence with small backoff
async function robustFetchPage(url) {
  // 1) Paid provider
  if (PROXY_PROVIDER && PROXY_KEY) {
    const provUrl = buildProviderProxyUrl(PROXY_PROVIDER, PROXY_KEY, url);
    if (provUrl) {
      const r = await tryFetch(provUrl, {}, 20000);
      if (r.ok && r.status < 400 && r.data) return { html: r.data };
      // log and continue to next fallback
      console.error("Paid provider failed:", PROXY_PROVIDER, r.err || r.status);
    }
  }

  // 2) Try direct fetch (sometimes works)
  const direct = await tryFetch(url, {}, 15000);
  if (direct.ok && direct.status < 400 && direct.data) return { html: direct.data };

  // 3) Try free proxies (in order), with retries
  for (let i = 0; i < FREE_PROXIES.length; i++) {
    const proxyFn = FREE_PROXIES[i];
    const proxyUrl = proxyFn(url);
    // try small retries
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await tryFetch(proxyUrl, {}, 20000);
      if (r.ok && r.status < 400 && r.data) {
        return { html: r.data };
      }
      // small backoff
      await sleep(400 + attempt * 300);
    }
  }

  // nothing worked
  return { error: "All fetch attempts failed" };
}

// Extraction helpers (various strategies)
function extractFromHtml(html) {
  if (!html || typeof html !== "string") return null;

  // 1) og:video
  const ogMatch = html.match(/<meta property="og:video" content="([^"]+)"/i) || html.match(/<meta property="og:video:secure_url" content="([^"]+)"/i);
  if (ogMatch && ogMatch[1]) {
    return { video: decodeEscapes(ogMatch[1]) };
  }

  // 2) ld+json contentUrl
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (ldMatch && ldMatch[1]) {
    try {
      const parsed = JSON.parse(ldMatch[1]);
      if (parsed && parsed.contentUrl) return { video: parsed.contentUrl };
    } catch (e) {}
  }

  // 3) window._sharedData JSON
  const sharedMatch = html.match(/window\._sharedData\s*=\s*(\{.*?\});/s);
  if (sharedMatch && sharedMatch[1]) {
    try {
      const parsed = JSON.parse(sharedMatch[1]);
      // attempt common paths
      const entry = parsed?.entry_data;
      if (entry) {
        try {
          const postPage = Object.values(entry)[0];
          const postObj = postPage?.[0]?.graphql?.shortcode_media;
          const v = postObj?.video_url || postObj?.display_resources?.slice(-1)[0]?.src;
          if (v) return { video: v };
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 4) look for "video_url":"..."
  const simpleVideoMatch = html.match(/"video_url":"([^"]+)"/);
  if (simpleVideoMatch && simpleVideoMatch[1]) {
    const decoded = decodeEscapes(simpleVideoMatch[1]);
    return { video: decoded };
  }

  // 5) try searching for "og:image" as thumbnail fallback
  const thumbMatch = html.match(/<meta property="og:image" content="([^"]+)"/i) || html.match(/"display_url":"([^"]+)"/i);
  const thumbnail = thumbMatch ? decodeEscapes(thumbMatch[1]) : null;

  return { video: null, thumbnail };
}

// helper to decode escaped sequences like \u0026 and backslashes
function decodeEscapes(s) {
  try {
    return s.replace(/\\u0026/g, "&").replace(/\\/g, "");
  } catch (e) {
    return s;
  }
}

// ---------- API endpoints ----------
app.get("/api/getVideo", async (req, res) => {
  const igUrl = (req.query.url || "").trim();
  if (!igUrl) return res.status(400).json({ error: "Missing url query parameter" });

  try {
    // fetch page robustly
    const fetched = await robustFetchPage(igUrl);
    if (fetched.error) {
      console.error("robustFetchPage failed:", fetched.error);
      return res.status(502).json({ error: "Proxy fetch failed", details: fetched.error });
    }

    const html = fetched.html;
    const extracted = extractFromHtml(html);

    if (!extracted || !extracted.video) {
      // provide thumbnail if available
      const thumb = extracted?.thumbnail || null;
      return res.status(404).json({ error: "Unable to extract video. Post may be private or not a video.", thumbnail: thumb });
    }

    // success
    return res.json({
      video: extracted.video,
      thumbnail: extracted.thumbnail || null,
      source: igUrl
    });
  } catch (err) {
    console.error("Error /api/getVideo:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error", details: err.message || String(err) });
  }
});

// Download proxy (stream)
app.get("/api/download", async (req, res) => {
  const videoUrl = (req.query.video || "").trim();
  if (!videoUrl) return res.status(400).json({ error: "Missing video query parameter" });

  try {
    const resp = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
      headers: DEFAULT_HEADERS,
      timeout: 30000,
      maxRedirects: 6
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="instasave.mp4"');
    resp.data.pipe(res);
  } catch (err) {
    console.error("Error /api/download:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Download failed", details: err.message || String(err) });
  }
});

app.get("/", (_req, res) => res.send("InstaSavePro Proxy API (robust) is running"));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
