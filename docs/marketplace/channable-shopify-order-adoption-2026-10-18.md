# R2.2–R2.3 — Channable order adoption (Amazon / Spartoo)

**Data:** 18 ottobre 2026. **Ambito:** letture Shopify, algoritmo di riconciliazione Amazon read-only. **Stato:** modulo di sviluppo in PR #203. Nessun nuovo ordine creato, nessuna quantità modificata.

## Evidenza Shopify, verificata con GraphQL read-only

Nel negozio DevidLabel, 18/10/2026, è stata letta una finestra di ordini Shopify creati dall'11/10/2026. Il campione è stato elaborato senza acquisire o memorizzare dati personali nel repository; i valori dei singoli ID ordine reali sono stati utilizzati solo in memoria e **non riportati** qui.

| Segnale | Amazon | Spartoo |
|---|---:|---:|
| Ordini letti nel campione | 40 | 11 |
| App creatrice = Channable | 40 | 11 |
| Attributo esterno presente | `Amazon Order ID` (40/40) | `Spartoo Order ID` (11/11) |
| `sourceName` | `amazon` | `spartoo` |
| `sourceIdentifier` popolato | 0 | 0 |
| ID esterni duplicati nel campione | 0 | 0 |
| Forma ID esterno | `nnn-nnnnnnn-nnnnnnn` | 16 cifre |
| Paginazione residua | Sì | No, ricerca completata |

**Non usare `sourceIdentifier` come unico identificativo**: Channable salva l'ID nel campo `customAttributes`, e `sourceIdentifier` può essere assente. Il campione prova una convenzione utile, non che tutte le importazioni storiche abbiano metadati perfetti.

## Sviluppo consegnato

- `src/marketplace-shopify-channable-amazon-adoption.ts`: ricerca Shopify `source_name:amazon` + intervallo di creazione, paginazione completa e limitata, corrispondenza positiva dell'attributo `Amazon Order ID`, conferma app Channable, conflitto ID duplicati o incongrui. Nessun campo cliente, pagamento o indirizzo nella query.
- `src/marketplace-amazon-channable-adoption-reconcile.ts`: confronto dell'osservazione Amazon Orders SP-API con il riferimento Shopify già creato. `FOUND` = riferimento Shopify positivo che richiede ancora verifica delle righe; `NOT_FOUND` = **UNKNOWN**, mai permesso di creare un nuovo ordine. `allow_shopify_order_create=false` costante.
- Test: `scripts/test-shopify-channable-amazon-adoption.mjs` e `scripts/test-marketplace-adoption-reconcile.mjs`, inclusi nella suite `test:marketplace-runtime`.
- Nuova capability privata `shopify.marketplace.amazon_order_adoption.readonly`, esposta in codifica soltanto in PR #203 (non distribuita).

## Regole per la migrazione

1. Shopify e Amazon usano finestre temporali **diverse**: la prima data di creazione Shopify non dimostra l'assenza di un ordine Amazon creato/aggiornato altrove. Neppure una scansione completa di un intervallo limitato può autorizzare `orderCreate` da sola.
2. Un identificativo esterno che rimanda a due Shopify GID genera conflitto; un Shopify GID che cambia riferimento esterno genera conflitto. Nessuna normalizzazione dello SKU.
3. Il record `Amazon Order ID` è una prova **di collegamento positivo**, non della completa equivalenza tra importi, righe, stato pagamento, quantità, fulfillment e tracking. Questi dati vanno riconciliati separatamente prima dell'adozione definitiva.
4. Un ordine Amazon può contenere più SKU. La titolarità dell'importazione è per ordine/account, non per brand, SKU o lotto di feed.
5. M.A.R.E. rimane **shadow read-only**; Channable resta proprietario di ordini, spedizioni e tracking finché non viene eseguito un cutover documentato e verificato.
6. Spartoo usa la stessa convenzione di base ma un attributo e formato ID differenti: `Spartoo Order ID` a 16 cifre. L'adapter Spartoo va modellato sullo stesso Core, previa verifica del contratto provider. **Non confondere** questo dato di Shopify con una conferma dello scope univoco degli order ID Spartoo in API.

## Prossimi test

- Verificare più finestre e campioni storici per Channable Amazon, compresa la completezza di `Amazon Order ID` nei casi annullati o parzialmente evasi.
- Completare riconciliazione righe, quantità, luogo fulfillment e tracking per gli ordini già importati; nessun writer duplicato.
- Provare i permessi Shopify `write_orders` e gli scope fulfillment dell'installazione M.A.R.E. prima di proporre creazioni, mai prima.
- Sviluppare adapter Shopify Spartoo sul contratto dell'API ufficiale, usando l'evidenza `Spartoo Order ID` come guida di sola lettura.

**Il campione è reale, ma tutto il codice R2.2/R2.3 è ancora testato in ambiente simulato, senza chiamate live integrate e senza deployment.**


## R2.4 — Controllo righe ordine Shopify già importato

Il nuovo modulo `src/marketplace-shopify-channable-amazon-lines.ts` legge **soltanto** ID ordine, `sourceName`, app, `Amazon Order ID` e `lineItems` con SKU, quantità, `currentQuantity` e ID variante. Non legge destinatari, indirizzi, clienti, note o dati pagamento. Il contratto GraphQL è stato verificato sulla Shopify API reale, e un ordine Channable di campione espone una riga con SKU e variant GID; nessun valore identificativo reale viene salvato in questo repository.

La funzione pura `compareAmazonOrderWithChannableShopifyLines` confronta le quantità aggregate per SKU esatto, gestendo più righe con lo stesso SKU. Una corrispondenza produce `REFERENCE_AND_QUANTITIES_MATCHED_NEEDS_FULFILLMENT_REVIEW`: **non** dimostra che lo stock fisico sia stato riservato, né che tracking e conferme di spedizione siano stati sincronizzati. Se quantità o SKU differiscono, se mancano righe/varianti o se la quantità corrente Shopify è cambiata rispetto all'originale, l'esito è `LINE_RECONCILIATION_REQUIRED`. In tutti i casi `may_create_shopify_order=false` e `may_release_reservations=false`.

Il lettore pagina tutte le righe (fino al limite difensivo) e blocca ordini non provenienti da Channable, attributi `Amazon Order ID` errati, riferimenti Shopify incongruenti, duplicati e paginazione incompleta. Capability privata di sola lettura (ancora **non distribuita**): `shopify.marketplace.amazon_order_lines.readonly`.

Suite sintetica: `scripts/test-marketplace-shopify-amazon-lines.mjs`; inclusa nella CI `test:marketplace-runtime`. Prima del vero passaggio ordini servono convalida prezzo/tasse, ubicazione magazzino, fulfillment per collo e tracking, oltre alla prova di arresto del writer importatore Channable.
