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

## Task 03 — Query normalization, alias typo e response contract V2

Il Worker normalizza la query prima di decidere se usare routing deterministico o provider AI. Il flusso è:

1. validazione payload;
2. normalizzazione deterministica (`lowercase`, trim, accenti/apostrofi/punteggiatura e spazi multipli);
3. alias, typo e partial intent matching;
4. routing FAQ/order;
5. routing prodotto per intenti forti;
6. chiamata AI solo se non esiste un intent forte;
7. normalizzazione della risposta AI;
8. fallback statico se il provider fallisce o manca la API key.

La response resta compatibile con il frontend V1 (`primary_cta`, `devid_label_alternatives`, `cross_sell`, `requires_backend_order_lookup`) e aggiunge campi opzionali V2:

- `recommended_products`
- `normalized_query`
- `intent`
- `confidence`

`requires_backend_order_lookup` è `true` solo per richieste ordine/tracking/stato ordine. Per query prodotto, typo prodotto e FAQ resta sempre `false`.

### Alias e typo gestiti

Intenti prodotto coperti dal livello deterministico:

- `mc2_saint_barth`: Saint Barth, MC2, `san bat`, `san bart`, `sain barth`, varianti simili.
- `sprayground`: Sprayground, `sprygrund`, `sprygrounf`, `spraygrund`, `spraygr`, `spry`.
- `jeans_globe_devid_label`: Jeans Globe Devid Label, `globe`, `denim globe`, `jeans dl`.
- `cargo_courmayeur_devid_label`: Cargo Courmayeur, `courma`, `courmayer`, `courmay`.
- `tshirt_mosca_devid_label`: Mosca, T-shirt Mosca, tee/maglia Mosca, scollo a V uomo.
- `monterosso_devid_label`: Monterosso, T-shirt/Maglia/Filo/Cotone Monterosso.
- `jeans_replay_uomo`: Jeans Replay uomo e varianti denim/replay.
- `kway`: K-Way, Kway, `kayway`, `kwai`.
- `mare_uomo`: costumi/mare uomo e costume Saint Barth uomo.
- `bermuda_uomo`: bermuda e shorts uomo.

Partial matching prudente:

- `glo` / `glob` → Jeans Globe Devid Label.
- `spry` / `sprayg` → Sprayground.
- `san ba` / `saint b` → MC2 Saint Barth.
- `courm` → Cargo Courmayeur Devid Label.
- `mosc` → T-shirt Mosca Devid Label.
- `mont` / `monte` → Monterosso Devid Label.
- `repl` → Replay solo con jeans/denim; `repla` è sufficiente da solo.
- `k-w` / `kwa` / `kway` → K-Way.

### Test manuali Task 03

Esegui il Worker locale con `npm run dev`, poi verifica:

```bash
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"san bat","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"sprygrund","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"sprygrounf","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"globe","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"courma","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"mosca","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"monterosso","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"dov’è il mio ordine","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"pagamento alla consegna","locale":"it-IT"}'
curl -X POST "http://localhost:8787/chat" -H "Content-Type: application/json" -d '{"query":"mi consigli qualcosa per un look casual","locale":"it-IT"}'
```

Atteso: le query alias prodotto rispondono `type: "product_advice"`, con `normalized_query` valorizzata e `requires_backend_order_lookup: false`; la query ordine risponde `type: "order_help"` e `requires_backend_order_lookup: true`; la query FAQ risponde `type: "faq"` e `requires_backend_order_lookup: false`; la query generica resta schema-valida con AI o fallback.

## Task 04 — Shopify recommendation ranking cache V1

La V1 aggiunge un motore merchandising server-side e cache-based per arricchire le risposte `product_advice` con `recommended_products` dinamici e, quando coerente, `devid_label_alternatives` dinamiche. La Shopify Admin API resta chiamata solo dal Cloudflare Worker: il browser continua a usare esclusivamente `/chat` e non riceve token, vendite, quantità stock numeriche, dati ordine o dati cliente.

### Env e secrets richiesti

Variabili supportate dal Worker:

- `SHOPIFY_SHOP_DOMAIN`: dominio `.myshopify.com` del negozio, ad esempio `devidlabel.myshopify.com`. Può essere configurato come variabile non sensibile o come secret.
- `SHOPIFY_ADMIN_ACCESS_TOKEN`: token Admin API della Custom App Shopify. Deve essere sempre un secret Cloudflare.
- `SHOPIFY_API_VERSION`: versione Admin API da usare. Default documentato e configurato: `2025-10`.
- `SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS`: TTL della cache raccomandazioni. Default: `3600` secondi.

Imposta i secret con Wrangler senza committare valori reali:

```bash
npx wrangler secret put SHOPIFY_ADMIN_ACCESS_TOKEN
npx wrangler secret put SHOPIFY_SHOP_DOMAIN
```

`SHOPIFY_API_VERSION` e `SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS` possono stare in `wrangler.toml`, dashboard Cloudflare o variabili ambiente. Non inserire token in `wrangler.toml`, `.env.example`, README o tema Shopify.

### Scope Shopify Custom App

La Custom App Shopify deve avere questi scope Admin API:

- `read_products`: legge titolo, vendor, handle, immagini, product type, tag e varianti.
- `read_inventory`: legge quantità/availability delle varianti per evitare prodotti non disponibili.
- `read_orders`: aggrega il venduto degli ultimi 30 giorni per ranking bestseller.

La repository non crea automaticamente la Custom App e non contiene secret.

### Shopify GraphQL client

