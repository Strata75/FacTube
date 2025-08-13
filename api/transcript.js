// api/transcript.js
import { YoutubeTranscript } from "youtube-transcript";
import ytdl from "ytdl-core";

/** ---------- helpers ---------- **/

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

// Minimal XML entity decode for timedtext
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

/** ---------- primary fetch paths ---------- **/

// Path A: try the lightweight library first (ANY, then English variants)
async function tryYoutubeTranscript(videoId, preferredLang, attempts) {
  // IMPORTANT: keep `undefined` (means "ANY")
  const optionsList = [
    undefined,
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

// Path B: robust fallback using `ytdl-core` + YouTube timedtext
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

  // Pick track: preferred language -> English -> first
  const norm = (s) => (s || "").toLowerCase();
  let track =
    (preferredLang &&
      tracks.find((t) => norm(t.languageCode).startsWith(norm(preferredLang)))) ||
    tracks.find((t) => norm(t.languageCode).startsWith("en")) ||
    tracks[0];

  attempts.push(`ytdl:track=${track.languageCode || track.language || "unknown"}`);

  // Use baseUrl (XML "timedtext"); fetch and parse
  const timedUrl = track.baseUrl;
  const res = await fetch(timedUrl);
  if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
  const xml = await res.text();

  // Parse <text start="…" dur="…">…</text>
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const items = [];
  let m;
  while ((m = re.exec(xml))) {
    const startSec = parseFloat(m[1] || "0");
    const durSec = parseFloat(m[2] || "0");
    const text = decodeHtml(m[3].replace(/<[^>]+>/g, "")); // strip any tags
    if (text.trim().length) {
      items.push({
        text,
        offset: Math.round(startSec * 1000),
        duration: Math.round(durSec * 1000),
      });
    }
  }
  if (!items.length) throw new Error("Parsed zero caption entries.");
  return items;
}

/** ---------- handler ---------- **/

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
    let transcript = null;

    // A) library fast path
    try {
      transcript = await tryYoutubeTranscript(id, lang, attempts);
    } catch {
      // B) ytdl-core fallback
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
