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

## Blocco successivo: Durable Object per tentativi Offer Only (22 ottobre)

Aggiunti `src/marketplace-amazon-offer-attempt-journal.ts`, binding Cloudflare `MARE_AMAZON_OFFER_JOURNAL` e migration `v5_amazon_offer_only_attempt_journal`. Il nuovo oggetto è esportato nel Worker, ma **non esiste alcuna route pubblica, MCP capability, scheduler o factory di esecuzione che lo colleghi ad Amazon PUT**. Il writer live rimane disabilitato.

- La chiave Durable Object deriva dallo scope rigido `offer-only-v1:{seller}:{market}:{sku}`; una transazione SQLite persistente scrive il primo claim prima di qualunque invio. Un nuovo piano sullo stesso scope non può sovrascrivere il vecchio claim. La registrazione non ha TTL e un riavvio non ripristina il permesso di invio.
- `/claim`, `/record` e `/read` sono endpoint solo **interni alla binding Durable Object**, protetti da credenziale server-side. I risultati accettano solo campi whitelisted e stati monotoni: CLAIMED → outcome terminale incerto oppure ACCEPTED_PENDING_READBACK → OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED. Gli esiti HTTP incerti restano terminali per evitare doppie PUT.
- `makeAmazonOfferJournalClient` è un adapter per **una sola esecuzione**, non condivisibile fra richieste. Supporta le dipendenze `atomicClaim` e `storeAttemptResult` del writer in sviluppo, ma **non** collega i due componenti automaticamente, né sostituisce le approvazioni brand/GPSR/Channable mancanti.
- Test sintetico `npm run test:amazon-offer-attempt-journal`, eseguito in Miniflare con DO SQLite reale: 16 claim concorrenti dello stesso scope, persistenza dopo restart, isolamento per marketplace, nessun nuovo claim dopo timeout/HTTP sconosciuto, conflitti submissionId, divieto di migliorare a VERIFIED senza precedente ACCEPTED e readback verificato, filtro contro payload privati.

**Gates ancora mancanti:** prova trusted su brand/GPSR e price policy, isolation Channable comprovata per SKU/paese, controllo rigoroso della provenienza dell'attestazione di approvazione (piano immutabile server-side), test in ambiente controllato di fine flusso e approvazione esplicita prima di un primo zero-stock canary reale. Il superamento della CI non equivale a un go-live.

## Gate strutturati di autorizzazione e esclusione Channable — 22 ottobre

Aggiunto `src/marketplace-amazon-offer-proof-gates.ts` e rafforzata l'esecuzione della canary in PR #263. I vecchi valori `verified:true` e `all_competing_writers_disabled:true` **non sono più sufficienti**. Ogni proof deve essere generata da un servizio backend indipendente, mai da parametri del chiamante, e deve riferirsi esattamente a seller, marketplace, SKU, EAN, ASIN, ID variante Shopify, versione/checksum PTD e policy prezzo.

**Brand/compliance approval:** il servizio backend futuro deve leggere un review ledger immutabile, con origine indipendente `SERVER_VERIFIED_IMMUTABLE_REVIEW`, identificativo del revisore, digest verificato, riscontro Seller Central per *quello specifico marketplace*, dossier GPSR/produttore, precedente submission della VALIDATION_PREVIEW, policy prezzo e readiness ordini/tracking. Controllo TTL 15 minuti. Un esito Amazon di `restrictions:[]` NON certifica approvazione; un archivio di riferimenti documentali NON certifica automaticamente provenienza e integrità. **Reader e verifica firma del ledger ancora assenti**.

**Writer isolation:** il servizio provider futuro deve eseguire una lettura live, completa e attendibile delle esportazioni Amazon del progetto Channable M.A.R.E. azienda `99008`, progetto `328207`. Deve dimostrare che ogni export Amazon applicabile a quel mercato esclude proprio lo SKU, che la sincronizzazione della regola è terminata con successo, che l'inventario degli export è completo e che non restano altri writer attivi. Prova con TTL 5 minuti, origine `CHANNABLE_API_EXPORT_READBACK`. Il codice controlla l'insieme di prove e respinge export duplicati, un solo export ancora attivo, timestamp scaduti, account/paese/SKU errati e inventari incompleti. **Nessun accesso Channable provider è attualmente connesso; non esiste un reader live implementato, quindi il gate rimane chiuso**.

**Divieto di false promozioni:** solo quando i due reader backend fidati saranno implementati e testati, e avranno provato le fonti originarie, potranno alimentare l'esecuzione. I test unitari usano attestazioni **esplicitamente sintetiche** solo per validare i contratti; non certificano Channable o Seller Central. Nessun flag attivato, nessuna route in produzione e nessuna nuova offerta creata.
