const baseUrl = (process.env.ASSISTANT_PRODUCTION_URL || 'https://devidlabel-ai-assistant-backend.devidlabel.workers.dev').replace(/\/$/, '');
const liveOrigin = 'https://devidlabel.com';
const timeoutMs = 15000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    return {
      status: response.status,
      headers: response.headers,
      body,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function chat(query, locale = 'it-IT') {
  return request('/chat', {
    method: 'POST',
    headers: {
      Origin: liveOrigin,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      message: query,
      locale,
      language: locale.split('-')[0],
      country: locale.endsWith('-US') ? 'US' : 'IT',
      path: '/',
      page_context: {
        page_type: 'production_smoke_test',
        path: '/',
        locale,
        language: locale.split('-')[0],
      },
      cart_context: [],
      messages: [],
      conversation_state: null,
      knowledge_version: 'production-smoke-audit',
    }),
  });
}

function isValidAssistantResponse(result) {
  return result.status === 200
    && result.body
    && typeof result.body === 'object'
    && result.body.ok === true
    && typeof result.body.type === 'string'
    && typeof result.body.message === 'string'
    && Array.isArray(result.body.devid_label_alternatives)
    && Array.isArray(result.body.cross_sell);
}

function containsItalianLeak(message) {
  const normalized = String(message || '').toLowerCase();
  return [
    'pagamento alla consegna',
    'spedizione a domicilio',
    'non è disponibile',
    'puoi pagare',
  ].some((fragment) => normalized.includes(fragment));
}

const report = {
  target: baseUrl,
  checkedAt: new Date().toISOString(),
  checks: {},
  capabilities: {},
};

const root = await request('/');
assert(root.status === 200, `Root endpoint failed with status ${root.status}`);
report.checks.root = {
  ok: true,
  status: root.status,
  durationMs: root.durationMs,
  bodyHint: typeof root.body === 'string' ? root.body.slice(0, 80) : 'json',
};

const preflight = await request('/chat', {
  method: 'OPTIONS',
  headers: {
    Origin: liveOrigin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
});
const allowedOrigin = preflight.headers.get('access-control-allow-origin') || '';
assert(preflight.status === 204, `CORS preflight failed with status ${preflight.status}`);
assert(allowedOrigin === liveOrigin, `CORS did not allow ${liveOrigin}`);
report.checks.corsLive = {
  ok: true,
  status: preflight.status,
  allowOrigin: allowedOrigin,
  durationMs: preflight.durationMs,
};

const faq = await chat('pagamento alla consegna');
assert(isValidAssistantResponse(faq), 'FAQ response contract is invalid');
assert(faq.body.type === 'faq', `FAQ routed as ${faq.body.type}`);
report.checks.faq = {
  ok: true,
  type: faq.body.type,
  source: faq.body.source || '',
  durationMs: faq.durationMs,
  guardrails: Array.isArray(faq.body.guardrails) ? faq.body.guardrails : [],
};

const order = await chat("dov'è il mio ordine");
assert(isValidAssistantResponse(order), 'Order-help response contract is invalid');
assert(order.body.type === 'order_help', `Order query routed as ${order.body.type}`);
assert(order.body.requires_backend_order_lookup === true, 'Order query did not request secure lookup');
assert(order.body.needs_input === true, 'Order entry does not expose needs_input');
assert(order.body.order_lookup?.status === 'ask_order_number', `Unexpected order entry status: ${order.body.order_lookup?.status || 'missing'}`);
assert(order.body.conversation_state?.flow === 'order_lookup', 'Order entry does not expose conversation_state');
assert(order.body.conversation_state?.next_step === 'order_number', 'Order entry has an invalid next step');
assert(Array.isArray(order.body.suggested_replies), 'Order entry does not expose suggested replies');
report.checks.orderEntry = {
  ok: true,
  type: order.body.type,
  durationMs: order.durationMs,
  requiresLookup: true,
  orderStatus: order.body.order_lookup.status,
  needsInput: order.body.needs_input,
  nextStep: order.body.conversation_state.next_step,
  suggestedReplyCount: order.body.suggested_replies.length,
};

const english = await chat('cash on delivery', 'en-US');
assert(isValidAssistantResponse(english), 'English FAQ response contract is invalid');
assert(english.body.type === 'faq', `English FAQ routed as ${english.body.type}`);
assert(!containsItalianLeak(english.body.message), 'English response contains an Italian copy leak');
report.checks.english = {
  ok: true,
  type: english.body.type,
  durationMs: english.durationMs,
  italianLeakDetected: false,
};

const commerce = await chat('sprayground');
assert(isValidAssistantResponse(commerce), 'Commerce response contract is invalid');
assert(commerce.body.type === 'product_advice', `Commerce query routed as ${commerce.body.type}`);
assert(Array.isArray(commerce.body.recommended_products), 'Commerce response does not expose recommended_products');
assert(commerce.body.commerce_intent && typeof commerce.body.commerce_intent === 'object', 'Commerce response does not expose structured commerce_intent');
assert(typeof commerce.body.ranking_strategy === 'string' && commerce.body.ranking_strategy.length > 0, 'Commerce response does not expose ranking_strategy');
report.checks.commerce = {
  ok: true,
  type: commerce.body.type,
  durationMs: commerce.durationMs,
  recommendedCount: commerce.body.recommended_products.length,
  alternativeCount: commerce.body.devid_label_alternatives.length,
  crossSellCount: commerce.body.cross_sell.length,
  rankingStrategy: commerce.body.ranking_strategy,
  vendor: commerce.body.commerce_intent.vendor || '',
  category: commerce.body.commerce_intent.category || '',
  intent: commerce.body.intent || commerce.body.normalized_query?.intent || '',
  recommendationGuardrails: Array.isArray(commerce.body.recommendation_guardrails)
    ? commerce.body.recommendation_guardrails
    : [],
};

report.capabilities = {
  conversationalState: true,
  secureOrderEntry: true,
  bilingualRouting: true,
  dynamicRecommendations: true,
  structuredCommerceIntent: true,
  suggestedReplies: true,
};

console.log(JSON.stringify(report, null, 2));
