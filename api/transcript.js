// api/transcript.js
// Full serverless endpoint with robust caption fallbacks.
// package.json deps required:
//   "youtube-transcript": "^1.2.1",
//   "ytdl-core": "^4.11.2"

import { YoutubeTranscript } from "youtube-transcript";
import ytdl from "ytdl-core";

/* ---------------------------- helpers ---------------------------- */

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
  } catch {}
  throw new Error("Could not extract a YouTube video ID from input.");
}

function decodeHtml(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

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

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

/* ----------------------- primary fetch paths --------------------- */

async function tryYoutubeTranscript(videoId, preferredLang, attempts) {
  const optionsList = [
    undefined, // ANY available
    preferredLang ? { lang: preferredLang } : null,
    { lang: "en" },
    { lang: "en-US" },
    { lang: "en-GB" },
  ].filter((x) => x !== null);

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

// Fallback B: use ytdl-core to retrieve captionTracks and fetch their baseUrl
async function tryYtdl(videoId, preferredLang, attempts) {
  attempts.push("ytdl:info");
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const info = await ytdl.getInfo(url);
  const pr = info.player_response || info.playerResponse;
  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error("No caption tracks available.");

  const norm = (s) => (s || "").toLowerCase();
  let track =
    (preferredLang &&
      tracks.find((t) => norm(t.languageCode).startsWith(norm(preferredLang)))) ||
    tracks.find((t) => norm(t.languageCode).startsWith("en")) ||
    tracks[0];

  attempts.push(`ytdl:track=${track.languageCode || track.language || "unknown"}`);

  const base = track.baseUrl;
  const sep = base.includes("?") ? "&" : "?";
  const candidates = [
    base,
    `${base}${sep}fmt=srv3`,
    `${base}${sep}fmt=vtt`,
    `${base}${sep}fmt=ttml`,
    `${base}${sep}fmt=srv1`,
  ];

  const parseTimedtextXml = (xml) => {
    const re =
      /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    const items = [];
    let m;
    while ((m = re.exec(xml))) {
      const start = parseFloat(m[1] || "0");
      const dur = parseFloat(m[2] || "0");
      const text = decodeHtml((m[3] || "").replace(/<[^>]+>/g, ""));
      if (text.trim()) {
        items.push({
          text,
          offset: Math.round(start * 1000),
          duration: Math.round(dur * 1000),
        });
      }
    }
    return items;
  };

  const parseVttTime = (t) => {
    const parts = t.split(":").map(Number);
    let h = 0,
      m = 0,
      s = 0;
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
      const tline = lines[i++].trim();
      const m = tline.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const start = parseVttTime(m[1]);
      const end = parseVttTime(m[2]);
      const texts = [];
      while (i < lines.length && lines[i].trim() !== "") texts.push(lines[i++]);
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

  let lastStatus = null;
  for (const timedUrl of candidates) {
    try {
      attempts.push(
        `ytdl:get=${timedUrl.includes("fmt=") ? timedUrl.split("fmt=").pop() : "base"}`
      );
      const res = await fetch(timedUrl, { headers: BROWSER_HEADERS });
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
    } catch {}
  }

  throw new Error(`Caption download failed (last HTTP ${lastStatus ?? "n/a"})`);
}

// Fallback C: hit the public timedtext API directly (with &kind=asr and VTT)
async function tryTimedtextEndpoint(videoId, preferredLang, attempts) {
  const langs = [
    preferredLang,
    "en",
    "en-US",
    "en-GB",
  ].filter(Boolean);

  const parseVttTime = (t) => {
    const parts = t.split(":").map(Number);
    let h = 0,
      m = 0,
      s = 0;
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
      const tline = lines[i++].trim();
      const m = tline.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const start = parseVttTime(m[1]);
      const end = parseVttTime(m[2]);
      const texts = [];
      while (i < lines.length && lines[i].trim() !== "") texts.push(lines[i++]);
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

  let lastStatus = null;

  for (const lc of langs) {
    // No kind (manually uploaded)
    let url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(
      lc
    )}&fmt=vtt`;
    attempts.push(`timedtext:lang=${lc}`);
    try {
      let r = await fetch(url, { headers: BROWSER_HEADERS });
      lastStatus = r.status;
      if (r.ok) {
        const body = await r.text();
        if (/WEBVTT/i.test(body)) {
          const items = parseVtt(body);
          if (items.length) return items;
        }
      }
    } catch {}

    // Auto-generated captions often require kind=asr
    url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(
      lc
    )}&kind=asr&fmt=vtt`;
    attempts.push(`timedtext:lang=${lc}+asr`);
    try {
      let r = await fetch(url, { headers: BROWSER_HEADERS });
      lastStatus = r.status;
      if (r.ok) {
        const body = await r.text();
        if (/WEBVTT/i.test(body)) {
          const items = parseVtt(body);
          if (items.length) return items;
        }
      }
    } catch {}
  }

  throw new Error(`timedtext endpoint failed (last HTTP ${lastStatus ?? "n/a"})`);
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

    try {
      transcript = await tryYoutubeTranscript(id, lang, attempts);
    } catch {
      try {
        transcript = await tryYtdl(id, lang, attempts);
      } catch {
        transcript = await tryTimedtextEndpoint(id, lang, attempts);
      }
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
