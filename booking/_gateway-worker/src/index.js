/**
 * ElevIQ booking gateway — one Cloudflare Worker, two doors to the same
 * booking backend (the Google Apps Script behind /booking/):
 *
 *   1. Plain HTTP API for autonomous agents (documented in llms.txt):
 *        GET  /slots?lang=en|fr   — list bookable slots
 *        POST /book               — book a slot (JSON body)
 *   2. MCP server for connected assistants (Streamable HTTP, stateless):
 *        POST /mcp                — tools: list_slots, book_slot
 *
 * Both doors share the same pipeline: validate → rate-limit → stamp
 * attribution (self-declared `via`, User-Agent, Cloudflare verified-bot
 * signal) → forward to the Apps Script. The human booking page keeps
 * talking to the Apps Script directly and is untouched.
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbyH4RMe-lfQrzbEmCRzDufaOzpUaYpmTTr1Ghn2AfpbCuijNYLUS1_2KJJIPwc2ycFMvQ/exec';

const GATEWAY_VERSION = '2026-08-17-v2';

// Field length caps — user-supplied text ends up embedded in the emails the
// backend sends, so everything is truncated before forwarding.
const CAPS = { name: 120, email: 200, topic: 500, via: 120 };

function cap(value, max) {
  return String(value || '').trim().slice(0, max);
}

// MCP protocol versions this server can speak (newest first).
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Rate limiting, keyed per client IP: stricter for booking attempts.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const isWrite = request.method === 'POST' && (path === '/book' || path === '/waitlist');
    const limiter = isWrite ? env.BOOK_LIMITER : env.READ_LIMITER;
    const { success: allowed } = await limiter.limit({ key: ip });
    if (!allowed) {
      return json(
        {
          error: 'rate_limited',
          hint: 'Too many requests from this address. Booking is limited to 5 attempts per minute; wait a moment and retry.',
        },
        429
      );
    }

    try {
      if (path === '/' && request.method === 'GET') return apiIndex(url);
      if (path === '/slots' && request.method === 'GET') return handleSlots(url);
      if (path === '/book' && request.method === 'POST') return handleBook(request);
      if (path === '/waitlist' && request.method === 'POST') return handleWaitlist(request);
      if (path === '/mcp' && request.method === 'POST') return handleMcp(request);
      if (path === '/mcp') {
        // Stateless server: no SSE stream, no sessions to delete.
        return json({ error: 'method_not_allowed', hint: 'Send MCP JSON-RPC messages as POST /mcp.' }, 405, {
          Allow: 'POST, OPTIONS',
        });
      }
      return json(
        { error: 'not_found', hint: 'GET / describes this API. Endpoints: GET /slots, POST /book, POST /waitlist, POST /mcp.' },
        404
      );
    } catch (err) {
      return json(
        {
          error: 'backend_unreachable',
          hint: 'The booking backend did not answer. Please retry shortly, or email hello@eleviq.solutions.',
        },
        502
      );
    }
  },
};

/* ---------------------------------------------------------------- helpers */

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

function normalizeLang(value) {
  // The gateway serves agents worldwide, so unlike the Apps Script it
  // defaults to English; the human form keeps its own French default.
  return value === 'fr' ? 'fr' : 'en';
}

// Attribution evidence stamped into every booking that passes the gateway.
function attributionFrom(request, declaredVia) {
  const cf = request.cf || {};
  return {
    via: String(declaredVia || '').trim().slice(0, 120),
    agent_ua: (request.headers.get('User-Agent') || '').slice(0, 250),
    agent_verified: String(cf.verifiedBotCategory || '').slice(0, 120),
  };
}

async function backendGetSlots(lang) {
  const res = await fetch(APPS_SCRIPT_URL + '?lang=' + normalizeLang(lang));
  if (!res.ok) throw new Error('backend http ' + res.status);
  return res.json();
}

async function backendPost(payload) {
  const res = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('backend http ' + res.status);
  return res.json();
}

