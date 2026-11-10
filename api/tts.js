// Premium text to speech with Groq's Orpheus voices (English and Arabic). Returns WAV audio.
const MODELS = { en: 'canopylabs/orpheus-v1-english', ar: 'canopylabs/orpheus-arabic-saudi' };
const VOICES = { en: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'], ar: ['noura', 'lulwa', 'aisha', 'abdullah', 'fahad', 'sultan'] };
const DEFAULT_VOICE = { en: 'autumn', ar: 'noura' };
const MAX_CHARS = 200;
const LIMIT = 90;
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Only POST is allowed.', code: 'method_not_allowed' });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'Premium voice needs a Groq API key on the server.', code: 'missing_api_key' });
  if (limited(req)) return res.status(429).json({ error: 'Too many voice requests. Please wait a moment.', code: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const lang = body?.lang === 'ar' ? 'ar' : 'en';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_CHARS) return res.status(400).json({ error: `Text must be 1 to ${MAX_CHARS} characters.`, code: 'bad_text' });
  const voice = VOICES[lang].includes(body.voice) ? body.voice : DEFAULT_VOICE[lang];

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODELS[lang], voice, input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      const msg = d?.error?.message || '';
      console.error('TTS error:', r.status, msg);
      const terms = /terms/i.test(msg);
      return res.status(r.status === 429 ? 429 : 502).json({ error: terms ? 'The premium voice model needs its terms accepted in the Groq console first.' : 'The premium voice is unavailable right now.', code: terms ? 'terms_required' : 'tts_failed' });
    }
    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(audio);
  } catch (err) {
    console.error('TTS failed:', err && err.message);
    return res.status(502).json({ error: 'Could not reach the voice service.', code: 'tts_unreachable' });
  }
};
