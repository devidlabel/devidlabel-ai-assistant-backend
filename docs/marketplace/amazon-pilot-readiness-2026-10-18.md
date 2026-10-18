# Amazon Europe — pilot candidate audit, 18 ottobre 2026

**Stato:** evidenze **live read-only** Shopify + Amazon SP-API Catalog Items; nessun tentativo di creazione offerta. Integrazione nella PR #204 (non deployata). Dati catalogo non personali; nessun token/seller order ID reale archiviato.

## Candidato principale — Rains Reporter Box Bag W3 Black

- Shopify: SKU `RNS_14920_BLACK`, EAN `5711747572921`, prodotto `ACTIVE`, vendor Rains, categoria `Pochette e Borselli`, prezzo sorgente Shopify €80,00, stock Shopify 4 in `Shop location`, `available=4, on_hand=4, committed=0` osservati. **Questa non è una quantità Amazon pubblicabile.**
- Amazon: EAN→ASIN unico, `B0CW4LTCX4` in tutti e quattro i mercati; brand RAINS, `model_number=RNS_14920_BLACK` e `part_number=5711747572921` in ognuno; `product_types=["HANDBAG"]`, catalogo BASE_PRODUCT, colore tradotto correttamente.
- Risultato: **CANDIDATO IDENTITÀ FORTE**. Nessuna offerta seller creata o verificata come assente; nessun passaggio Channable completato.

| Paese | EAN→ASIN | Product type | Colore Amazon | Modello | Part number |
|---|---|---|---|---|---|
| IT | `B0CW4LTCX4` EXACT_ONE | HANDBAG | Nero | SKU esatto | EAN esatto |
| DE | `B0CW4LTCX4` EXACT_ONE | HANDBAG | Schwarz | SKU esatto | EAN esatto |
| FR | `B0CW4LTCX4` EXACT_ONE | HANDBAG | Noir | SKU esatto | EAN esatto |
| ES | `B0CW4LTCX4` EXACT_ONE | HANDBAG | Negro | SKU esatto | EAN esatto |

## Candidato secondario — Rains Cosmetic Bag W3 Coal

- Shopify: `RNS_15600_COAL`, EAN `5715793005679`, ACTIVE, Rains, prezzo sorgente €14,95, stock 3 (Shop location, available 3 / committed 0).
- Amazon: `B0HLWFFZKD` EAN EXACT_ONE IT/DE/FR/ES, `model_number=RNS_15600_COAL`, `part_number=RNS_15600_COAL`, `COSMETIC_CASE`. Colore Amazon IT Grigio / DE Grau / FR Gris / ES Gris. L'associazione EAN è univoca, ma lo SKU indica il colore commerciale Coal: è necessario confermare la corrispondenza di tonalità, non equiparare automaticamente COAL a GRIGIO.
- Esito: **REVIEW_REQUIRED**, non candidate zero-quantity per default.

## Caso bloccato — Devid Label Matera

- SKU `DL_PC1_OR`, EAN `7426885112370`, Shopify ACTIVE, quantità osservata 2; ASIN IT `B07D914KXP` assoc. univocamente.
- **Bloccato**: Amazon dichiara Product Type `LABEL`, incompatibile con categoria Shopify `Pochette e Borselli`. Il preflight R3.2 blocca la discrepanza. Non usare come primo canary soltanto perché ha EAN esatto.

## Gate vincolanti per pilot RNS_14920_BLACK

1. **Seller account:** confermare `AMAZON_SP_API_SELLER_ID` server-side e ruolo Listings Items / Listing Restrictions / Product Type Definitions nell'app SP-API. Le credenziali LWA del catalogo funzionano; questo **non dimostra** i privilegi del seller Listings né Orders. **Non** richiedere segreti in chat.
2. **Offerta esistente:** interrogare `amazon.seller.listings.direct` (in PR #204, non ancora in produzione) su SKU/paese; un 404 ambiguo resta UNKNOWN. Non usare la connettività dei report seller per dichiarare SKU libero: `amazon_report_download_network_error` è stato riprodotto.
3. **Categorie + attributi:** verificare Product Type Definitions per SKU/paese, modello, colore localizzato, GPSR, origine e materiale veritieri e conformità su ASIN. La `VALIDATION_PREVIEW` non certifica pubblicabilità.
4. **Politica prezzi:** il prezzo Shopify €80 non è autorizzazione a pubblicare €80 su Amazon. Riprodurre la politica Amazon Italia preesistente negli altri mercati solo dopo verifica delle regole commerciali.
5. **Writer unico:** Channable `DL-Shopify` rimane writer del catalogo/offerte/quantità. Una nuova offerta M.A.R.E. anche a zero richiede prova di esclusione non distruttiva dal feed legacy (non si può presumere che togliere SKU dal feed non cancelli la sua offerta).
6. **Ordini e stock:** Channable rimane importatore ordini e tracking. Quantità positive impossibili finché copertura SKU/paese, budget stock per location, annullamenti, fulfillment e tracking non sono dimostrati.
7. **Rilasci:** prima `VALIDATION_PREVIEW` controllo fixed-mode e qty0 (zero publication), poi eventuale zero-qty canary dietro gate catalog/ownership e monitor readback, infine test singolo vendibile e lotti massivi con rollback.
8. **TikTok:** mantenere collegamento dedicato Shopify; il budget stock deve considerare tutte le vendite incluse quelle TikTok.

## Componenti software collegati

`src/marketplace-amazon-canary-matrix.ts` produce valutazione per 4 paesi con identità SKU/EAN/brand/modello/part number/colore e blocchi anti-categoria. Anche `CATALOG_IDENTITY_STRONG_ALL_MARKETS` imposta `can_validate_preview=false`, `can_create_offer=false` e `can_publish_positive_quantity=false`, perché le prove di solo catalogo **non possono autorizzare scritture**. Suite: `scripts/test-marketplace-amazon-canary-matrix.mjs`.

## Stato immediato

**Risultato:** 8/8 EAN-ASIN associazioni live univoche per 2 SKU Rains nei 4 mercati. Candidato primario con identità coerente in tutti i paesi. **0 nuove offerte M.A.R.E. verificate online; 0 validazioni preview Amazon reali eseguite**. Non è stato alterato alcun feed/ordine/prezzo/quantità/tracking di Channable.
