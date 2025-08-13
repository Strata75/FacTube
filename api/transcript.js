<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>YouTube Transcript – Proof of Concept</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root{ --pad:12px; }
    body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;}
    h1{font-size:28px;margin:0 0 14px;}
    input,button,select{font-size:16px;padding:10px;}
    input,select{width:100%;box-sizing:border-box;}
    .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    .row > *{flex:1}
    button{cursor:pointer}
    pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px}
    small{color:#666}
    .status{height:8px;border-radius:6px;background:#eef2f6;margin-top:10px;overflow:hidden}
    .bar{height:100%;width:0;background:#5a8dee;transition:width .4s ease}
    .error{color:#b00020;margin-top:8px}
    .controls{display:grid;grid-template-columns:1fr auto;gap:12px}
    @media (max-width:520px){ .controls{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <h1>YouTube Transcript – Proof of Concept</h1>

  <div class="controls">
    <input id="url" type="url" placeholder="Paste YouTube link…" />
    <select id="lang" title="Preferred language (optional)">
      <option value="">auto</option>
      <option value="en">en</option>
      <option value="en-US">en-US</option>
      <option value="en-GB">en-GB</option>
    </select>
  </div>

  <div class="row" style="margin-top:10px">
    <button onclick="go()">Get Transcript</button>
    <button onclick="downloadFmt('txt')">Download .txt</button>
    <button onclick="downloadFmt('srt')">Download .srt</button>
    <button onclick="download('json')">Download .json</button>
  </div>

  <small>Requires captions to be available for the video.</small>
  <div class="status"><div id="bar" class="bar"></div></div>
  <div id="msg" class="error"></div>
  <pre id="out"></pre>

<script>
/* ----------------- set this to YOUR deployed function url ----------------- */
// Example: const API_URL = "https://your-project.vercel.app/api/transcript";
const API_URL = "REPLACE_WITH_YOUR_VERCEL_URL/api/transcript";
/* ------------------------------------------------------------------------- */

let lastData = null;

function setStatus(pct){ document.getElementById('bar').style.width = pct; }
function say(html){ document.getElementById('msg').innerHTML = html || ""; }
function show(obj){
  const el = document.getElementById('out');
  el.textContent = obj ? (typeof obj === 'string' ? obj : JSON.stringify(obj,null,2)) : "";
}

function saveFile(name, text, mime){
  const blob = new Blob([text], {type: mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function go(){
  const url = document.getElementById('url').value.trim();
  const lang = document.getElementById('lang').value.trim() || undefined;

  if(!url){ say("Enter a URL"); return; }

  setStatus("35%"); say(""); show(null); lastData = null;

  try{
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ url, lang })
    });

    const data = await res.json().catch(() => ({}));  // always try to parse
    lastData = data;                                   // save even when failing
    setStatus("75%");

    if(!res.ok){
      const tried = Array.isArray(data.tried_order) ? ` Tried: [${data.tried_order.join(" → ")}].` : "";
      say((data.error || `HTTP ${res.status}`) + tried);
      show(data);
      setStatus("0%");
      return;
    }

    // success
    say("");
    const items = data.segments || [];
    const plain = items.map(x => x.text).join("\n");
    lastData.plain_text = plain;               // cache for downloads
    show(plain);
    setStatus("0%");
  }catch(err){
    lastData = { error: err?.message || String(err) };
    say(lastData.error);
    show(lastData);
    setStatus("0%");
  }
}

function downloadFmt(kind){
  if(!lastData || !lastData.segments){
    say("Fetch a transcript first.");
    return;
  }
  if(kind === 'srt'){
    const srt = lastData.srt || "";
    if(!srt){ say("No SRT available."); return; }
    saveFile("transcript.srt", srt, "text/plain");
    return;
  }
  const txt = (lastData.plain_text || (lastData.segments||[]).map(s=>s.text).join("\n")).trim();
  if(!txt){ say("No text available."); return; }
  saveFile("transcript.txt", txt, "text/plain");
}

function download(kind){
  if(kind !== 'json') return;
  const url = document.getElementById('url').value.trim();
  const lang = document.getElementById('lang').value.trim() || undefined;

  // Always download *something* even if no fetch happened yet
  const payload = lastData ?? {
    note: "No fetch attempted yet. Click 'Get Transcript' first to capture the server response.",
    url, lang, ts: new Date().toISOString()
  };
  saveFile("response.json", JSON.stringify(payload, null, 2), "application/json");
}
</script>
</body>
</html>
