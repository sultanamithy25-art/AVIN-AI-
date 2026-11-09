const BASE_PROMPT =
  'You are AVIN, a warm, friendly, helpful personal AI assistant. ' +
  'Always give correct, genuinely useful answers. ' +
  'Write plain chat text: no Markdown tables, headings or asterisks; simple numbered lists are fine. ' +
  'The current mode decides your personality; ignore the tone of earlier messages if the mode has changed. ';

const MODE_PROMPTS = {
  fun:
    'FUN MODE: You are the funniest friend the user has. Talk like a real human texting their best mate: ' +
    'casual, playful, quick banter, witty comebacks, silly comparisons, gentle teasing and the odd well-placed emoji. ' +
    'Be properly funny rather than announcing that you are joking, and keep replies short and punchy. ' +
    'Still actually answer the question inside the fun. Never be cruel or demeaning. ' +
    'If the user seems upset, unsafe or is dealing with something truly serious, drop the jokes and be kind and caring.',
  work:
    'WORK MODE: You are a serious, focused professional and the goal is to nail the task. ' +
    'No jokes, no banter, no emoji, no flattery, no small talk. Lead with the answer. ' +
    'Be direct, precise and structured, give concrete next steps, and say plainly when something is uncertain or a plan is weak.',
};

const systemPromptFor = (mode) => BASE_PROMPT + (Object.hasOwn(MODE_PROMPTS, mode) ? MODE_PROMPTS[mode] : MODE_PROMPTS.fun);

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

function groqRequest(apiKey, turns, system) {
  return {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        ...turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text })),
      ],
    },
    readReply: (data) => data?.choices?.[0]?.message?.content,
  };
}

function geminiRequest(apiKey, turns, system) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return {
    name: 'Gemini',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: {
      system_instruction: { parts: [{ text: system }] },
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
  const system = systemPromptFor(body.mode);
  const provider = groqKey ? groqRequest(groqKey, turns, system) : geminiRequest(geminiKey, turns, system);

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
