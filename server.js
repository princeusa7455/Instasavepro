import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// FREE PROXY HEADERS (bypass Instagram block)
const IG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// FREE PUBLIC PROXIES (auto rotate)
const PROXIES = [
  "https://api.scraperapi.com/?api_key=free&url=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/"
];

// Pick random proxy
function proxyURL(url) {
  const p = PROXIES[Math.floor(Math.random() * PROXIES.length)];
  return p + encodeURIComponent(url);
}

// ---------- GET VIDEO INFO ----------
app.get("/api/getVideo", async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: "URL missing" });

  try {
    const pageURL = proxyURL(url);

    const response = await axios.get(pageURL, { headers: IG_HEADERS });
    const html = response.data;

    // Extract HD Video URL
    const videoMatch = html.match(/"video_url":"(.*?)"/);
    const thumbMatch = html.match(/"display_url":"(.*?)"/);

    if (!videoMatch)
      return res.status(404).json({ error: "Unable to extract video" });

    const video = videoMatch[1].replace(/\\u0026/g, "&");
    const thumbnail = (thumbMatch ? thumbMatch[1] : "").replace(/\\u0026/g, "&");

    res.json({ video, thumbnail });
  } catch (err) {
    res.status(500).json({ error: "Proxy fetch failed", details: err.message });
  }
});

// ---------- DOWNLOAD PROXY ----------
app.get("/api/download", async (req, res) => {
  const { video } = req.query;

  if (!video) return res.status(400).json({ error: "Video URL missing" });

  try {
    const stream = await axios({
      url: video,
      method: "GET",
      responseType: "stream",
    });

    res.setHeader("Content-Disposition", 'attachment; filename="instasave.mp4"');
    stream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Download failed" });
  }
});

// ROOT
app.get("/", (req, res) => {
  res.send("InstaSavePro Proxy API is Running ✔");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on PORT " + PORT));
