# Amazon Catalog Items — recupero controllato 429 (22 ottobre 2026)

Nel controllo read-only accessori IT/DE/FR/ES la SP-API Catalog Items ha restituito `amazon_catalog_details_http_429` su alcune chiamate per ASIN. Il 429 è un **throttle temporaneo** di Amazon, NON dimostrazione di ASIN assente e NON approvazione alla pubblicazione. Può impedire l'ultima verifica del classificatore `amazon.existing_offers.qualification_triage.readonly`, che correttamente risponde RECHECK_REQUIRED.

Modifica in `src/mare-business-amazon-details.ts`:
- Solo per una HTTP 429 della GET originale Catalog Items ASIN, fino a **tre tentativi totali** sullo stesso ASIN/marketplace, con stessa credenziale e identico percorso.
- Se Amazon trasmette `Retry-After` fino a tre secondi, lo rispetta. Se indica un ritardo superiore o un formato non gestito (es. data HTTP), non lo ignora: ritorna 429 senza riprovare, per evitare sovraccarico e blocchi Worker.
- Se Amazon non manda l'header: backoff conservativo 500 ms, poi 1.250 ms. Dopo il terzo 429 fallisce con `amazon_catalog_details_http_429`.
- **404** continua a significare ASIN_NOT_FOUND solo se Amazon ha effettivamente restituito 404; 429 non viene mai convertito in 404, in assenza di inserzioni o in autorizzazione.
- Nessun listing PUT, seller mutation, creazione ASIN, update stock/prezzo, Channable o Shopify; il GET resta read-only, la risposta non include credenziali.
- Test sintetici in `scripts/test-mare-business-amazon-details.mjs`: 429 e recupero 200, Retry-After lungo senza retry, 3×429 con limite dei tentativi. Tutti i test read-only esistenti rimangono invariati.

Verifica dopo deploy: ripetere `amazon.existing_offers.qualification_triage.readonly` su `MC2_ALI0002_02846I` / EAN `8057338617617` in ES. Se la risposta è ancora UNKNOWN/429, annotare il limite e non usare l'ASIN come base di nuova pubblicazione.

Non interpretare il backoff come garanzia che la quota Amazon sia immediatamente ripristinata.