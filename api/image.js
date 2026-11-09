const HORDE = 'https://aihorde.net/api/v2/generate';
const headers = () => ({ apikey: process.env.HORDE_API_KEY || '0000000000', 'Client-Agent': 'AVIN:1.0:none', 'Content-Type': 'application/json' });

const QUALITY = {
  fast: { models: ['Deliberate', 'stable_diffusion'], steps: 26, sizes: { square: [512, 512], portrait: [512, 768], landscape: [768, 512] } },
  hd: { models: ['Deliberate', 'stable_diffusion'], steps: 34, sizes: { square: [768, 768], portrait: [640, 960], landscape: [960, 640] } },
};
const NEGATIVE = 'lowres, blurry, deformed, bad anatomy, extra limbs, watermark, text, signature, nsfw, nude';
const LIMIT = 12;
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

async function enhance(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return prompt;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'Rewrite the user\'s idea as one vivid Stable Diffusion prompt: comma-separated phrases covering subject, setting, composition, lighting, style and quality. Under 55 words. Keep it safe for all ages. Output only the prompt.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(9000),
    });
    const text = (await r.json())?.choices?.[0]?.message?.content?.trim();
    return r.ok && text ? text.replace(/^"|"$/g, '').slice(0, 700) : prompt;
  } catch {
    return prompt;
  }
}

async function submit(req, res) {
  if (limited(req)) return res.status(429).json({ error: 'Too many images at once. Please wait a moment.', code: 'rate_limited' });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const idea = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 900) : '';
  if (!idea) return res.status(400).json({ error: 'Describe your image first.', code: 'missing_prompt' });

  const q = Object.hasOwn(QUALITY, body.quality) ? QUALITY[body.quality] : QUALITY.fast;
  const [width, height] = Object.hasOwn(q.sizes, body.ratio) ? q.sizes[body.ratio] : q.sizes.square;
  const prompt = body.enhance === false ? idea : await enhance(idea);

  const r = await fetch(`${HORDE}/async`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      prompt: `${prompt} ### ${NEGATIVE}`,
      nsfw: false,
      censor_nsfw: true,
      r2: false,
      shared: false,
      replacement_filter: true,
      models: q.models,
      params: { n: 1, width, height, steps: q.steps, cfg_scale: 7, sampler_name: 'k_euler_a', karras: true },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.id) {
    console.error('Horde submit failed:', r.status, data?.message);
    return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'The image network is busy. Try again in a minute.' : 'The image network could not take that request. Try rewording it.', code: 'submit_failed' });
  }
  return res.status(202).json({ id: data.id, prompt });
}

async function status(req, res, id) {
  const check = await fetch(`${HORDE}/check/${id}`, { headers: headers(), signal: AbortSignal.timeout(12000) });
  const c = await check.json().catch(() => null);
  if (!check.ok || !c) return res.status(502).json({ error: 'Lost contact with the image network.', code: 'check_failed' });
  if (c.faulted || c.is_possible === false) return res.status(200).json({ state: 'failed', error: 'No artist is available for that right now. Try Fast quality.' });
  if (!c.done) return res.status(200).json({ state: 'waiting', queue: c.queue_position, wait: c.wait_time, working: c.processing });

  const final = await fetch(`${HORDE}/status/${id}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  const f = await final.json().catch(() => null);
  const g = f?.generations?.[0];
  if (!final.ok || !g?.img) return res.status(502).json({ error: 'The finished image could not be collected.', code: 'collect_failed' });
  if (g.censored) return res.status(200).json({ state: 'failed', error: 'That image was blocked by the safety filter. Try a different idea.' });
  return res.status(200).json({ state: 'done', model: g.model, image: g.img.startsWith('http') ? g.img : `data:image/webp;base64,${g.img}` });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') return await submit(req, res);
    const id = String(req.query?.id || '');
    if (!/^[\w-]{10,64}$/.test(id) && req.method !== 'OPTIONS') return res.status(400).json({ error: 'A valid job id is required.', code: 'bad_id' });
    if (req.method === 'GET') return await status(req, res, id);
    if (req.method === 'DELETE') {
      await fetch(`${HORDE}/status/${id}`, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(8000) }).catch(() => {});
      return res.status(200).json({ cancelled: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.', code: 'method_not_allowed' });
  } catch (err) {
    console.error('Image error:', err && err.message);
    return res.status(502).json({ error: 'The image network is not responding. Try again shortly.', code: 'image_failed' });
  }
};
