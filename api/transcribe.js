// Speech to text with Groq's Whisper model. Audio arrives as base64 and is never stored.
const MAX_AUDIO = 5500000; // base64 characters, about 4 MB of audio
const LIMIT = 20;
const WINDOW_MS = 60000;
const hits = new Map();

function limited(req) {
  const ip = String(req.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMIT;
}

const TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Only POST is allowed.', code: 'method_not_allowed' });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'Transcription needs a Groq API key on the server.', code: 'missing_api_key' });
  if (limited(req)) return res.status(429).json({ error: 'Too many recordings at once. Please wait a moment.', code: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const audio = typeof body?.audio === 'string' ? body.audio : '';
  if (!audio || audio.length > MAX_AUDIO || !/^[A-Za-z0-9+/=]+$/.test(audio)) return res.status(400).json({ error: 'That recording could not be read. Try a shorter one.', code: 'bad_audio' });
  const mime = String(body.mime || '').split(';')[0].toLowerCase();
  const ext = TYPES[mime] || 'webm';
  const lang = typeof body.lang === 'string' && /^[a-z]{2}$/.test(body.lang) ? body.lang : '';

  const form = new FormData();
  form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: mime || 'audio/webm' }), `speech.${ext}`);
  form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  if (lang) form.append('language', lang);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      console.error('Transcription error:', r.status, d?.error?.message);
      return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'Speech service is busy. Try again shortly.' : 'Could not transcribe that recording.', code: 'stt_failed' });
    }
    return res.status(200).json({ text: String(d?.text || '').trim(), language: d?.language || '' });
  } catch (err) {
    console.error('Transcription failed:', err && err.message);
    return res.status(502).json({ error: 'Could not reach the speech service.', code: 'stt_unreachable' });
  }
};
