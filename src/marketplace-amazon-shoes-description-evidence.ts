/**
 * Bounded evidence locator for structured Shopify description markup.
 * This NEVER returns material claims or ready-to-submit listing values.
 * A detected label remains unverified merchant marketing copy and requires review.
 */
const LABEL_TO_ATTRIBUTE: Readonly<Record<string, string>> = Object.freeze({
  "modello": "model_name",
  "codice modello": "model_number",
  "colore": "color",
  "genere": "target_gender",
  "tomaia": "outer",
  "suola": "sole_material",
  "paese di origine": "country_of_origin",
  "produttore": "manufacturer",
  "chiusura": "closure",
});
const MAX_HTML_LENGTH = 24_000;
const EMPTY_VALUES = new Set(["-", "--", "n/a", "n.d.", "nd", "n.d", "non disponibile", "non indicato", "unknown", "tbd"]);
function hasUsableValue(text: string): boolean {
  const value = text.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").trim().toLowerCase();
  return value.length >= 2 && value.length <= 220 &&
    /[\p{L}\d]/u.test(value) && !EMPTY_VALUES.has(value);
}
export function locateAmazonShoesDescriptionCandidates(description: unknown): Readonly<Record<string, string>> {
  const found: Record<string,string> = Object.create(null);
  if (typeof description !== "string" || description.length === 0 ||
      description.length > MAX_HTML_LENGTH) return found;
  // Refuse executable/hidden markup: do not interpret tags inside script, styles
  // or comments as actual product data.
  const html = description
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,"")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,"")
    .replace(/<!--[\s\S]*?-->/g,"");
  const labels = /<strong(?:\s+[^>]*?)?>\s*([^<>:]{2,40})\s*:\s*<\/strong>\s*([^<]{1,220})/gi;
  let match: RegExpExecArray | null;
  let inspected = 0;
  while ((match = labels.exec(html)) !== null && inspected++ < 80) {
    const label = match[1].trim().toLowerCase().replace(/\s+/g," ");
    const attribute = LABEL_TO_ATTRIBUTE[label];
    if (!attribute || !hasUsableValue(match[2]) || Object.hasOwn(found,attribute)) continue;
    found[attribute] = "product.description_html:label:" + label.replace(/\s+/g,"_");
  }
  // Explicit "• Tomaia in mesh" style, used in some supplier descriptions.
  // This is merely an upper-material review candidate, NOT approved outer data.
  if (!Object.hasOwn(found,"outer")) {
    const bullet = /<p(?:\s+[^>]*?)?>\s*(?:•|&bull;|&#8226;)\s*tomaia\s+in\s+([^<]{2,220})<\/p\s*>/i.exec(html);
    if (bullet && hasUsableValue(bullet[1]))
      found.outer = "product.description_html:bullet:tomaia";
  }
  return found;
}
