// api/transcript.js
import { YoutubeTranscript } from "youtube-transcript";

/** Extract a YouTube video ID from a URL or raw ID */
function extractVideoId(input) {
  const idRe = /^[A-Za-z0-9_-]{10,}$/;
  if (idRe.test(input)) return input.trim();

  try {
    const u = new URL(input);
    // youtu.be/<id>
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);

    if (u.hostname.includes("youtube.com")) {
      // youtube.com/watch?v=<id>
      const v = u.searchParams.get("v");
      if (v) return v;

      // shorts/live/embed/<id>
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{10,})/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL; fall through */
  }

  throw new Error("Could not extract a YouTube video ID from input.");
}

/** Convert transcript items to SRT text */
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
 * Try several fetch options:
 *  - preferred language (if provided)
 *  - English variants
 *  - ANY available (undefined opts)
 *  - as a final fallback: list available tracks and fetch the first explicitly
 */
async function fetchWithFallback(videoId, preferredLang) {
  const attempts = [];
  const optsList = [];

  if (preferredLang) optsList.push({ lang: preferredLang });
  optsList.push({ lang: "en" }, { lang: "en-US" }, { lang: "en-GB" }, undefined); // <-- undefined = ANY

  let lastErr;

  // 1) Preferred/en variants, then ANY
  for (const opts of optsList) {
    try {
      attempts.push(opts?.lang ? `lang=${opts.lang}` : "any");
      const tr = await YoutubeTranscript.fetchTranscript(videoId, opts);
      if (Array.isArray(tr) && tr.length) return { transcript: tr, attempts };
    } catch (e) {
      lastErr = e;
    }
  }

  // 2) Final fallback: enumerate tracks, fetch the first explicitly
  try {
    const tracks = await YoutubeTranscript.listTranscript(videoId);
    if (Array.isArray(tracks) && tracks.length) {
      const first = tracks[0];
      const langCode =
        first.languageCode || first.lang || first.language || first.code;
      attempts.push(`list:${langCode || "unknown"}`);

      const tr = await YoutubeTranscript.fetchTranscript(
        videoId,
        langCode ? { lang: langCode } : undefined
      );
      if (Array.isArray(tr) && tr.length) return { transcript: tr, attempts };
    }
  } catch (e) {
    lastErr = e;
  }

  const msg = lastErr?.message || "No transcript available.";
  const details = attempts.length ? ` Tried: [${attempts.join(", ")}].` : "";
  throw new Error(msg + details);
}

/** Vercel serverless function */
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
    const { transcript, attempts } = await fetchWithFallback(id, lang);

    const plainText = transcript.map(t => t.text).join("\n");
    const srt = toSrt(transcript);

    return res.status(200).json({
      video_id: id,
      tried_order: attempts,
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