/* --------------------------------------------------------------- HTTP API */

function apiIndex(url) {
  const base = url.origin;
  return json({
    service: 'ElevIQ booking gateway',
    version: GATEWAY_VERSION,
    description:
      'Book a free 30-minute intro call with ElevIQ Solutions (eleviq.solutions). One booking per slot; a confirmation email is sent to the address you provide.',
    endpoints: {
      list_slots: 'GET ' + base + '/slots?lang=en — bookable slots; entries with "taken": true are gone.',
      book: 'POST ' + base + '/book — JSON body: {"slotId": "<id from /slots>", "name": "...", "email": "...", "topic": "(optional)", "lang": "en|fr", "via": "<your agent or product name>"}',
      waitlist: 'POST ' + base + '/waitlist — when no slot is free. JSON body: {"name": "...", "email": "...", "topic": "(optional)", "lang": "en|fr", "via": "<your agent or product name>"}',
      mcp: 'POST ' + base + '/mcp — MCP server (Streamable HTTP), tools: list_slots, book_slot, join_waitlist.',
    },
    attribution:
      'Please set "via" to your agent or product name (e.g. "claude", "gpt-agent") so the booking is attributed correctly.',
    contact: 'hello@eleviq.solutions',
  });
}

async function handleSlots(url) {
  const lang = normalizeLang(url.searchParams.get('lang'));
  const data = await backendGetSlots(lang);
  return json({
    gateway_version: GATEWAY_VERSION,
    lang: lang,
    slots: data.slots || [],
    hint: 'Book with POST /book using the "id" of a slot where "taken" is false. If every slot is taken, POST /waitlist with name and email to be contacted when a new slot opens.',
  });
}

async function handleBook(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json(
      { error: 'invalid_json', hint: 'Send a JSON body, e.g. {"slotId":"2026-09-01_14:00","name":"Ada","email":"ada@example.com"}.' },
      400
    );
  }

  // Forgiving parsing: accept common alternative field spellings.
  const slotId = String(body.slotId || body.slot_id || body.slot || body.id || '').trim();
  const name = cap(body.name, CAPS.name);
  const email = cap(body.email, CAPS.email);
  const topic = cap(body.topic || body.subject, CAPS.topic);
  const lang = normalizeLang(body.lang);

  const missing = [];
  if (!slotId) missing.push('slotId (an "id" value from GET /slots)');
  if (!name) missing.push('name');
  if (!email) missing.push('email (a confirmation is sent there)');
  if (missing.length) {
    return json({ error: 'missing_fields', missing: missing, hint: 'Add the missing fields and retry.' }, 400);
  }

  const result = await submitThroughBackend(request, 'book', { slotId, name, email, topic, lang, via: body.via });

  if (result.success) {
    return json({
      success: true,
      booked: result.label,
      message:
        'Booking confirmed: ' +
        result.label +
        '. A confirmation email has been sent to ' +
        email +
        '. To cancel or reschedule, reply to that email.',
    });
  }

  const failures = {
    invalid_input: [400, 'The backend rejected the input — check that the email address is valid.'],
    unknown_slot: [404, 'That slot id does not exist (it may have been removed). Pick a current id from GET /slots.'],
    taken: [409, 'That slot was just taken. Pick another slot where "taken" is false.'],
    write_not_confirmed: [502, 'The booking could not be confirmed. Please retry, or email hello@eleviq.solutions.'],
  };
  const [status, hint] = failures[result.reason] || [502, 'Unexpected backend answer. Please retry, or email hello@eleviq.solutions.'];
  return json({ error: result.reason || 'backend_error', hint: hint, slots: result.slots }, status);
}

