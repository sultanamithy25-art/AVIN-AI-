const SYSTEM_PROMPT =
  'You are AVIN, a warm, friendly, helpful personal AI assistant. ' +
  'Reply clearly and kindly, and keep answers concise unless the user asks for more detail.';

const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_MESSAGE_LENGTH = 8000;
const MAX_HISTORY_ITEMS = 20;
const TIMEOUT_MS = 25000;

function sendError(res, status, error, code) {
  return res.status(status).json({ error, code });
}

function parseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function toContents(history, message) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-MAX_HISTORY_ITEMS)
    .map((t) => ({
      role: t.role === 'user' ? 'user' : 'model',
      parts: [{ text: t.text.slice(0, MAX_MESSAGE_LENGTH) }],
    }));

  // Gemini expects the conversation to open with a user turn.
  while (turns.length && turns[0].role !== 'user') turns.shift();

  return [...turns, { role: 'user', parts: [{ text: message }] }];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Only POST requests are allowed.', 'method_not_allowed');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendError(res, 500, 'GEMINI_API_KEY is not configured on the server.', 'missing_api_key');
  }

  const body = parseBody(req.body);
  if (!body || typeof body !== 'object') {
    return sendError(res, 400, 'Request body must be valid JSON.', 'invalid_json');
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return sendError(res, 400, 'The "message" field is required.', 'missing_message');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return sendError(res, 400, `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`, 'message_too_long');
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: toContents(body.history, message),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      return sendError(res, 504, 'Gemini took too long to respond.', 'upstream_timeout');
    }
    console.error('Gemini request failed:', err && err.message);
    return sendError(res, 502, 'Could not reach Gemini.', 'upstream_unreachable');
  }

  const data = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    console.error('Gemini error:', upstream.status, data && data.error && data.error.message);
    if (upstream.status === 429) {
      return sendError(res, 429, 'Gemini rate limit reached. Please try again shortly.', 'rate_limited');
    }
    return sendError(res, 502, `Gemini returned an error (status ${upstream.status}).`, 'upstream_error');
  }

  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const reply = (Array.isArray(parts) ? parts : []).map((p) => p.text || '').join('').trim();

  if (!reply) {
    return sendError(res, 502, 'Gemini returned an empty or blocked response.', 'empty_response');
  }

  return res.status(200).json({ reply });
};
