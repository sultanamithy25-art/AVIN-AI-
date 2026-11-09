const SYSTEM_PROMPT =
  'You are AVIN, a warm, friendly, helpful personal AI assistant. ' +
  'Reply clearly and kindly, and keep answers concise unless the user asks for more detail.';

const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
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

// Normalised conversation: [{ role: 'user' | 'model', text }], ending with the new message.
function toTurns(history, message) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-MAX_HISTORY_ITEMS)
    .map((t) => ({
      role: t.role === 'user' ? 'user' : 'model',
      text: t.text.slice(0, MAX_MESSAGE_LENGTH),
    }));

  // Conversations must open with a user turn.
  while (turns.length && turns[0].role !== 'user') turns.shift();

  return [...turns, { role: 'user', text: message }];
}

function groqRequest(apiKey, turns) {
  return {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text })),
      ],
    },
    readReply: (data) => data?.choices?.[0]?.message?.content,
  };
}

function geminiRequest(apiKey, turns) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return {
    name: 'Gemini',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    },
    readReply: (data) => {
      const parts = data?.candidates?.[0]?.content?.parts;
      return (Array.isArray(parts) ? parts : []).map((p) => p.text || '').join('');
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Only POST requests are allowed.', 'method_not_allowed');
  }

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) {
    return sendError(res, 500, 'No AI API key (GROQ_API_KEY or GEMINI_API_KEY) is configured on the server.', 'missing_api_key');
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

  const turns = toTurns(body.history, message);
  const provider = groqKey ? groqRequest(groqKey, turns) : geminiRequest(geminiKey, turns);

  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify(provider.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      return sendError(res, 504, `${provider.name} took too long to respond.`, 'upstream_timeout');
    }
    console.error(`${provider.name} request failed:`, err && err.message);
    return sendError(res, 502, `Could not reach ${provider.name}.`, 'upstream_unreachable');
  }

  const data = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    console.error(`${provider.name} error:`, upstream.status, data?.error?.message);
    if (upstream.status === 429) {
      return sendError(res, 429, `${provider.name} rate limit reached. Please try again shortly.`, 'rate_limited');
    }
    return sendError(res, 502, `${provider.name} returned an error (status ${upstream.status}).`, 'upstream_error');
  }

  const reply = (provider.readReply(data) || '').trim();
  if (!reply) {
    return sendError(res, 502, `${provider.name} returned an empty or blocked response.`, 'empty_response');
  }

  return res.status(200).json({ reply });
};
