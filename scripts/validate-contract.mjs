const validTypes = new Set(["product_advice", "faq", "order_help", "fallback"]);
const validSuggestionTypes = new Set(["product", "collection", "search"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateSuggestionArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array`);
  for (const [index, item] of value.entries()) {
    assert(item && typeof item === "object" && !Array.isArray(item), `${field}[${index}] must be an object`);
    assert(typeof item.label === "string" && item.label.length > 0, `${field}[${index}].label is required`);
    assert(typeof item.message === "string" && item.message.length > 0, `${field}[${index}].message is required`);
    assert(typeof item.url === "string" && item.url.length > 0, `${field}[${index}].url is required`);
    assert(validSuggestionTypes.has(item.type), `${field}[${index}].type is invalid`);
  }
}

function validateAssistantResponseShape(response) {
  assert(response && typeof response === "object" && !Array.isArray(response), "response must be an object");
  assert(response.ok === true, "ok must be true for usable responses");
  assert(response.source === "ai_backend" || response.source === "backend_fallback", "source is invalid");
  assert(validTypes.has(response.type), "type is invalid");
  assert(typeof response.title === "string", "title must be a string");
  assert(typeof response.message === "string", "message must be a string");
  assert(response.primary_cta === null || (typeof response.primary_cta?.label === "string" && typeof response.primary_cta?.url === "string"), "primary_cta must be object or null");
  validateSuggestionArray(response.devid_label_alternatives, "devid_label_alternatives");
  validateSuggestionArray(response.cross_sell, "cross_sell");
  assert(typeof response.requires_backend_order_lookup === "boolean", "requires_backend_order_lookup must be boolean");
  assert(Array.isArray(response.guardrails), "guardrails must be an array");
}

const examples = [
  {
    ok: true,
    source: "ai_backend",
    type: "product_advice",
    title: "T-shirt MC2 Saint Barth uomo",
    message: "Ti mostro prima le proposte MC2 Saint Barth coerenti con la tua ricerca.",
    primary_cta: { label: "Vedi risultati Saint Barth", url: "/search?type=product&q=mc2%20saint%20barth%20t-shirt%20uomo" },
    devid_label_alternatives: [
      { label: "T-shirt Mosca Devid Label", message: "Alternativa Devid Label in jersey, essenziale e facile da abbinare.", url: "/products/devid-label-t-shirt-100-cotone-scollo-a-v-bianco-mosca-dlmosca-bianco", type: "product" },
    ],
    cross_sell: [{ label: "Bermuda uomo", message: "Completa il look estivo.", url: "/collections/bermuda-shorts-uomo", type: "collection" }],
    requires_backend_order_lookup: false,
    guardrails: [],
  },
  {
    ok: true,
    source: "backend_fallback",
    type: "order_help",
    title: "Dov’è il mio ordine?",
    message: "Non invento tracking.",
    primary_cta: null,
    devid_label_alternatives: [],
    cross_sell: [],
    requires_backend_order_lookup: true,
    guardrails: [],
  },
];

for (const example of examples) validateAssistantResponseShape(example);
console.log(`Validated ${examples.length} assistant response contract examples.`);
