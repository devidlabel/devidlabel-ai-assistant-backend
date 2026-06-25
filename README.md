# Devid Label AI Assistant Backend V1

Cloudflare Worker TypeScript per la Search & Support Assistant del tema Shopify Devid Label. Il Worker espone `POST /chat`, valida il payload del frontend, applica guardrail privacy-safe, chiama un provider AI server-side quando `OPENAI_API_KEY` è configurata e restituisce sempre un JSON coerente con il response contract del tema.

## File creati

- `src/index.ts`: Worker Cloudflare con endpoint `/chat`, CORS, validazione, guardrail, chiamata OpenAI e fallback.
- `wrangler.toml`: configurazione Wrangler e variabili non segrete.
- `package.json`: script `dev`, `deploy`, `typecheck`, `build` e dipendenze.
- `tsconfig.json`: configurazione TypeScript strict per Workers.
- `.gitignore`: esclude secret e file locali.
- `.env.example`: template locale senza valori reali.
- `README.md`: istruzioni operative e limiti V1.

## Installazione

```bash
npm install
```

## Sviluppo locale

Copia `.env.example` in `.dev.vars` o configura le variabili tramite Wrangler. Non committare `.dev.vars`.

```bash
npm run dev
```

Il Worker sarà disponibile di default su `http://localhost:8787`.

## Endpoint `/chat`

### Metodo

`POST /chat`

`OPTIONS /chat` è supportato per il preflight CORS. Gli altri metodi restituiscono `405`.

### Payload accettato

Il backend accetta e processa solo questi campi:

- `query`
- `locale`
- `page_context`
- `cart_context`
- `knowledge_version`

Esempio:

```json
{
  "query": "t-shirt saint barth uomo",
  "locale": "it-IT",
  "page_context": {
    "page_type": "search_assistant",
    "path": "/"
  },
  "cart_context": [
    {
      "vendor": "Replay",
      "product_type": "Jeans",
      "title": "Jeans Uomo Straight Fit",
      "variant": "29"
    }
  ],
  "knowledge_version": "1.0"
}
```

### Validazione

- `query` è obbligatoria.
- `query` viene troncata a 500 caratteri.
- `cart_context` viene limitato a 10 item.
- Le stringhe in `cart_context` vengono troncate a 200 caratteri.
- JSON non valido o payload non oggetto restituiscono un errore JSON controllato.
- Campi extra non vengono processati. Campi potenzialmente sensibili come email, telefono, nome, cognome, indirizzo, dati pagamento, customer id, order id, token e secret vengono ignorati e segnalati nei `guardrails`.

### Response contract

Il Worker restituisce sempre JSON. Le risposte positive rispettano questa forma:

```json
{
  "ok": true,
  "source": "ai_backend",
  "type": "product_advice",
  "title": "Titolo sintetico",
  "message": "Messaggio per il cliente.",
  "primary_cta": null,
  "devid_label_alternatives": [],
  "cross_sell": [],
  "requires_backend_order_lookup": false,
  "guardrails": []
}
```

Tipi supportati:

- `product_advice`
- `faq`
- `order_help`
- `fallback`

## CORS

Le origini consentite di default sono:

- `https://devidlabel.com`
- `https://www.devidlabel.com`

Puoi configurare origini aggiuntive con `ASSISTANT_ALLOWED_ORIGINS`, usando una lista separata da virgole. Per sviluppo locale aggiungi esplicitamente `http://localhost:8787` o l'origine del tema in preview. Il Worker non usa `*` come origine consentita.

Esempio locale:

```bash
ASSISTANT_ALLOWED_ORIGINS=https://devidlabel.com,https://www.devidlabel.com,http://localhost:8787
```

## Chiamata AI

Quando `OPENAI_API_KEY` è presente, il Worker chiama l'endpoint OpenAI Chat Completions server-side. Il modello è configurabile con `ASSISTANT_MODEL`; il default è `gpt-4o-mini`.

Il prompt impone che l'assistente:

- risponda sempre in italiano;
- mantenga tono commerciale e sintetico;
- ricordi che Devid Label è brand proprietario;
- tratti i brand esterni come originali;
- comunichi che InPost è gratis scegliendo Locker/Punto InPost;
- comunichi che il contrassegno è disponibile solo con spedizione a domicilio;
- non inventi prezzi, disponibilità, tracking o status ordine;
- non dica Made in Italy se non verificato;
- rispetti il brand esterno cercato;
- proponga Devid Label come alternativa o abbinamento solo se coerente;
- per stato ordine V1 non faccia lookup reale.

La chiamata AI ha timeout massimo di 7 secondi. In caso di timeout o errore provider, il Worker usa il fallback statico.

## Fallback

Se manca `OPENAI_API_KEY`, se il provider fallisce o va in timeout, il Worker non espone errori tecnici al frontend. Restituisce invece `source: "backend_fallback"` con regole statiche per:

- pagamento alla consegna;
- prodotti originali;
- tempi spedizione;
- InPost;
- dov'è il mio ordine;
- fallback generale.

Per richieste sullo stato ordine, V1 restituisce `requires_backend_order_lookup: true`, ma non chiede né processa dati ordine reali.

## Guardrail e privacy

- Nessuna API key nel codice.
- Nessun secret in `.env.example`.
- `.env`, `.env.*` e `.dev.vars` sono ignorati da Git.
- Il Worker non logga il payload completo.
- Gli errori tecnici non vengono restituiti al frontend.
- Campi extra e sensibili sono ignorati.
- V1 non legge ordini e non chiama Shopify Admin API.

