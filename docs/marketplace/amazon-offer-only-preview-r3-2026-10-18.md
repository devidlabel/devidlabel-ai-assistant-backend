# Amazon Offer Only — R3 preview di validazione a quantità zero

**Stato:** componente interno di sviluppo nella PR #199; non distribuito né disponibile attraverso un tool pubblico/business. Nessun prodotto Amazon creato, pubblicato o modificato.

## Percorso di validazione

1. Identità Shopify completa e unica (SKU/EAN/variante, stato ACTIVE e stock attivo), match EAN→ASIN esatto e brand coerente, nessuna offerta già presente per seller+SKU. Le anomalie di modello/colore/categoria e la conformità sono sempre da revisionare.
2. Il preflight R0 restituisce `REVIEW_REQUIRED`, non `READY_TO_PUBLISH`. Include ora prezzo originario Shopify in minor units per evitare aritmetica binaria sui decimali del piano.
3. Il componente interno `previewAmazonOfferOnlyZeroQuantity` è disabilitato di default (`AMAZON_OFFER_PREVIEW_ENABLED` non impostato), richiede Seller ID server-side e una lettura preflight completa. Non accetta body arbitrari né flag `LIVE`.
4. Quando espressamente abilitato in ambiente controllato, costruisce `productType: PRODUCT`, `requirements: LISTING_OFFER_ONLY` con `merchant_suggested_asin`, `condition_type: new_new`, prezzo EUR, `fulfillment_availability: 0`. Invia esclusivamente `putListingsItem?mode=VALIDATION_PREVIEW`; il parametro mode e la quantità zero sono costanti di codice, non di request.
5. Risposta Amazon `VALID` o `INVALID` e issues = evidenza di validazione; **non** prova che la nuova offerta esista o sia acquistabile. Lo stato restituito è sempre `PREVIEW_REVIEW_REQUIRED` e `can_publish:false`.
6. Nessun endpoint `putListingsItem` LIVE, `patchListingsItem`, `deleteListingsItem`, `JSON_LISTINGS_FEED`, inventario o stock viene introdotto.

## Blocchi prima del primo pilot e go-live

- Secret `AMAZON_SP_API_SELLER_ID` e ruolo Product Listing/Orders dell'app Amazon da verificare con test autenticato.
- Scaricamento/validazione del Product Type schema mediante checksum, eventuali regole GPSR e attributi obbligatori del seller/marketplace; la preview può individuare errors ma non sostituisce questa revisione.
- Dati prezzo/stock freschi e policy versionata da applicare per paese; non derivare prezzi marketplace soltanto dal prezzo Shopify se il canale ha regole proprie.
- Channable: responsabilità di scrittura dell'offerta e quantità nel mercato/SKU pilota, controllata; importazione ordini esistente può essere mantenuta nel frattempo solo dopo prova di copertura dello SKU e del paese.
- Il primo stock vendibile richiede conferma di import ordini, prenotazioni e spedizione/tracking, inclusa concorrenza con Shopify/POS. Nessuna quantità positiva senza prove.
- Per test massivi riutilizzare schema validato e `JSON_LISTINGS_FEED` con lotti limitati soltanto dopo pilot singolo, rollback e lettura remota.

Modello ufficiale Amazon: [Listings Items v2021-08-01](https://github.com/amzn/selling-partner-api-models/blob/main/models/listings-items-api-model/listingsItems_2021-08-01.json); documentazione Amazon su `LISTING_OFFER_ONLY` e `VALIDATION_PREVIEW`.

**La PR #199 resta draft e non va mergiata né deployata come sistema pronto al LIVE sulla base dei soli test sintetici.**


## R3.1 — Controllo alternativo Listings Items GET (senza Seller Report)

Il modulo `src/mare-business-amazon-listings-direct.ts` aggiunge la capability privata `amazon.seller.listings.direct`, che usa direttamente la **Listings Items API GET** per verificare fino a 8 SKU per richiesta nel singolo marketplace (IT/DE/FR/ES). È isolato dal download dei report Amazon, che in alcune sessioni restituisce `amazon_report_download_network_error`.

- `PRESENT`: risposta 200 coerente con SKU e marketplace, con stato comprensivo di eventuali `BUYABLE` o issue.
- `PRESENT_ATTRIBUTES_UNKNOWN`: risposta 200 coerente con SKU ma senza riepilogo del marketplace richiesto. **Non** significa che l'offerta sia acquistabile, ma nemmeno mancante.
- `VERIFIED_ABSENT`: solo se Amazon restituisce HTTP 404 con body JSON ben formato, un unico codice `NOT_FOUND` e un request ID valido.
- `UNKNOWN`: 404 ambiguo, 403, throttling 429, 5xx, rete, JSON non coerente o risposta alterata. Nessuna supposizione di assenza.

I test sintetici in `scripts/test-amazon-seller-listings-direct.mjs` coprono 200, 404 verificato, 404 ambiguo, 429, errore di rete, mismatch SKU e input sospetti. La capability non ha operazioni di scrittura e **non risolve da sola la proprietà del writer Channable** né la conformità del prodotto.

**La presenza del Seller ID sul server, i ruoli SP-API e una prova live su offerte note devono ancora essere dimostrati.** Questa PR non è ancora distribuita.
