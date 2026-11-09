const { put, get, del } = require('@vercel/blob');

// Stores only data the browser has already encrypted. The server never sees the sync code or the chats.
const ID = /^[a-f0-9]{64}$/;
const MAX_BODY = 4000000;
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
  res.setHeader('Cache-Control', 'no-store');
  if (limited(req)) return res.status(429).json({ error: 'Too many sync requests.', code: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const id = String(req.query?.id || body?.id || '');
  if (!ID.test(id)) return res.status(400).json({ error: 'Invalid sync id.', code: 'bad_id' });
  const path = `sync/${id}.json`;

  try {
    if (req.method === 'GET') {
      const found = await get(path, { access: 'private', useCache: false });
      if (!found || found.statusCode !== 200) return res.status(404).json({ error: 'Nothing saved for this code.', code: 'not_found' });
      return res.status(200).json({ data: await new Response(found.stream).text() });
    }
    if (req.method === 'POST') {
      if (typeof body?.data !== 'string' || !body.data) return res.status(400).json({ error: 'Nothing to save.', code: 'missing_data' });
      if (body.data.length > MAX_BODY) return res.status(413).json({ error: 'Your history is too large to sync.', code: 'too_large' });
      await put(path, body.data, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      return res.status(200).json({ saved: true });
    }
    if (req.method === 'DELETE') {
      await del(path);
      return res.status(200).json({ deleted: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.', code: 'method_not_allowed' });
  } catch (err) {
    console.error('Sync error:', err && err.message);
    return res.status(502).json({ error: 'Sync is unavailable right now.', code: 'sync_failed' });
  }
};