## Rate limiting

V1 non include un rate limiting persistente. Per produzione è consigliato configurare Cloudflare WAF, Turnstile, rate limiting rules o un meccanismo robusto server-side. Un rate limit in-memory in Worker non sarebbe affidabile perché le isolate possono essere replicate o riciclate.

## Impostare secret Cloudflare

```bash
wrangler secret put OPENAI_API_KEY
```

Poi incolla la chiave quando Wrangler la richiede. Non inserirla in `wrangler.toml` e non committarla.

## Variabili non segrete

Puoi configurare modello e origini consentite in `wrangler.toml`, Dashboard Cloudflare o ambienti Wrangler:

```toml
[vars]
ASSISTANT_MODEL = "gpt-4o-mini"
ASSISTANT_ALLOWED_ORIGINS = "https://devidlabel.com,https://www.devidlabel.com"
```

## Test locale con curl

FAQ contrassegno:

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"pagamento alla consegna","locale":"it-IT","knowledge_version":"1.0"}'
```

Consiglio prodotto:

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"t-shirt saint barth uomo","locale":"it-IT","page_context":{"page_type":"search_assistant","path":"/"},"cart_context":[{"vendor":"Replay","product_type":"Jeans","title":"Jeans Uomo Straight Fit","variant":"29"}],"knowledge_version":"1.0"}'
```

JSON non valido:

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{bad json}'
```

Missing query:

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"locale":"it-IT"}'
```

Preflight OPTIONS:

```bash
curl -i -X OPTIONS "http://localhost:8787/chat" \
  -H "Origin: https://devidlabel.com" \
  -H "Access-Control-Request-Method: POST"
```

## Collegare endpoint al tema Shopify

Nel tema Shopify, configura l'URL del Worker come endpoint backend dell'assistente, per esempio:

```text
https://<worker-subdomain>.workers.dev/chat
```

Il frontend deve inviare solo il payload consentito e non deve includere API key, token, customer id, order id, dati pagamento o dati personali sensibili. Il browser non deve chiamare OpenAI né Shopify Admin API direttamente.

## Deploy

```bash
npm run deploy
```

Prima del deploy, assicurati di avere impostato il secret:

```bash
wrangler secret put OPENAI_API_KEY
```

## Cosa NON fa ancora la V1

- Non gestisce ordini reali.
- Non esegue lookup ordine.
- Non chiama Shopify Admin API.
- Non usa webhook Shopify.
- Non implementa sconti.
- Non implementa add-to-cart.
- Non usa database.
- Non inventa disponibilità, prezzi, tracking o status ordine.

## Rischi residui

- Il fallback statico è intenzionalmente limitato e non sostituisce una knowledge base completa.
- Senza rate limiting Cloudflare/WAF, l'endpoint può ricevere traffico eccessivo.
- La risposta AI viene normalizzata, ma un catalogo server-side sarà necessario per evitare consigli non verificati su disponibilità e prezzi.
- Le origini Shopify preview devono essere aggiunte esplicitamente a `ASSISTANT_ALLOWED_ORIGINS`.

## Prossimi step

1. Aggiungere catalogo/knowledge server-side controllata.
2. Implementare order status backend con Shopify Admin API solo server-side.
3. Introdurre rate limiting produzione con Cloudflare WAF, Turnstile o rules.
4. Aggiungere logging privacy-safe e metriche.
5. Collegare il tema Shopify all'endpoint Worker e validare il response contract in staging.

## Test manuali response contract Task 02

Esegui il Worker in locale con `npm run dev`, poi usa questi curl per verificare che ogni risposta positiva mantenga sempre `primary_cta` come oggetto o `null`, `devid_label_alternatives` e `cross_sell` come array di oggetti e `requires_backend_order_lookup` booleano.

1. T-shirt Saint Barth uomo: atteso `source: "ai_backend"`, `type: "product_advice"`, `primary_cta` non null, alternative Mosca + Monterosso come oggetti e `requires_backend_order_lookup: false`.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"t-shirt saint barth uomo","locale":"it-IT","knowledge_version":"1.0"}'
```

2. Jeans Replay uomo: atteso `type: "product_advice"`, alternativa Jeans Globe come oggetto e `requires_backend_order_lookup: false`.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"jeans replay uomo","locale":"it-IT","knowledge_version":"1.0"}'
```

3. Dov'è il mio ordine: atteso `type: "order_help"`, `requires_backend_order_lookup: true` e nessun tracking inventato.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"dov’è il mio ordine","locale":"it-IT","knowledge_version":"1.0"}'
```

4. Pagamento alla consegna: atteso `type: "faq"`, `requires_backend_order_lookup: false` e messaggio che conferma contrassegno a domicilio sì, InPost no.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"pagamento alla consegna","locale":"it-IT","knowledge_version":"1.0"}'
```

5. Zaino Sprayground: atteso `type: "product_advice"`, CTA Sprayground e nessuna alternativa Devid Label forzata.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"zaino sprayground","locale":"it-IT","knowledge_version":"1.0"}'
```

6. Query generica non mappata: atteso `type: "fallback"` oppure `product_advice` se l'AI è sicura, schema sempre valido e nessun array di stringhe.

```bash
curl -X POST "http://localhost:8787/chat" \
  -H "Content-Type: application/json" \
  -d '{"query":"mi consigli qualcosa per un look casual","locale":"it-IT","knowledge_version":"1.0"}'
```

Controllo automatico leggero della shape:

```bash
npm run validate:contract
```
