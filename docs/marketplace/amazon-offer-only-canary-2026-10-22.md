# Amazon EU Offer Only — guarded canary foundation (22 ottobre 2026)

## Stato

PR tecnica in bozza, non pronta per il LIVE. Introduce moduli isolati per preparare e costruire una singola offerta Amazon su ASIN esistente a quantità zero. Il componente non è connesso ai route/MCP/scheduler: in produzione la capability amazon.listings.sync resta NOT IMPLEMENTED. Nessuna offerta o ASIN viene creata con questa PR da sola.

Shopify è il catalogo di riferimento. Channable DL-Shopify resta writer operativo su Amazon IT/DE/FR/ES per offerte, stock, prezzi, ordini e tracking. Nessuna modifica Shopify frontend. TikTok Shop separato; Spartoo in fase successiva.

## Regole Offer Only

- Solo ASIN esistente con EAN esatto, SKU venditore verificato assente, nessuna offerta già sotto altro SKU e varianti/catalogo coerenti. La creazione di un nuovo ASIN (4B12) è un flusso **distinto**, non coperto da questa PR.
- PUT Amazon Listings Items v2021-08-01, requirements LISTING_OFFER_ONLY, categoria PRODUCT dopo verifica PTD, condition_type=new_new, merchant_suggested_asin, prezzo EUR esplicitamente approvato, fulfillment_availability DEFAULT con quantity **0**.
- La PUT Amazon può creare **o aggiornare**: stop se offerta già presente. ACCEPTED significa accettazione della submission, non offerta acquistabile.
- Non dedurre un prezzo Amazon dal prezzo Shopify. Il prezzo commerciale per paese deve essere approvato da un verifier trusted e coerente con lo snapshot prima della PUT.
- Non dedurre autorizzazioni brand o GPSR da una VALIDATION_PREVIEW verde.

## Gate obbligatori prima di qualsiasi test live

1. Feature flag server-side AMAZON_OFFER_ONLY_LIVE_ENABLED=true: default off, non impostato in produzione.
2. Preflight fresco SP-API e Shopify prima della preparazione e ancora prima della possibile PUT; verifica EAN, ASIN, seller SKU, seller ASIN cross-SKU, Seller Restrictions e PTD.
3. Verifier server-side per piano immutabile approvato: identità, brand authorization per paese, GPSR/compliance, schema + valid preview, policy prezzo e readiness ordini/tracking. **NON IMPLEMENTATO**.
4. Verifier server-side per esclusione writer Channable effettivamente dimostrata sullo SKU/market (max 5 min), senza presumere che togliere un prodotto dal feed sia innocuo. **NON IMPLEMENTATO**.
5. Claim durevole, atomico e non riutilizzabile, scoped seller/market/SKU/piano prima del PUT. Su timeout, crash e HTTP incerto non si ripete mai la PUT. **NON IMPLEMENTATO**.
6. Journal durevole del tentativo e del risultato con readback ed eventuale riconciliazione, mai retry automatico. **NON IMPLEMENTATO**.
7. Approvazione esplicita del primo canary zero-quantity, prova operativa esclusione Channable, monitoraggio e rollback. Per stock positivo successiva prova completa di sincronizzazione vendite, ordini e tracking.

Il writer non può inviare nulla fino a quando i servizi di 3, 4, 5, 6 non sono connessi dal backend. Non esporre il modulo come capability implemented:true prima di tali prove, del test di concorrenza su Durable Object e della separata approvazione.

## Failure safety e test

Il body non accetta attributi Amazon arbitrari dall'utente, solo i quattro identificativi validati e il prezzo da policy verificata. Lo stock è sempre zero. Il preflight preparato dura al massimo 15 minuti, proof di writer isolation 5 minuti. Il claim atomico è irrevocabile in caso di provider timeout o esito incerto. La risposta provider è JSON bounded a 64KiB. ACCEPTED viene confermato soltanto con lettura seller SKU, ASIN e quantità zero; non prova BUYABLE. Ogni errore di persistenza lascia lo stato UNCERTAIN e vieta un secondo PUT.

Comando di test offline: npm run test:amazon-offer-only-canary, incluso nella suite marketplace-runtime. Tutto mockato; nessuna chiamata reale Amazon. Copertura prevista: payload, flag off, staleness, identity drift, brand/GPSR/price, isolamento, replay, ricezione incerta e readback asincrono.

Documentazione Amazon: https://developer-docs.amazon.com/sp-api/docs/submit-listings-data e https://developer-docs.amazon.com/sp-api/reference/putlistingsitem

## Evidence pack 4B12 separato

SKU 4B12_HYPER_U3027_41_EU (EAN 8057270145605) e 4B12_PLAYNEW_D2026_38_EU (EAN 8057270146725), tutti i mercati: seller SKU verificato assente e nessun exact EAN match, **17 issues per SKU/market** nelle VALIDATION_PREVIEW del 22/10/2026. Gli attributi produttore/compliance non possono essere inventati.

| Attributi Amazon ancora assenti | Evidenza da richiedere | Livello di riutilizzo |
| --- | --- | --- |
| manufacturer, country_of_origin | Dossier fabbricante e dichiarazione importatore | Brand/modello se confermato |
| sole_material, leather_type | Specifiche del produttore | Modello e variante/materiale |
| item_package_dimensions, item_package_weight, inner, outer | Misure e pesi reali packaging | Singola taglia o range certificato |
| lifestyle, age_range_description, style | Scheda commerciale ufficiale e mapping PTD | Modello, revisione per paese |
| shaft, strap_type, height_map | Scheda tecnica con applicabilità PTD | Modello, non inferire non-applicabilità |
| batteries_required, water_resistance_level | Dichiarazione produttore e regole PTD | Modello, nessun default inventato |
| list_price | Listino valido per il mercato e periodo | Paese/periodo; non Shopify compare-at |
| Gate separati | Autorizzazioni brand Seller Central, GPSR e responsabile UE | Brand, mercato e articolo |

Avanzamento dati: raccogliere schede fornitore e mappare i valori confermati con fonte/versione/ambito, riutilizzando i dati sui modelli soltanto se validi per le rispettive taglie. Non modificare frontend Shopify. Non inviare nuovi ASIN finché schema, GPSR, brand e writer non sono verificati.
