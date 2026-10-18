# R2.0 — Amazon Orders v2026-01-01, osservazione read-only

**Stato:** adapter di sviluppo in PR separata; **nessuna capability di produzione**, nessun dato cliente acquisito, nessun ordine creato in Shopify.

## Contratto ufficiale verificato

Fonte: [Amazon Selling Partner API Models, Orders 2026-01-01](https://github.com/amzn/selling-partner-api-models/blob/main/models/orders-api-model/orders_2026-01-01.json), operazione `searchOrders` /orders/2026-01-01/orders.

- Il filtro richiede **esattamente uno** di `createdAfter` e `lastUpdatedAfter`; qui usiamo esclusivamente `lastUpdatedAfter` con `lastUpdatedBefore`, come finestra completa chiusa e terminata almeno tre minuti prima del momento di lettura.
- Il limite di pagina è 100, con `pagination.nextToken` e il parametro `paginationToken`. Il token non viene riutilizzato oltre una singola invocazione e il numero di pagine è limitato; un risultato con ulteriore token alla pagina massima è **incompleto** e genera errore.
- La lettura iniziale richiede solo `FULFILLMENT` e `fulfilledBy=MERCHANT`; **non** richiede `BUYER` o `RECIPIENT`. Se il provider restituisce comunque dati personali, l'output li scarta; non vengono persistiti da questo adapter.
- L'ordine contiene almeno `orderId`, `createdTime`, `lastUpdatedTime`, `salesChannel`, `orderItems`. Le righe hanno `orderItemId`, `quantityOrdered` e `product`; i codici `sellerSku` vengono conservati opachi, senza `trim()` o conversione maiuscole.
- Identità deduplicata per **seller account + Amazon order ID**, senza aggiungere il marketplace quando è soltanto un attributo dell'ordine. La stessa vendita osservata da viste paese diverse non deve diventare due ordini Shopify.

## Invarianti testate

1. Completamento della paginazione e mantenimento di tutti i filtri al cambio token; token ciclici, pagina malformata, 429/403, JSON non valido o cap di pagine interrompono la lettura.
2. Stesso `orderId` in pagine diverse con lo stesso contenuto è deduplicato; contenuto diverso durante la scansione blocca il ciclo perché una fotografia coerente non è dimostrata.
3. Differente marketplace non modifica la chiave ordine; condizioni non-MERCHANT vengono rifiutate.
4. Righe con SKU assente vengono segnalate `MISSING_SELLER_SKU` e `needs_enrichment`; non viene inventato un mapping Shopify. Nessun campo PII viene restituito e nessun import viene autorizzato.
5. Tempo e massimo numero di pagine rigorosamente validati; nessun parametro in ingresso permette una scrittura o aggiunge dataset riservati.

## Limiti intenzionali e prossimi gate

- Il modulo è scollegato da `mare_read` e dall'automazione live fino alla verifica della role effettiva SP-API, seller scope e credenziali del servizio.
- Il lettore non gestisce ancora webhook SQS, polling persistente, overlapping windows, rate limiting pianificato, backfill o salvataggio di cursori. Non considera `complete_pagination` autorizzazione a promuovere un checkpoint.
- Mancano integrazione col ledger R1.2, deduplica semantica a livello Shopify, adozione di ordini già creati da Channable, prenotazioni ordini, ritorno dati cliente tramite eventuali permessi consentiti, rimborsi, imposte, spese e importi in valuta esatta. `orderCreate` non viene chiamato.
- Tracking e conferme di spedizione restano moduli separati e non possono essere dedotti dal solo stato di un ordine. Le regole per ordini con SKU gestiti da sistemi diversi sono di responsabilità del coordinatore, non di ogni SKU.
- Gli ordini FBA, Buy Shipping, Easy Ship e altri programmi hanno flussi distinti, da verificare prima di attivare operazioni di scrittura.

**Sicurezza:** solo dati sintetici nella suite. Nessun numero di ordine reale, indirizzo, destinatario, tracking o token presente nel repository. Nessun effetto sui canali Amazon/Spartoo/Shopify o su Channable.
