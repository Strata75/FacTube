// api/transcript.js
// Full serverless endpoint with robust caption fallback.
// Requires package.json deps:
//   "youtube-transcript": "^1.2.1",
//   "ytdl-core": "^4.11.2"

import { YoutubeTranscript } from "youtube-transcript";
import ytdl from "ytdl-core";

/* ---------------------------- helpers ---------------------------- */

// Extract a YouTube video ID from a URL or raw ID
function extractVideoId(input) {
  const idRe = /^[A-Za-z0-9_-]{10,}$/;
  if (idRe.test(input)) return input.trim();
  try {
    const u = new URL(input);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{10,})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  throw new Error("Could not extract a YouTube video ID from input.");
}

// Minimal HTML/XML entity decode for timedtext
function decodeHtml(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Convert transcript items to SRT
function toSrt(items) {
  const fmt = (t) => {
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(t % 60)).padStart(2, "0");
    const ms = String(Math.floor((t - Math.floor(t)) * 1000)).padStart(3, "0");
    return `${h}:${m}:${s},${ms}`;
  };
  return items
    .map((it, i) => {
      const start = it.offset / 1000;
      const end = start + (it.duration ?? 0);
      return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${it.text}\n`;
    })
    .join("\n");
}

/* ----------------------- primary fetch paths --------------------- */

// Path A: use the lightweight library first (ANY → English variants)
async function tryYoutubeTranscript(videoId, preferredLang, attempts) {
  // Keep `undefined` (means "ANY available")
  const optionsList = [
    undefined,
    preferredLang ? { lang: preferredLang } : null,
    { lang: "en" },
    { lang: "en-US" },
    { lang: "en-GB" },
  ].filter((x) => x !== null); // drop only explicit nulls

  let lastErr;
  for (const opts of optionsList) {
    try {
      attempts.push(opts?.lang ? `ytTranscript:lang=${opts.lang}` : "ytTranscript:any");
      const tr = await YoutubeTranscript.fetchTranscript(videoId, opts);
      if (Array.isArray(tr) && tr.length) return tr;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No transcript via youtube-transcript");
}

// Path B: robust fallback using `ytdl-core` + YouTube timedtext (XML) or WebVTT
async function tryYtdl(videoId, preferredLang, attempts) {
  attempts.push("ytdl:info");
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const info = await ytdl.getInfo(url);
  const pr = info.player_response || info.playerResponse;
  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (!tracks.length) {
    throw new Error("No caption tracks available.");
  }

  // Pick track: preferred language → English → first
  const norm = (s) => (s || "").toLowerCase();
  let track =
    (preferredLang &&
      tracks.find((t) => norm(t.languageCode).startsWith(norm(preferredLang)))) ||
    tracks.find((t) => norm(t.languageCode).startsWith("en")) ||
    tracks[0];

  attempts.push(`ytdl:track=${track.languageCode || track.language || "unknown"}`);

  // Build URL variants to dodge 410/format quirks
  const base = track.baseUrl;
  const sep = base.includes("?") ? "&" : "?";
  const candidates = [
    base,                               // as-is (usually XML)
    `${base}${sep}fmt=srv3`,            // XML (srv3)
    `${base}${sep}fmt=vtt`,             // WebVTT text
    `${base}${sep}fmt=ttml`,            // TTML XML
    `${base}${sep}fmt=srv1`,            // legacy XML
  ];

  // Browser-like headers help avoid 410s
  const HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Parsers
  const parseTimedtextXml = (xml) => {
    const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    const items = [];
    let m;
    while ((m = re.exec(xml))) {
      const startSec = parseFloat(m[1] || "0");
      const durSec = parseFloat(m[2] || "0");
      const text = decodeHtml((m[3] || "").replace(/<[^>]+>/g, ""));
      if (text.trim()) {
        items.push({
          text,
          offset: Math.round(startSec * 1000),
          duration: Math.round(durSec * 1000),
        });
      }
    }
    return items;
  };

  const parseVttTime = (t) => {
    // 00:01:02.345  or  01:02.345
    const parts = t.split(":").map(Number);
    let h = 0, m = 0, s = 0;
    if (parts.length === 3) [h, m, s] = parts;
    else if (parts.length === 2) [m, s] = parts;
    return h * 3600 + m * 60 + s;
  };

  const parseVtt = (vtt) => {
    const lines = vtt.split(/\r?\n/);
    const items = [];
    let i = 0;
    while (i < lines.length) {
      while (i < lines.length && !lines[i].includes("-->")) i++;
      if (i >= lines.length) break;
      const timeLine = lines[i++].trim();
      const m = timeLine.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const start = parseVttTime(m[1]);
      const end = parseVttTime(m[2]);
      const texts = [];
      while (i < lines.length && lines[i].trim() !== "") {
        texts.push(lines[i++]);
      }
      while (i < lines.length && lines[i].trim() === "") i++;
      const text = decodeHtml(texts.join(" ").replace(/<[^>]+>/g, ""));
      if (text.trim()) {
        items.push({
          text,
          offset: Math.round(start * 1000),
          duration: Math.max(0, Math.round((end - start) * 1000)),
        });
      }
    }
    return items;
  };

  // Try each candidate until one works
  let lastStatus = null;
  for (const timedUrl of candidates) {
    try {
      attempts.push(
        `ytdl:get=${timedUrl.includes("fmt=") ? timedUrl.split("fmt=").pop() : "base"}`
      );
      const res = await fetch(timedUrl, { headers: HEADERS });
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = await res.text();

      if (/WEBVTT/i.test(body)) {
        const items = parseVtt(body);
        if (items.length) return items;
      }
      if (/<(timedtext|text)\b/i.test(body)) {
        const items = parseTimedtextXml(body);
        if (items.length) return items;
      }
      // Unknown or empty—try next format.
    } catch {
      // swallow and try next candidate
    }
  }

  throw new Error(`Caption download failed (last HTTP ${lastStatus ?? "n/a"})`);
}

/* ------------------------------ handler ------------------------------ */

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    const { url, lang } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing 'url'." });

    const id = extractVideoId(url);
    const attempts = [];
    let transcript;

    // A) try library
    try {
      transcript = await tryYoutubeTranscript(id, lang, attempts);
    } catch {
      // B) fallback direct
      transcript = await tryYtdl(id, lang, attempts);
    }

    const plainText = transcript.map((t) => t.text).join("\n");
    const srt = toSrt(transcript);

    return res.status(200).json({
      video_id: id,
      tried_order: attempts,
      segments: transcript,
      plain_text: plainText,
      srt,
    });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err?.message || "Failed to fetch transcript." });
  }
}
