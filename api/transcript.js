// api/transcript.js
// Robust transcript endpoint with 3 strategies:
//  1) youtube-transcript
//  2) ytdl-core captionTracks
//  3) timedtext list (tries caps=asr / hl) -> exact track fetch (VTT or XML)

import { YoutubeTranscript } from "youtube-transcript";
import ytdl from "ytdl-core";

/* ------------------------------ utils ------------------------------ */

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

function parseVtt(vtt) {
  const lines = vtt.split(/\r?\n/);
  const items = [];
  let i = 0;

  const parseTime = (t) => {
    const parts = t.split(":").map(Number);
    let h = 0,
      m = 0,
      s = 0;
    if (parts.length === 3) [h, m, s] = parts;
    else if (parts.length === 2) [m, s] = parts;
    return h * 3600 + m * 60 + s;
  };

  while (i < lines.length) {
    while (i < lines.length && !lines[i].includes("-->")) i++;
    if (i >= lines.length) break;
    const tline = lines[i++].trim();
    const m = tline.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
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
}

function parseTimedtextXml(xml) {
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
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
}

/* ---------------------------- strategies ---------------------------- */

async function tryYoutubeTranscript(videoId, preferredLang, attempts) {
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

async function tryYtdl(videoId, preferredLang, attempts) {
  attempts.push("ytdl:info");
  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
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

/* --- NEW: list with multiple variants to surface auto-generated tracks --- */
async function listTimedtextTracks(videoId, attempts) {
  const variants = [
    `https://www.youtube.com/api/timedtext?type=list&v=${videoId}&tlangs=1`,
    `https://www.youtube.com/api/timedtext?type=list&v=${videoId}&tlangs=1&caps=asr`,
    `https://www.youtube.com/api/timedtext?type=list&v=${videoId}&tlangs=1&hl=en`,
    `https://www.youtube.com/api/timedtext?type=list&v=${videoId}&tlangs=1&caps=asr&hl=en`,
  ];

  for (const url of variants) {
    attempts.push(`timedtext:list ${url.includes("caps=asr") ? "asr" : "base"}${url.includes("&hl=") ? "+hl" : ""}`);
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    const xml = await res.text();
    if (!res.ok) continue;

    const tracks = [];
    const trackRe = /<track\b([^>]+)\/>/g;
    let m;
    while ((m = trackRe.exec(xml))) {
      const attrs = {};
      const attrRe = /(\w+)="([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
      tracks.push({
        lang_code: attrs.lang_code,
        name: attrs.name || "",
        kind: attrs.kind || "",
      });
    }
    if (tracks.length) return tracks;
  }

  return [];
}

async function tryTimedtextEndpoint(videoId, preferredLang, attempts) {
  const tracks = await listTimedtextTracks(videoId, attempts);
  if (!tracks.length) throw new Error("No tracks in timedtext list.");

  const norm = (s) => (s || "").toLowerCase();

  let chosen =
    (preferredLang &&
      tracks.find((t) => norm(t.lang_code).startsWith(norm(preferredLang)))) ||
    tracks.find((t) => norm(t.lang_code).startsWith("en")) ||
    tracks[0];

  attempts.push(
    `timedtext:choose lang=${chosen.lang_code}, kind=${chosen.kind || "manual"}${chosen.name ? `, name=${chosen.name}` : ""}`
  );

  const build = (fmtVtt) => {
    let u = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(
      chosen.lang_code
    )}`;
    if (chosen.kind === "asr") u += `&kind=asr`;
    if (chosen.name) u += `&name=${encodeURIComponent(chosen.name)}`;
    if (fmtVtt) u += `&fmt=vtt`;
    return u;
  };

  for (const withVtt of [true, false]) {
    const url = build(withVtt);
    attempts.push(`timedtext:get ${withVtt ? "vtt" : "xml"}`);
    const r = await fetch(url, { headers: BROWSER_HEADERS });
    const body = await r.text();
    if (!r.ok) continue;

    if (withVtt && /WEBVTT/i.test(body)) {
      const items = parseVtt(body);
      if (items.length) return items;
    }
    if (!withVtt && /<(transcript|timedtext|text)\b/i.test(body)) {
      const items = parseTimedtextXml(body);
      if (items.length) return items;
    }
  }
  throw new Error("timedtext track fetch returned no cues.");
}

/* ------------------------------ handler ------------------------------ */

export default async function handler(req, res) {
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
    return res.status(400).json({ error: err?.message || "Failed to fetch transcript." });
  }
}
