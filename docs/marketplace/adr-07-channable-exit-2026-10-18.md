# ADR-07 — Dismissione programmata di Channable DL-Shopify
**Data decisione:** 18 ottobre 2026. **Origine:** chiarimento operativo del titolare M.A.R.E. **Stato:** decisione strategica approvata; nessun cutover tecnico autorizzato implicitamente.

## 1. Baseline corretta e fonte dell'informazione
Attualmente il progetto **Channable `DL-Shopify`** è il sistema operativo principale dei marketplace (Amazon e Spartoo): gestione/esportazione di offerte e prodotti, quantità e prezzi di canale, ordini, corrieri, spedizioni e tracking. **TikTok Shop fa eccezione**: è collegato con la sua applicazione Shopify e resta fuori dal progetto di sostituzione Channable salvo successiva decisione esplicita.

Il titolare riferisce che la normale operatività marketplace di Channable funziona, ma che nelle ultime settimane la creazione di **nuove** offerte Amazon non ha prodotto progressi concreti. Trattare quest'ultima come una segnalazione operativa da misurare e riconciliare con Seller Central: non attribuirle una statistica falsamente verificata.

**Decisione:** Channable è un sistema *incumbent in fase di dismissione*, non l'architettura target. Non continuare a investire in regole e configurazioni Channable per risolvere la creazione di nuove offerte come obiettivo di lungo periodo. Preservare soltanto le operazioni esistenti indispensabili alla continuità vendite durante la migrazione.

Il sistema finale è Shopify (fonte prodotto/inventario) ↔ M.A.R.E. Marketplace Core (ledger, stato desiderato, prezzi di canale, policy, outbox e riconciliazione) ↔ Amazon SP-API e Spartoo adapter, con ordini e tracking gestiti direttamente da M.A.R.E. e Shopify/WMS. ChatGPT è un pannello di supervisione, non il runner schedulato.

## 2. Titolarità delle scritture: distinguere i cinque domini

| Ambito | Owner attuale | Owner finale | Requisito per la transizione |
|---|---|---|---|
| Offerte catalogo Amazon (nuova offerta su ASIN / nuove schede) | Channable | M.A.R.E. Amazon adapter | Evidenza assenza ASIN/offerta, safety schema, esclusione writer legacy con effetto esterno provato |
| Quantità/prezzi Amazon | Channable | M.A.R.E. Core + Amazon adapter | Matching per surface e stock location, nessun writer contemporaneo, rollback praticabile |
| Importazione ordini Amazon → Shopify | Channable | **Un unico importatore M.A.R.E. per account/flusso** | Adozione ordini storici, identità account+ordine, coerenza stock, lettura integrale multi-SKU e riconciliazione |
| Spedizioni, corrieri e tracking Amazon | Channable + Shopify/WMS | M.A.R.E. adapter + Shopify/WMS | Collegamento order/fulfillment/package, readback del tracking e gestione parziali/annullamenti |
| Spartoo catalogo/ordini/stock/tracking | Channable | Spartoo adapter sullo stesso Core | Contratto API verificato, mappature taglia/category, prove end-to-end senza replicare il Core |

Non migrare il **singolo ordine** in base al marchio o allo SKU, perché può contenere prodotti in stati di migrazione diversi. Per quantità/prezzi la titolarità ha invece granularità account/marketplace/risorsa (SKU e superficie vendibile), secondo la semantica reale dei feed e delle API, non secondo ipotesi.

## 3. Due binari: nuovo catalogo subito, continuità ordini invariata
**Binario A — Accelerazione nuove offerte Amazon (prioritario).**
1. Ottieni catalogo Shopify ACTIVE con stock >0 per determinare candidati (esclusione P448 e altri vincoli già approvati); acquisisci matching EAN/UPC→ASIN univoco per IT/DE/FR/ES e i dettagli child-variant; restituisci anche categorie non corrispondenti.
2. Per ogni SKU/mercato controlla seller offer esistente, restrizioni e Product Type Definitions; usa `LISTING_OFFER_ONLY` e `VALIDATION_PREVIEW`. Nessun prodotto è «creato» solo perché il feed è accettato: conta soltanto il readback Amazon sull'account.
3. Prova prima un canary non acquistabile (quantità zero), **soltanto dopo aver dimostrato** che Channable non può aggiornare/eliminare quell'offerta e che la sua esclusione dal feed non produce una cancellazione. La prova deve essere una configurazione più un readback, non una semplice nota.
4. Per rendere acquistabile il canary: verificare gestione completa dell'ordine sul nuovo SKU, importatore unico ancora Channable se necessario e provato, stock disponibile/riservato su Shopify e tracking end-to-end. Non pubblicare quantità positive altrimenti.
5. Dopo più esiti verificati, batch in crescita con checkpoint, monitor, stop automatico e rollback; nessun invio massivo indiscriminato.