Il client `shopifyGraphQL<T>(env, query, variables)` costruisce l'endpoint `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, invia `X-Shopify-Access-Token` e `Content-Type: application/json`, applica timeout breve e converte errori HTTP/GraphQL in errori controllati. Non logga token, payload ordine o dati personali; in caso di config mancante, timeout, rate limit o errore API, `/chat` degrada al fallback esistente con guardrail `shopify_recommendations_unavailable`.

### Intent, venduto 30 giorni e prodotti candidati

La mappa server-side copre intent forti come MC2 Saint Barth, Sprayground, Replay jeans uomo, Devid Label Globe/Courmayeur/Mosca/Monterosso, K-Way, mare uomo e vendor generici tra i vendor iniziali documentati. Per ogni intent il Worker ricava vendor, termini prodotto/categoria e alternative Devid Label ammesse.

`fetchSalesRankLast30Days` interroga gli ordini degli ultimi 30 giorni con batch limitato, esclude per quanto possibile ordini cancellati e preferisce ordini paid/partially paid. Legge solo line item product/variant/quantity e aggrega `unitsSold30d`, variant id vendute, revenue opzionale e ultimo venduto per `productId`. Non salva né restituisce email, nomi, indirizzi, telefoni, payment data, customer id o order id. Limite V1: i refund complessi non sono riconciliati perfettamente.

`fetchCandidateProducts` legge via Admin GraphQL massimo 30 prodotti candidati e massimo 50 varianti per prodotto, con handle, vendor, product type, tag, immagine, published/status e variant availability/quantity. La Admin API non è mai chiamata dal frontend.

### Availability score e regola 50% varianti

`computeAvailabilityScore` distingue prodotti taglia unica e prodotti a taglie:

- taglia unica: una sola variante `Default Title`, `Taglia unica`, `Unica`, `Unico` o `One Size`; passa se almeno una variante ha `inventoryQuantity > 0` o `availableForSale: true`;
- taglie multiple: considera varianti con opzioni `Size`, `Taglia` o `Numero`; passa solo se `availableVariantCount / totalVariantCount >= 0.5`.

Esempi: S:1, M:0, L:1, XL:0 passa perché 2/4 = 50%; S:1, M:0, L:0, XL:0 non passa perché 1/4 = 25%.

### Ranking e alternative Devid Label

`rankRecommendations` filtra i non disponibili e ordina per:

1. unità vendute negli ultimi 30 giorni, discendente;
2. availability ratio, discendente;
3. coerenza con intent/query, discendente;
4. prodotto pubblicato/attivo quando disponibile.

Se non ci sono vendite recenti, usa un fallback coerente basato su disponibilità e coerenza, senza inventare bestseller. Restituisce massimo 3 prodotti principali.

`buildDevidLabelAlternatives` propone massimo 2 alternative Devid Label solo quando coerenti e disponibili: Mosca/Monterosso per MC2 Saint Barth t-shirt o mare uomo, Globe per Replay jeans uomo, Mosca/Monterosso per Cargo/Courmayeur. Sprayground e K-Way non forzano alternative Devid Label.

### Cache recommendation snapshot

La cache V1 è in-memory globale per isolate Cloudflare Worker. La chiave include intent, vendor, query corretta e gender/categoria quando presente. Il TTL è configurabile con `SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS` e di default vale 3600 secondi. Su cache hit `/chat` riusa lo snapshot; su cache miss calcola prodotti, vendite e alternative e salva lo snapshot. Se Shopify non è configurato o fallisce, la risposta resta valida e usa il fallback/static advice esistente.

### Integrazione `/chat`

Per risposte `type: "product_advice"`, il Worker prova ad arricchire:

- `recommended_products`: massimo 3 item dinamici con `{ label, message, url, image, type: "product" }`;
- `devid_label_alternatives`: massimo 2 item dinamici quando coerenti;
- `primary_cta` e `cross_sell`: mantenuti per compatibilità con il frontend attuale.

FAQ e order help non chiamano il ranking Shopify. Le risposte ordine mantengono `requires_backend_order_lookup: true` senza tracking inventato e senza dati personali.

### Test Task 04

```bash
npm run test:recommendations
npm run validate:contract
npm run typecheck
npm run build
git diff --check
rg -n "<secret-patterns>" .
```

Query manuali consigliate con Worker locale: `t-shirt saint barth uomo`, `san bat`, `sprayground`, `jeans replay uomo`, `globe`, `mosca`, `colmar`, `pagamento alla consegna`, `dov’è il mio ordine`.

### Deploy

1. Crea/configura la Custom App Shopify con `read_products`, `read_inventory`, `read_orders`.
2. Imposta i secret Cloudflare con `npx wrangler secret put SHOPIFY_ADMIN_ACCESS_TOKEN` e, se preferisci, `npx wrangler secret put SHOPIFY_SHOP_DOMAIN`.
3. Verifica `SHOPIFY_API_VERSION` e `SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS` in Wrangler/Dashboard.
4. Esegui `npm run typecheck`, `npm run build`, `npm run validate:contract`, `npm run test:recommendations`.
5. Esegui `npm run deploy`.

### Rischi residui e prossimi step

- Cache in-memory per isolate: non è condivisa globalmente tra tutte le isolate Cloudflare; KV/Cache API può diventare il prossimo step se serve persistenza cross-isolate.
- Ranking ordini V1 limitato a batch ragionevoli: cataloghi/volumi elevati possono richiedere job schedulato o endpoint admin protetto.
- Refund/parziali complessi non sono perfetti in V1.
- La coerenza intent è euristica e può essere raffinata con tag/collection Shopify più strutturati.