async function handleWaitlist(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json(
      { error: 'invalid_json', hint: 'Send a JSON body, e.g. {"name":"Ada","email":"ada@example.com"}.' },
      400
    );
  }

  const name = cap(body.name, CAPS.name);
  const email = cap(body.email, CAPS.email);
  const topic = cap(body.topic || body.subject, CAPS.topic);

  const missing = [];
  if (!name) missing.push('name');
  if (!email) missing.push('email (you will be contacted there when a slot opens)');
  if (missing.length) {
    return json({ error: 'missing_fields', missing: missing, hint: 'Add the missing fields and retry.' }, 400);
  }

  const result = await submitThroughBackend(request, 'waitlist', {
    name, email, topic, lang: normalizeLang(body.lang), via: body.via,
  });

  if (result.success) {
    return json({
      success: true,
      message:
        'Waitlist signup confirmed for ' + email + '. Matthias will reach out as soon as a new slot opens; a confirmation email has been sent.',
    });
  }
  return json(
    { error: result.reason || 'backend_error', hint: 'The backend rejected the signup — check that the email address is valid.' },
    result.reason === 'invalid_input' ? 400 : 502
  );
}

// Shared by the HTTP door and the MCP door: stamps attribution and forwards
// to the Apps Script backend.
function submitThroughBackend(request, action, { slotId, name, email, topic, lang, via }) {
  const attribution = attributionFrom(request, via);
  return backendPost({
    action: action,
    slotId: slotId,
    name: name,
    email: email,
    topic: topic,
    lang: lang,
    via: attribution.via,
    agent_ua: attribution.agent_ua,
    agent_verified: attribution.agent_verified,
    // Never set the honeypot field — the backend silently discards
    // submissions that fill it.
    hp_check: '',
  });
}

/* ------------------------------------------------------------- MCP server */

const MCP_TOOLS = [
  {
    name: 'list_slots',
    title: 'List bookable call slots',
    description:
      'List the bookable slots for a free 30-minute intro call with Matthias Jung of ElevIQ Solutions. Slots with "taken": true are no longer available.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: ['en', 'fr'], description: 'Language for the human-readable slot labels (default en).' },
      },
    },
  },
  {
    name: 'book_slot',
    title: 'Book a call slot',
    description:
      'Book a free 30-minute intro call with ElevIQ Solutions. Requires a slot id from list_slots plus the name and email of the person the call is for; a confirmation email is sent to that address. Ask the user for consent before booking on their behalf.',
    inputSchema: {
      type: 'object',
      properties: {
        slotId: { type: 'string', description: 'The "id" of a free slot from list_slots, e.g. "2026-09-01_14:00".' },
        name: { type: 'string', description: 'Name of the person the call is for.' },
        email: { type: 'string', description: 'Email address for the confirmation.' },
        topic: { type: 'string', description: 'Optional: what the call should focus on.' },
        lang: { type: 'string', enum: ['en', 'fr'], description: 'Language for the confirmation email (default en).' },
      },
      required: ['slotId', 'name', 'email'],
    },
  },
  {
    name: 'join_waitlist',
    title: 'Join the waitlist',
    description:
      'Join the ElevIQ waitlist when no free call slots are available. Matthias will reach out by email as soon as a new slot opens. Ask the user for consent before signing them up.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the person to put on the waitlist.' },
        email: { type: 'string', description: 'Email address to contact when a slot opens.' },
        topic: { type: 'string', description: 'Optional: what the call should focus on.' },
        lang: { type: 'string', enum: ['en', 'fr'], description: 'Language for the confirmation email (default en).' },
      },
      required: ['name', 'email'],
    },
  },
];

async function handleMcp(request) {
  let message;
  try {
    message = await request.json();
  } catch (err) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body must be JSON.' } }, 400);
  }

  // Batches (allowed up to protocol 2025-03-26): answer each message.
  if (Array.isArray(message)) {
    const answers = [];
    for (const m of message) {
      const a = await mcpAnswer(request, m);
      if (a !== null) answers.push(a);
    }
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  const answer = await mcpAnswer(request, message);
  // Notifications (no id) get no body, just an acknowledgement.
  return answer === null ? new Response(null, { status: 202, headers: CORS_HEADERS }) : json(answer);
}

