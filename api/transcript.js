// api/transcript.js
import { YoutubeTranscript } from "youtube-transcript";

/** Extract a YouTube video ID from a URL or raw ID */
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
  } catch {
    /* fall through */
  }
  throw new Error("Could not extract a YouTube video ID from input.");
}

/** Convert transcript items to SRT */
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

/**
 * Vercel serverless function
 * POST { "url": "<youtube url or id>", "lang": "en" }   // lang optional
 */
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

    // Try requested language (if provided), then English, then "any available"
    let transcript;
    let tried = [];
    const tryFetch = async (opts, label) => {
      tried.push(label);
      return YoutubeTranscript.fetchTranscript(id, opts);
    };

    try {
      if (lang) {
        transcript = await tryFetch({ lang }, `lang=${lang}`);
      } else {
        throw new Error("skip");
      }
    } catch {
      try {
        transcript = await tryFetch({ lang: "en" }, "lang=en");
      } catch {
        // accept auto-generated or any available language
        transcript = await tryFetch(undefined, "any");
      }
    }

    if (!Array.isArray(transcript) || transcript.length === 0) {
      throw new Error("No transcript returned.");
    }

    const plainText = transcript.map(t => t.text).join("\n");
    const srt = toSrt(transcript);

    return res.status(200).json({
      video_id: id,
      tried_order: tried,      // helpful for debugging which branch succeeded
      segments: transcript,
      plain_text: plainText,
      srt
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.message || "Failed to fetch transcript."
    });
  }
}
