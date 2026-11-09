const { catalog, runPlugin } = require('./_plugins');

const LIMIT = 60;
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
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ plugins: catalog() });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Only GET and POST are allowed.', code: 'method_not_allowed' });
  }
  if (limited(req)) return res.status(429).json({ error: 'Too many requests. Please wait a moment.', code: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body.id !== 'string') return res.status(400).json({ error: 'A plugin id is required.', code: 'missing_id' });

  try {
    return res.status(200).json(await runPlugin(body.id, body.query));
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    return res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'That service took too long. Try again.' : String(err.message).slice(0, 200), code: 'plugin_failed' });
  }
};