async function mcpAnswer(request, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' } };
  }
  const isNotification = msg.id === undefined || msg.id === null;

  try {
    const result = await mcpMethod(request, msg.method, msg.params || {});
    if (isNotification) return null;
    if (result === undefined) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
    }
    return { jsonrpc: '2.0', id: msg.id, result: result };
  } catch (err) {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error: ' + (err && err.message) } };
  }
}

async function mcpMethod(request, method, params) {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'eleviq-booking', title: 'ElevIQ Booking', version: GATEWAY_VERSION },
        instructions:
          'Books free 30-minute intro calls with ElevIQ Solutions (eleviq.solutions, AI agent readiness consulting). Call list_slots first, let the user pick a free slot, then book_slot with their name and email.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: MCP_TOOLS };
    case 'tools/call':
      return mcpToolCall(request, params);
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // acknowledged, nothing to do (stateless server)
    default:
      return undefined; // → method not found
  }
}

async function mcpToolCall(request, params) {
  const args = params.arguments || {};

  if (params.name === 'list_slots') {
    const data = await backendGetSlots(args.lang);
    const free = (data.slots || []).filter((s) => !s.taken);
    const text = free.length
      ? 'Bookable slots (use the id with book_slot):\n' + free.map((s) => '- ' + s.id + ' — ' + s.label).join('\n')
      : 'No free slots right now. Use the join_waitlist tool to put the user on the waitlist — they will be contacted by email as soon as a new slot opens.';
    return { content: [{ type: 'text', text: text }] };
  }

  if (params.name === 'join_waitlist') {
    const name = cap(args.name, CAPS.name);
    const email = cap(args.email, CAPS.email);
    if (!name || !email) {
      return {
        content: [{ type: 'text', text: 'Missing required arguments: join_waitlist needs name and email.' }],
        isError: true,
      };
    }
    const result = await submitThroughBackend(request, 'waitlist', {
      name: name,
      email: email,
      topic: cap(args.topic, CAPS.topic),
      lang: normalizeLang(args.lang),
      via: 'mcp',
    });
    if (result.success) {
      return {
        content: [{ type: 'text', text: 'Waitlist signup confirmed for ' + email + '. Matthias will reach out as soon as a new slot opens; a confirmation email was sent.' }],
      };
    }
    return {
      content: [{ type: 'text', text: 'Waitlist signup failed: the backend rejected the input — check the email address.' }],
      isError: true,
    };
  }

  if (params.name === 'book_slot') {
    const slotId = String(args.slotId || '').trim();
    const name = cap(args.name, CAPS.name);
    const email = cap(args.email, CAPS.email);
    if (!slotId || !name || !email) {
      return {
        content: [{ type: 'text', text: 'Missing required arguments: book_slot needs slotId, name and email.' }],
        isError: true,
      };
    }
    const result = await submitThroughBackend(request, 'book', {
      slotId: slotId,
      name: name,
      email: email,
      topic: cap(args.topic, CAPS.topic),
      lang: normalizeLang(args.lang),
      via: 'mcp',
    });
    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Booking confirmed: ' + result.label + '. A confirmation email was sent to ' + email +
              '. To cancel or reschedule, reply to that email.',
          },
        ],
      };
    }
    const explain = {
      taken: 'That slot was just taken — call list_slots again and pick another.',
      unknown_slot: 'That slot id does not exist — call list_slots again and use a current id.',
      invalid_input: 'The backend rejected the input — check the email address.',
    };
    return {
      content: [{ type: 'text', text: 'Booking failed: ' + (explain[result.reason] || 'unexpected backend answer (' + result.reason + '). The user can email hello@eleviq.solutions instead.') }],
      isError: true,
    };
  }

  return { content: [{ type: 'text', text: 'Unknown tool: ' + params.name }], isError: true };
}