**Binario B — Sostituzione logistica sincronizzazione (parallelamente, senza doppie scritture).**
1. M.A.R.E. osserva gli ordini in read-only e riconcilia con quelli già importati da Channable; nessun `orderCreate` finché i permessi e la titolarità non sono cambiati.
2. Realizza inbox/outbox persistenti, versioni ordine/riga, prenotazioni non riflesse, inventory by location, import con semantica esplicita e prove di readback. Non presumere atomicità remota o scope Shopify `write_orders`.
3. Implementa ordini, corrieri, spedizioni per collo, tracking e resi con conferma dal marketplace. Esegui shadow reconciliation e gestione anomalie su ordini esistenti.
4. Al cutover del dominio ordini per account/flusso: stop importatore Channable + drenaggio code + prova assenza scritture in volo + readback Shopify/Amazon + incremento epoch + avvio importatore M.A.R.E. sul checkpoint approvato. Mai due importatori insieme.
5. Dopo alcuni cicli verificati, migra prezzi/quantità e dismetti progressivamente i relativi canali/feed; spegni solo **alla fine** il progetto DL-Shopify quando nessuna dipendenza operativa permane.

**TikTok Shop** resta controllato dall'app Shopify: leggere il suo contributo allo stock Shopify, senza introdurre un nuovo writer TikTok in M.A.R.E. durante questa migrazione.

## 4. KPI che definiscono il successo
- **Offerte Amazon nuove davvero vendibili** per paese e SKU, con ASIN associato, seller listing presente, prezzo coerente e disponibilità corretta confermata, non «export inviato» o «Creati nel log».
- **Copertura del catalogo idoneo**: SKU ACTIVE, stock >0 e non esclusi, eleggibili per il mercato, classificati in `EXISTING_OFFER`, `READY_OFFER_ONLY`, `NEEDS_NEW_PAGE`, `BLOCKED_ATTRIBUTES`, `BLOCKED_RESTRICTIONS`, `UNVERIFIED`. Snapshot datato e confrontabile.
- **Unicità ordini**: nessun ordine duplicato in Shopify per stesso account e ordine Amazon; gestione degli esiti incerti senza retry ciechi.
- **Disponibilità prudente**: niente aumenti di esposizione oltre il budget fisico prenotato, con monitor anche Shopify storefront/POS e stock da altri marketplace.
- **Tracking/fulfillment**: documentazione e corrispondenza delle righe/collo, conferma Amazon e controllo di avanzamento; niente tracking apparentemente inviato ma mancante lato Amazon.
- **Tempi e errori**: latenze, code, throttling, tentativi ambigui e ritardi di riconciliazione misurati. Stabilire SLO numerici solo dopo baseline reale e consenso.
- **Dismissione**: quota di domini governati da M.A.R.E. e nessun flusso legacy rimasto prima dello shutdown.

## 5. Semafori obbligatori / stop
- Nessun writer Channable + M.A.R.E. contemporaneo sullo **stesso dominio** senza architettura dimostrata non interferente e specifica eccezione approvata.
- Se non è provata l'assenza dell'offerta, o il tipo prodotto/colore/taglia non combacia, fermare il pilot.
- Se non si conosce dove termina la responsabilità Channable nell'importazione di un nuovo SKU, non renderlo acquistabile.
- Se l'effetto di escludere uno SKU dal feed è ignoto, non escluderlo in produzione: potrebbe causare azzeramento o cancellazione.
- Se OAuth/Orders SP-API non è autorizzato o Shopify non permette l'operazione richiesta, mantenere la lettura e segnalare il blocco concreto.
- Nessuna modifica all'integrazione TikTok Shopify per inferenza dalla dismissione Channable.
- Migrazione/rollback sono operazioni distinte da audit e test: richiedono evidenza, una policy autorizzata e checkpoint di ripristino.

## 6. Priorità operativa odierna
1. Completare la pipeline ***matching → preflight → preview → write con readback*** senza contenuti inventati; proteggere la funzione write dietro policy/ownership del Core.
2. Connettere l'osservazione ordini del Core agli ordini Shopify già presenti e dimostrare le condizioni di adozione senza scrivere.
3. Verificare gli scope delle app installate e le condizioni minime dell'integrazione Channable per pilot offer-only; separare ciò che richiede configurazione umana da quanto può essere automatizzato.
4. Preparare il primo canary Amazon con nessuna quantità positiva finché ordine/stock/tracking non sono stati dimostrati.
5. Usare la stessa architettura per Spartoo dopo verifica dell'API e di tutti i flussi richiesti.

**Questa decisione NON equivale al go-live o alla disattivazione di Channable.** Non dichiarare il marketplace indipendente da Channable prima che l'ultimo dominio sia stato migrato e verificato.
