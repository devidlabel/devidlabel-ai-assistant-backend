# Scouting Offer Only Amazon EU — checkpoint operativo 22/10/2026

**Scope:** lavoro read-only su account M.A.R.E. S.R.L. / Devid Label via M.A.R.E. Business OS e Amazon SP-API. **Non è un'autorizzazione alla pubblicazione.** Nessun intervento sulle offerte, Channable, Shopify, stock, prezzi o ordini.

## Risultato selezione sneakers

Campione di 52 SKU ACTIVE Shopify, inventory >0 ed EAN-13, dai vendor Devid Label, Puraai, Mou, Fessura, 4B12, Back70 e Pro-Keds, verificato tramite `amazon.sneakers.sku_state.readonly` nei quattro marketplace (208 combinazioni):
- `SELLER_BUYABLE`: **52** combinazioni.
- `NEW_ASIN_RESEARCH_REQUIRED`: **92** (NON si può assumere né usare un ASIN esistente).
- `RECHECK_REQUIRED`: **50** (assenza non comprovata).
- `SELLER_PRESENT_NOT_BUYABLE`: **4**.
- `SELLER_PRESENT_NEEDS_DIAGNOSTICS`: **10**.
- `EXISTING_ASIN_CANDIDATE` verificato tra le 208: **0**.

Il campione NON è l'intero catalogo. Le 4B12 non possono utilizzare OFFER_ONLY nei mercati privi di ASIN già esistente.

## Ricerca accessori Amazon EU

### Rains — 11 modelli/accessori univoci

11 varianti Shopify ACTIVE con EAN e stock positivo (borse, beauty case, zaini, borsoni):
- `amazon.catalog.exact.match`: **44/44 EAN exact-one** IT/DE/FR/ES, uno per SKU/paese.
- `amazon.seller.listings.direct`: su 44 stati, **40 PRESENT**, **3 PRESENT_ATTRIBUTES_UNKNOWN** (RNS_14040_MARSH su IT/FR/ES), **1 UNKNOWN**. **0 VERIFIED_ABSENT**. Quindi **nessun nuovo OFFER_ONLY** su questi 44 casi: SKU già presenti o stato ignoto.
- 3 Rains capispalla extra × 4 mercati: **12 EAN→ASIN exact-one e 12 SELLER PRESENT**. Alcuni non BUYABLE (es. `RNS_21490_BLACK_S` DE/FR/ES) con issue `100632`; prima diagnosticare, non ricreare.

### Sprayground — quattro borse/valigie

EAN exact-one: 4 su 4 in IT/DE, 3 su 4 in FR/ES.
- `SPR_910CL288NSZ` ha seller SKU **VERIFIED_ABSENT** in FR/ES ma **NO_EXACT_MATCH** EAN→ASIN in FR/ES: **NON candidato Offer Only**.
- `SPR_910CL288NSZ` IT seller `PRESENT_ATTRIBUTES_UNKNOWN`; DE seller PRESENT con product type `TABLETOP_GAME` malgrado articolo valigia.
- `SPR_910CL290NSZ` IT/DE seller PRESENT con product type `APPAREL` malgrado valigia, errori 8541 e 100632. Non affermare automaticamente che il product type sia la causa certa: richiede controllo Catalog Items/PTD.
- `SPR_910B8298NSZ` seller presente nei quattro mercati, 100632 e 8541; non duplicare.
- `SPR_910CL285NSZ` BUYABLE in diversi mercati; non duplicare.

### MC2 Saint Barth — controllo campione cappelli / abbigliamento

10 EAN→ASIN exact-one osservati nella ricerca mirata: IT 5, DE 2, FR 2, ES 1. **Tutti e 10 gli SKU/market avevano SELLER PRESENT**. Alcuni non BUYABLE con 100632; altri BUYABLE.
- `MC2_JUDE002 00311E_Taglia unica` seller assente DE/FR/ES, ma EAN non exact-one su quei mercati: non candidato OFFER_ONLY.
- Non dedurre autorizzazione brand dall'esistenza di un prodotto BUYABLE in un altro paese.

## Approvals / Restrizioni

14 combinazioni SKU+market con issue Seller Listing `100632` controllate tramite `amazon.qualification.restrictions.readonly`: **tutte 14** hanno `NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF`, zero link; seller listing ancora non BUYABLE. Nessuna approvazione deducibile, nessuna domanda salvata.

## Nuovo helper deterministico nel branch PR #263

`src/marketplace-amazon-offer-candidate-scout.ts` classifica dati raw *già acquisiti e attestati dalla fonte* Shopify + exact EAN Catalog Items + seller Listings GET in:
- `CANDIDATE_NEEDS_FULL_PREFLIGHT`: solo exact-one EAN→ASIN, SKU seller `VERIFIED_ABSENT` con 404 verificato e osservazione fresca; richiede **sempre** ulteriori gate, non autorizza PUT.
- `EXISTING_SELLER_OFFER`: SKU già presente con stesso ASIN, vietata duplicazione.
- `SELLER_LISTING_DIAGNOSTICS`: listing presente ma identity/attributes incoerenti o ignoti.
- `NEW_ASIN_RESEARCH`: manca exact EAN→ASIN in quel paese.
- `UNKNOWN_RECHECK`: osservazione incompleta, seller absent non provata, data stale, EAN non univoco.
- `INVALID_SHOPIFY_IDENTITY`: Shopify inattivo, stock non positivo, EAN-13 invalidato.

**Anche quando lo scout produce CANDIDATE_NEEDS_FULL_PREFLIGHT ritorna sempre `safe_for_live_offer:false`, `can_publish:false`.** Il payload del chiamante non produce prove trusted. Vanno aggiunte ricerche dell'ASIN presso seller sotto altri SKU, conferma brand/titolo/variante, listings restrictions, PTD VALIDATION_PREVIEW, GPSR, prezzo paese, audit Channable UI, Durable Object anti-replay e approvazione distinta.

Suite sintetica: `npm run test:amazon-offer-candidate-scout`, inclusa nella CI marketplace. Nessuna API live usata dai test.

## Ordine del prossimo intervento

1. Individuare un solo SKU con ASIN exact-one e seller 404 verified absent tramite scansione incrementale dei prossimi brand accessori/capispalla, usando `amazon.catalog.exact.match` e `amazon.seller.listings.direct` senza ripetere SKU già scartati.
2. Superato questo filtro, lanciare `amazon.offer.preflight`, che può respingere seller ASIN sotto altri SKU, mismatch catalogo o restrizioni.
3. Se preflight accettabile, `amazon.offer.validation.preview` (Amazon remote validation senza pubblicare) e Seller Central brand + GPSR country-wise.
4. Solo in una sessione Channable autorizzata verificare lo stato export UI dello specifico SKU, documentare isolamento senza `Clear API` e senza cancellazioni inattese.
5. Poi separata autorizzazione del test canary Offer Only qty 0. **Non abilitare il live writer nel frattempo.**
