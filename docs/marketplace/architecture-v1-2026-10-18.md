# M.A.R.E. Marketplace Core — architettura v1

> **Decisione aggiornata 18/10/2026 — ADR-07:** il progetto Channable `DL-Shopify` resta *incumbent operativo* per catalogo/offerte, quantità/prezzi, ordini, corrieri e tracking, ma viene sostituito progressivamente da M.A.R.E. API per Amazon e poi Spartoo. TikTok Shop resta con l'app Shopify dedicata. La creazione di nuove offerte Amazon passa al nuovo adapter; preservare tutte le funzioni legacy finché la sostituzione non è verificata. Leggere [`adr-07-channable-exit-2026-10-18.md`](./adr-07-channable-exit-2026-10-18.md) prima di ogni cutover. Questo documento non autorizza doppi writer né disconnessioni immediate.

**Revisione:** 18 ottobre 2026. **Stato:** baseline proposta per implementazione, NON autorizzazione al go-live. **Ambito:** Amazon IT/DE/FR/ES, successivamente Spartoo. **Responsabile delle decisioni commerciali:** titolare M.A.R.E.; il software applica policy approvate, non le inventa.

Questa revisione sostituisce la sequenza «prima pubblichiamo, poi pensiamo agli ordini» con uno sviluppo per dipendenze. La validazione di un'offerta può arrivare presto; la prima quantità positiva richiede anche un percorso ordini, stock e spedizioni effettivamente funzionante, proprio o temporaneamente delegato e verificato.

## 1. Obiettivo e limite della promessa

Un servizio persistente legge Shopify e i marketplace, riconcilia lo stato, prepara comandi circoscritti, li esegue secondo autorizzazioni verificabili e ne controlla gli effetti. Continua a funzionare a chat chiusa. ChatGPT serve a progettare, revisionare, autorizzare e consultare; NON è il processo che deve restare acceso per allineare il magazzino.

Il motore comune comprende identità, policy, prenotazioni, ordini, spedizioni, idempotenza, responsabilità di scrittura, retry, audit e monitoraggio. Amazon e Spartoo implementano contratti adapter; non si copiano due motori di sincronizzazione. Un adapter differente non può cambiare le invarianti di sicurezza.

Non promettiamo transazioni atomiche fra Shopify, Amazon e Spartoo, né consegna exactly-once da parte della rete. Promettiamo controlli locali verificabili, esposizione conservativa, riconciliazione esplicita degli esiti incerti e nessuna ripetizione cieca di operazioni non idempotenti. Il rischio residuo delle vendite concorrenti deve essere reso visibile, non nascosto da una formula.

## 2. Baseline verificata e riuso

Alla revisione la capability `amazon.listings.sync` è ancora non implementata. Il runner Shopify è attivo in shadow, con `ready_for_marketplace_writes=false`; i blocchi includono ordini marketplace, GPSR, adapter e responsabilità Channable. Il preflight della PR #199 è in bozza, non unito e non distribuito. La pipeline del relativo commit ha superato test simulati, typecheck e bundle; il deploy è stato saltato.

Riusare autenticazione Shopify/Amazon, reader completi e paginati, classificazione dei codici a barre, letture catalogo, checkpoint e salvaguardie esistenti. `integrations/marketplace/core.py` è un riferimento di sviluppo: il ledger Python non va descritto come coordinatore già operativo su Cloudflare.

La PR #199 contiene un errore di collegamento fra moduli: importa il reader Shopify legacy ma ne richiede campi di completezza che esso non produce. I mock nascondono la differenza. Leggere `pr-199-review-2026-10-18.md` prima di proseguire.

Queste osservazioni riguardano gli artefatti letti alla revisione, non costituiscono inventario universale delle autorizzazioni aziendali. Nessun identificativo prodotto, ordine, cliente, credenziale o snapshot commerciale deve essere aggiunto alla documentazione pubblica.

## 3. Decisioni architetturali

### ADR-01 — Fonti autorevoli separate per dominio

| Dominio | Fonte autorevole | Responsabilità M.A.R.E. |
|---|---|---|
| Identità prodotto/variante | Shopify, con mapping approvati | Conservare ID stabili, SKU originali e provenienza |
| Fatti catalogo del prodotto venduto | Dati Shopify/brand verificati | Mappare senza inventare materiale, origine o conformità |
| ASIN e restrizioni Amazon | Amazon per account e mercato | Verificare la variante vendibile, non solo il codice a barre |
| Stock fisico e impegni Shopify | Shopify per inventory item e location | Calcolare esposizione e prenotazioni non ancora riflesse |
| Ordine, cancellazione e importi marketplace | Marketplace che ha ricevuto la vendita | Importare una sola volta e preservare importi e riferimenti |
| Evasione e tracking del venditore | Flusso logistico Shopify/WMS verificato | Trasmettere colli e righe corrette e leggere il riscontro |
| Policy prezzo, calendario e abilitazione | Configurazione versionata approvata | Applicare lo stesso criterio nei mercati previsti |
| Stato effettivo dell'offerta | Risposta e lettura marketplace | Separare desiderato, inviato, accettato e vendibile |

Non esiste una sincronizzazione bidirezionale generica «vince l'ultimo aggiornamento». Ogni campo ha un proprietario e una direzione. Gli ordini importati non devono generare un nuovo ordine sul canale di origine.

### ADR-02 — Monolite modulare, non microservizi prematuri

Target: Worker marketplace isolato dal backend conversazionale/ADV, nello stesso repository se utile, con binding e credenziali propri. Il backend esistente resta una superficie di controllo autorizzata. Un guasto di marketing o una sua verifica di deploy non deve determinare il rilascio delle scritture stock.

Un Durable Object SQLite per tenant coordina inizialmente le decisioni critiche, incluse prenotazioni multi-riga, ownership, inbox e outbox. Le transazioni sono brevi e locali; nessuna chiamata HTTP dentro una transazione. Si riusa il runner catalogo separato come produttore di osservazioni. La capacità del coordinatore va provata con carico misurato; eventuale sharding futuro avverrà per pool di stock, con protocollo multi-pool esplicito, non per SKU in modo improvvisato.

Cloudflare documenta consistenza forte e transazioni per storage del singolo Durable Object [S8]. Questo non crea una transazione con Shopify né fra Durable Objects diversi.

### ADR-03 — Inbox e outbox persistenti sono la base

Il ricevitore autentica e valida la busta, poi registra evento e lavoro pendente nella stessa transazione. Risponde con successo soltanto dopo una registrazione durevole. Un crash dopo la registrazione non perde il lavoro; un duplicato non ripete l'effetto locale.

L'outbox nel coordinatore è la fonte del lavoro. Allarmi persistenti eseguono lotti piccoli; un watchdog ripristina l'attività senza dipendere dalla chat. Una coda gestita può trasportare notifiche di lavoro, ma non è il ledger. Cloudflare Queues può consegnare nuovamente un messaggio [S9]: ogni consumer deve essere idempotente. Un messaggio perso fra commit locale e invio alla coda è recuperato dall'outbox.

### ADR-04 — KV non è il coordinatore del magazzino

Workers KV rimane cache, configurazione non critica o deposito artefatti non autorevoli. Non usarlo per lock, deduplica ordini, quantità impegnate o assegnazione dell'ultimo pezzo: la consistenza eventuale non è adatta a queste decisioni [S10]. Separare archivi operativi da namespace contenenti token. Archivi voluminosi e payload personali richiedono uno storage privato dedicato e policy di conservazione.

### ADR-05 — Nessun LLM nel percorso transazionale

Un LLM può proporre mapping o analizzare un errore. Non determina in tempo reale quantità, conferme di spedizione, importi, ammissibilità delle scritture o sblocco di un gate. I suoi risultati sono input non fidati; un validatore deterministico applica schema e policy. Nessuna descrizione prodotto o messaggio di errore può impartire istruzioni operative al motore.

### ADR-06 — SKU opachi, identità durevoli

Non riscrivere SKU, spazi, maiuscole, prefissi o zeri iniziali. Le regex non definiscono l'identità commerciale. Separare validità del formato per provider dalla policy sui codici legacy già approvata. Una ricerca Shopify per SKU non sostituisce il confronto esatto su tutti i risultati e la verifica dei duplicati.

Conservare barcode originale, tipo rilevato, checksum e valore canonico di confronto. EAN-13 e UPC-12 devono essere supportati nei contratti comuni; un pilot EAN-only va dichiarato come limitazione, non come invalidità degli UPC. Per formati equivalenti normalizzare solo il confronto, mai il codice originale. Il mapping catalogo lega variante Shopify, account, mercato, ASIN child o ID Spartoo, attributi verificati, provenienza e versione.

## 4. Modello dati minimo

Tutti i record critici sono tenant-scoped. Gli identificativi esterni restano stringhe, anche se numerici.

| Entità | Chiave/relazione | Campi essenziali |
|---|---|---|
| `variant_identity` | tenant + Shopify variant ID | inventory item, SKU originale, GTIN, stato, versioni |
| `stock_observation` | inventory item + location | available, source time, read time, completezza, generazione lettura |
| `catalog_match` | variante + account + mercato | ID catalogo, attributi, evidenze, data verifica, stato revisione |
| `offer` | account + inventory surface + seller SKU | desiderato, osservato, revisioni, issues, responsabilità |
| `policy_version` | tenant + versione | prezzi, calendario, brand, soglie, mercati, approvatore |
| `order` | provider + account + scope ID ordine + ID esterno | stato originale/canonico, importi, versione, mapping Shopify |
| `order_line` | ordine + ID riga esterna | variante, quantità ordinate/cancellate/evase, ID riga Shopify |
| `reservation` | ordine + riga + versione | quantità non riflesse, prova di riflesso, location, stato |
| `allocation` | pool + inventory surface | esposizione confermata e massima possibile, revisione |
| `shipment` | ordine + ID collo stabile | tracking, corriere, servizio, righe/quantità, riscontro |
| `ownership` | dominio + scope immutabile | sistema responsabile, epoch, stato, prova di passaggio |
| `inbox_event` | provider + account + event ID | hash, schema, tempi, stato, riferimento payload privato |
| `outbox_command` | command ID | versione desiderata, payload hash, proof refs, epoch, scadenza |
| `attempt` / `receipt` | command ID + tentativo | stato rete, codice sicuro, submission ID, riscontro |
| `sync_cursor` / `audit_event` | flusso + scope | watermark completo, progresso, decisione, motivazione |

Non inserire il paese nella chiave ordine se il provider garantisce l'unicità a livello account: un ordine letto da due viste non deve essere importato due volte. Dove l'ID è unico solo per mercato, l'adapter dichiara quello scope esplicitamente.

`source_updated_at`, `observed_at`, `ingested_at` e revisione locale sono campi distinti. Una scansione appena terminata non rende recenti tutte le righe. Un contatore di slot in un report non è un'identità durevole di prodotto.

Prezzi in minor units intere o decimal esatto con valuta; niente aritmetica finanziaria su floating point binario. Conservare prezzo regolare, promozionale, finestre temporali, paese e policy applicata. Non ricavare le regole marketplace semplicemente dal prezzo Shopify attuale.

## 5. Contratti adapter

Interfacce previste, non capability già distribuite:

```ts
type Observation<T> = {
  value: T;
  complete: boolean;
  sourceUpdatedAt: string | null;
  observedAt: string;
  sourceVersion: string | null;
  evidenceRef: string;
};

type ProviderOutcome =
  | { kind: 'VALIDATION_ONLY'; evidenceRef: string }
  | { kind: 'ACCEPTED'; submissionRef: string }
  | { kind: 'REJECTED'; errorClass: string; issuesRef: string }
  | { kind: 'UNKNOWN'; reconcileKey: string };

interface MarketplaceAdapter {
  describeCapabilities(): CapabilityMatrix;
  readCatalogCandidates(input: IdentityQuery): Promise<Observation<Candidates>>;
  readOffer(input: OfferKey): Promise<Observation<RemoteOffer>>;
  readRequirements(input: RequirementsKey): Promise<Observation<Requirements>>;
  validateOffer(plan: ImmutableOfferPlan): Promise<ValidationResult>;
  executeOffer(plan: AuthorizedOfferPlan): Promise<ProviderOutcome>;
  listOrderChanges(cursor: OrderCursor): Promise<OrderPage>;
  readOrder(key: RemoteOrderKey): Promise<Observation<RemoteOrder>>;
  confirmShipment(plan: AuthorizedShipmentPlan): Promise<ProviderOutcome>;
  reconcile(command: CommandKey): Promise<ReconciliationResult>;
}
```

La matrice di capability dichiara: formato identificativi, scope dell'inventario, quantità assolute/delta, supporto preview, paginazione, riscontro, idempotenza remota, ordinamento, spedizioni parziali e annullamenti. Non assumere che API diverse offrano gli stessi metodi. Un adapter può rispondere `UNSUPPORTED`, mai successo fittizio.

I tipi citati sono contratti logici da concretizzare con schema runtime. Le risposte esterne, inclusi gli errori, vanno validate. `HTTP 200` non è una prova di struttura valida; `HTTP 404` non diventa automaticamente autorizzazione a creare una nuova offerta.

## 6. Stock: regole che non possono essere aggirate

### 6.1 Budget e doppio decremento

Per un pool di location esplicitamente abilitate:

`budget = max(0, available_Shopify - prenotazioni_non_riflesse - buffer)`

`available` esclude già gli impegni Shopify: non sottrarre `committed` nuovamente. Una prenotazione smette di essere non riflessa soltanto con prova della stessa versione ordine/riga, dell'effetto stock e della location. Un timeout di importazione non prova né successo né fallimento.

L'importazione tramite `orderCreate` deve impostare deliberatamente `inventoryBehaviour`: il default documentato è `BYPASS` [S6]. Non usare contemporaneamente decremento all'importazione e decremento manuale per la medesima vendita. Le righe devono referenziare varianti reali; una riga descrittiva senza variante non costituisce prova di impegno stock.

Prenotazioni pendenti e cancellazioni si aggiornano per versione; non scadono solo perché un timer è terminato. Un reso/rimborso non crea disponibilità finché il prodotto non è realmente reintegrabile secondo il flusso magazzino.

### 6.2 Esposizione, non soltanto quantità desiderata

La regola di autorizzazione di nuova esposizione è:

`somma(esposizione_massima_possibile_per_superficie) <= budget`

Una superficie è un inventario vendibile indipendente. Quattro paesi possono essere quattro superfici oppure condividere un inventario remoto: va verificato nell'adapter, incluse automazioni cross-marketplace e offerte collegate. Non sommare o duplicare stock sulla base delle sole etichette paese.

L'esposizione massima considera quantità osservata e aumenti inviati ma non risolti. Non sommare alla cieca versioni successive della stessa offerta: si mantiene il limite conservativo coerente con i possibili stati remoti. Non assegnare una capacità ad altri canali finché esistono invii incerti che potrebbero consumarla.

Trasferimento dell'ultimo pezzo da A a B: richiedere riduzione A, confermare completamento e lettura coerente, riconciliare ordini e invii pendenti, poi consentire aumento B. Un semplice `ACCEPTED`, un timer o un timeout non libera il pezzo. Le riduzioni hanno priorità sugli aumenti e sui caricamenti catalogo massivi.

Una perdita di stock esterna può rendere l'esposizione preesistente superiore al nuovo budget. In quel caso registrare `CAPACITY_DEFICIT`, bloccare aumenti, inviare riduzioni sicure e allertare. Non azzerare il ledger per fingere che le offerte remote siano già a zero.

### 6.3 Shopify online e POS sono anch'essi concorrenti

La disuguaglianza fra soli marketplace non impedisce al sito o al POS di vendere lo stesso pezzo. Il pilot prudente usa `STRICT_POOL`: quantità realmente riservate/segregate in Shopify e non acquistabili altrove, con meccanismo location/stato stock verificato end-to-end e autorizzato. Una location virtuale non può duplicare i pezzi fisici; importazione e routing devono consumare la location corretta.

Il preciso meccanismo Shopify di segregazione è un gate di implementazione da provare, non una funzionalità dichiarata già disponibile. Finché non è provato, la quantità live rimane bloccata. Un eventuale `SHARED_POOL` privilegia disponibilità commerciale ma comporta un rischio residuo di concorrenza: richiede accettazione esplicita, soglie, latenza misurata e gestione prudente dell'ultimo pezzo. Non presentarlo come equivalente a una riserva atomica.

FBA e stock gestito dal marketplace sono pool separati: non consumano automaticamente lo stock locale Shopify e non ricevono quantità FBM.

### 6.4 Dati incompleti e fuori ordine

Eventi Shopify possono arrivare duplicati o fuori ordine, e alcuni possono essere persi [S4, S5]. Il webhook è preferibilmente un segnale per leggere lo stato corrente; un payload vecchio non deve aumentare disponibilità. Non basarsi solo su timestamp con precisione insufficiente: generazioni di lettura, revisioni e invalidazione proteggono da risposte asincrone tardive.

Una scansione completa e i suoi delta devono avere watermarks distinti. Non promuovere un cursore prima di avere persistito tutte le pagine. Riconciliazione stock deve leggere inventory item/location: non assumere che ogni variazione stock aggiorni `product.updated_at`.

Dati scaduti o ordini incompleti bloccano nuovi aumenti. Il sistema può tentare zero d'emergenza solo sui flussi di cui ha responsabilità; se il provider è irraggiungibile deve dichiarare esposizione remota incerta, non «tutto disattivato».

## 7. Ordini: importazione e ciclo di vita

Flusso: osservazione ordine -> acquisizione completa paginata -> normalizzazione -> prenotazioni -> deduplica/adoption -> importazione Shopify -> riscontro ordine e stock -> rimozione delle sole prenotazioni riflesse.

La deduplica è per ordine esterno stabile, non per webhook, SKU o ricerca per email. Se Channable ha già importato l'ordine, si adotta un mapping verificato; non si crea un secondo ordine. Se la ricerca remota dopo un timeout non è conclusiva, si mantiene `IMPORT_UNKNOWN` e si riconcilia: la presenza di un ID in una nota Shopify non garantisce da sola unicità server-side.

La documentazione Shopify limita la garanzia `@idempotent` alle mutation che la supportano [S7]. Non presumere che `orderCreate` la supporti. Il coordinatore impedisce tentativi simultanei e conserva correlazione prima dell'invio; l'adapter deve definire il recupero degli esiti incerti. Nessuna ripetizione automatica oltre la finestra di idempotenza remota senza verifica.

Gli ordini pending possono richiedere prenotazioni prima di essere importabili. Una richiesta del cliente di annullare non equivale a cancellazione confermata. Un ordine multi-SKU ha una sola responsabilità d'importazione: non dividerlo fra Channable e M.A.R.E. perché contiene SKU appartenenti a lotti diversi.

La prima migrazione mantiene storici e ordini preesistenti in lettura. Nuove scritture ordini richiedono autorizzazione specifica del flusso e importano solo l'ambito concordato. Cancellazioni, rimborsi monetari e modifiche agli ordini esistenti rimangono separati dal permesso di importare ordini nuovi.

Disabilitare ricevute Shopify non richieste, campagne e flussi promozionali che potrebbero attivarsi all'importazione. Tag e origine ordine non bastano: collaudare le automazioni effettivamente collegate. Preservare valuta, sconti, imposte, spese di spedizione e responsabilità del marketplace senza creare un nuovo pagamento al cliente.

## 8. Spedizioni e tracking

Una spedizione è un collo con ID stabile, corriere/servizio verificato, tracking e righe ordine con quantità. La chiave include ordine esterno e ID collo, non solo tracking. Due colli non si fondono e un webhook ripetuto non produce una seconda conferma.

Prima della trasmissione verificare ordine, righe, quantità residue e stato logistico. Non confermare la spedizione alla sola creazione di un'etichetta se il flusso aziendale non attesta l'evasione. Le correzioni tracking aggiornano lo stesso collo. Il totale spedito/cancellato per riga non può eccedere quello ordinato.

Amazon `confirmShipment` supporta identificativi di collo e spedizioni multiple; alcuni flussi Buy Shipping/Ship+ hanno semantiche specifiche [S3]. Riconoscerli per evitare conferme superflue o non supportate. Non usare gli endpoint Shopify InventoryShipment, relativi a trasferimenti di magazzino, al posto dei fulfillment degli ordini cliente.

L'app richiede gli scope effettivamente necessari al modello di fulfillment usato; non richiedere permessi di scrittura Shopify a prescindere se è sufficiente leggere un'evasione già eseguita. Dopo l'invio, conservare esito e riscontro; in caso incerto mantenere la stessa identità collo e riconciliare.

## 9. Esecuzione sicura e stati

Stati comando: `DRAFT -> VALIDATED -> AUTHORIZED -> READY -> DISPATCHING -> ACCEPTED -> VERIFYING -> VERIFIED`. Stati laterali: `BLOCKED`, `REJECTED`, `UNKNOWN`, `RECONCILING`, `SUPERSEDED`, `EXPIRED`, `DEAD_LETTER`.

Il payload approvato è immutabile e include tenant/account, scope, ID prodotto, campi modificati, policy, revisione stock, schema, prove, epoch e scadenza. L'autorizzazione è un record server-side emesso da un percorso autenticato, non un booleano inviato dal chiamante. I retry mantengono lo stesso intento; una nuova quantità o una nuova policy richiede un nuovo comando.

Subito prima del dispatch il coordinatore ricontrolla validità dell'autorizzazione, stock/ordini recenti, ownership, revisione, schema e assenza di un invio non risolto sulla stessa offerta. Una modifica successiva della disponibilità può solo invalidare il vecchio piano, non farlo eseguire perché era stato approvato ieri.

Lease ed epoch proteggono lo stato locale, non annullano richieste HTTP già inviate. Un provider non è obbligato a comprendere il nostro fencing token. Non inviare un aumento successivo sulla stessa offerta mentre uno precedente è incerto; una risposta vecchia non deve sovrascrivere una revisione nuova. L'azzeramento dopo timeout richiede vigilanza su possibili applicazioni tardive.

Retry: backoff esponenziale con jitter per errori transitori e rispetto del rate limit per account/operazione. Errori di schema, restrizioni e autorizzazione non generano loop automatici. Dopo esito incerto di un'operazione con effetti, prima riconciliare. Per aggiornamenti quantità assoluti, ripetere la stessa richiesta non è automaticamente sicuro se potrebbe arrivare dopo una versione più recente.

## 10. Adapter Amazon e correzione della sequenza

1. Identità Shopify completa e univoca, stato ACTIVE, stock nelle location autorizzate, SKU immutato, esclusioni approvate.
2. Match GTIN esatto e verifica marca/modello/colore/taglia/variante; niente parent ASIN al posto del child. Anomalie di categoria restano in revisione, non diventano irrilevanti solo perché il GTIN corrisponde.
3. Contesto venditore e mercati provato; lettura offerta esistente, restrizioni e Product Type Definitions per il seller/mercato/requirements corretti.
4. Scaricare e validare lo schema, conservare checksum, versione e riferimenti. Non basta che il link allo schema esista. Non trattare `productTypeVersion` come stringa quando il modello restituisce un oggetto.
5. Costruire solo attributi previsti per `LISTING_OFFER_ONLY`, distinguendo nuovo listing da patch di uno esistente. `PRODUCT` è utilizzabile nel percorso supportato dal provider, non è un lasciapassare per ignorare requisiti o idoneità.
6. Eseguire `VALIDATION_PREVIEW` con la modalità fissata nel codice e schema/payload esatti; Amazon documenta questa modalità per `putListingsItem` [S1, S2]. Il metodo HTTP PUT di preview non equivale a pubblicazione; esporlo come operazione di preparazione controllata, mai consentire override della modalità.
7. Solo dopo i gate operativi: pubblicazione minima, riscontro di identificativi/issues/offerta/prezzo/quantità e stato effettivamente acquistabile. `ACCEPTED` significa presa in carico, non pubblicazione riuscita [S1].

Per ordini adottare il contratto Orders v2026-01-01 verificato; versionare separatamente le operazioni. Alla revisione la documentazione di conferma spedizione mantiene il percorso `orders/v0/.../shipmentConfirmation` [S3, S11]: NON sostituire tutti i percorsi v0 per analogia con le letture ordini. Autorizzazione e accesso a dati personali vanno provati per operazione, non dedotti dal funzionamento della ricerca catalogo.

Per il primo rilascio un polling ordini incrementale durevole con finestra sovrapposta e paginazione completa è sufficiente come percorso implementabile. Le notifiche possono ridurre latenza, ma non sostituiscono riconciliazione. `ORDER_CHANGE` documenta un workflow SQS [S12]: non assumere un webhook Amazon HTTPS arbitrario. Il bridge AWS resta un modulo opzionale con IAM verificato, non un requisito fittiziamente già installato.

## 11. Spartoo senza un secondo motore

L'adapter Spartoo riusa gli stessi ledger, tipi ordine/spedizione, policy stock, outbox, audit e test di comportamento. Cambiano identificatori, categorie/taglie, protocollo, rate limit, risposta agli errori e semantica del provider.

In questa revisione non è stato acquisito un contratto Spartoo verificabile: la pagina ufficiale nota non è risultata leggibile dal browser di ricerca e la ricerca nei file di progetto non ha restituito documentazione. Questo non prova che il contratto o gli accessi non esistano altrove. Non vengono inventati URL operativi, XML, credenziali, codici corriere o finestre di polling.

Prima di implementare l'adapter verificare: autenticazione e account/paesi; inventario unico o per paese; quantità assoluta o delta; sostituzione totale o merge del catalogo; effetto di una riga omessa; prezzo/IVA/valuta; ordini pending e cancellati; paginazione e date; eventuale accettazione obbligatoria; spedizioni parziali; modifica tracking; idempotenza; esiti asincroni; resi; ambienti di prova; limiti; lettura di riscontro. «Più semplice» è un'ipotesi sul costo dell'adapter, non una ragione per saltare i controlli comuni.

## 12. Passaggio da Channable senza doppie scritture

Per catalogo/prezzi/quantità la responsabilità può essere per account, mercato, SKU e campo. Per importazione ordini è per ordine intero e finestra/scope concordati; per tracking è per ordine/collo. Un PUT che modifica più campi richiede responsabilità su tutti quei campi.

Procedura: censire tutti i writer incluse automazioni Amazon cross-country -> bloccare nuove operazioni nell'ambito -> riconciliare ordini aperti e mapping storici -> disabilitare il writer precedente con prova esterna -> risolvere code e richieste in volo -> verificare stato remoto -> registrare nuova epoch -> autorizzare il lotto minimo.

Non assumere che escludere un prodotto dal feed Channable lasci l'offerta invariata: può avere una semantica di rimozione/azzeramento o interferire con l'importazione ordini. Va verificato prima. Il flag M.A.R.E. non può fermare Channable; un booleano locale non sostituisce la prova.

Un passaggio temporaneo può lasciare importazione ordini e tracking a Channable mentre M.A.R.E. controlla un lotto catalogo/stock, ma solo con copertura verificata del nuovo SKU, deduplica e riconciliazione dell'impegno stock. In assenza di tale prova, implementare prima il percorso operativo diretto e non vendere il pilot.

Rollback: fermare aumenti e nuove scritture, riconciliare esiti incerti, riportare quantità sicure ove possibile, fermare il writer M.A.R.E., verificare code ed effetti, incrementare epoch e solo allora riattivare il precedente writer. Non attivare due sistemi contemporaneamente per «tornare indietro più in fretta».

## 13. Sicurezza, dati e osservabilità

Autenticazione tenant-aware, ruoli separati per letture, preparazioni, autorizzazioni, esecuzioni e emergenze. Credenziali solo server-side e privilegi minimi; seller ID è configurazione d'identità, non prova di autorizzazione e non necessariamente un segreto. Non copiare credenziali fra sistemi né richiederle in chat.

Webhook Shopify: HMAC sul body grezzo, deduplica persistente e riscontro rapido [S5]. Gli URL di schemi/report/media ricevuti dal provider richiedono HTTPS, allowlist, limiti di dimensione/tempo e nessun inoltro di bearer a un host diverso. Seguire link temporanei non autorizza a registrarli nei log.

Il repository è pubblico: codice e fixture sintetiche soltanto. Dati cliente, indirizzi, ordini, costi, vendite e mapping operativi completi stanno in storage privato, con policy di accesso e conservazione approvata. Eliminare l'uso di fixture reali nella PR #199; rimuoverle dalla punta del branch non cancella la storia Git. Non è stata rilevata/eseguita una rotazione credenziali in questa revisione.

Per informazioni personali definire base operativa, minimizzazione, cifratura, conservazione per scopo e cancellazione, inclusi backup e log. Nessuna finestra di retention universale inventata. Senza autorizzazioni provider e policy applicabili verificate, non attivare importazione indirizzi.

Monitor indipendente dal Worker operativo: heartbeat, età ultimo ordine completo, età stock per pool, ritardo outbox, comandi UNKNOWN, divergenze, errori schema, token, ownership e spedizioni senza riscontro. Il servizio guasto non può essere l'unico a segnalare il proprio guasto.

## 14. Obiettivi misurabili, non promesse già conseguite

Soglie iniziali da validare nel pilot e approvare in configurazione: ricezione webhook <2 s p95; aggiornamenti stock prioritari entro 60 s p95 dal segnale acquisito; polling ordini ogni 30–60 s quando consentito; letture stock/ordini per nuovi aumenti non più vecchie di 120 s; allarme per indisponibilità del percorso critico entro 5 min. Sono obiettivi, NON garanzie Amazon/Shopify o misure attuali.

Se i limiti provider non consentono queste soglie, si riduce esposizione/lotti o si sospendono gli aumenti; non si aumenta tacitamente il rischio. Misurare separatamente tempo del segnale provider, acquisizione, dispatch, accettazione e visibilità remota.

Backup e ripristino devono essere testati. Il ripristino del database riporta il sistema in modalità di riconciliazione: gli effetti remoti già eseguiti non si annullano ripristinando una tabella. Non riprodurre una vecchia outbox come se nessun invio fosse avvenuto. Obiettivi RTO/RPO richiedono misurazioni e recovery drill prima della produzione.

Versioni API, schema e dipendenze sono fissate e aggiornate con test. Non cambiare globalmente la versione Shopify del backend esistente solo per introdurre il nuovo modulo. Verificare versione effettivamente servita, scope e compatibilità del percorso marketplace.

## 15. Collaudo richiesto

Oltre ai test unitari: contratti reali di serializzazione, integrazione con reader effettivi, runtime Cloudflare locale, fault injection e test provider circoscritti. Sandbox e mock non garantiscono regole effettive dell'account venditore.

Casi obbligatori:

| ID | Scenario | Risultato richiesto |
|---|---|---|
| T01 | Reader reale privo di flag richiesti | Test fallisce prima del merge, non solo sul live |
| T02 | Varianti/location troncate | Nessun aumento autorizzato |
| T03 | SKU duplicato, UPC valido, zeri iniziali | Quarantena del duplicato; identità preservata |
| T04 | EAN coincide ma colore/taglia/child no | Match non autorizzato |
| T05 | 404 generico, seller errato o permesso assente | Assenza non certificata |
| T06 | Schema reale, versione oggetto, ref non sicuro | Parsing corretto o blocco |
| T07 | Webhook duplicato con stesso ID | Un solo effetto locale |
| T08 | Stesso ID con payload conflittuale | Quarantena, nessun overwrite |
| T09 | Evento/risposta vecchi dopo quelli nuovi | Nessun rollback dello stato |
| T10 | Crash fra commit inbox e riscontro HTTP | Recupero senza perdita o duplicazione |
| T11 | Crash fra commit outbox e trasporto | Recovery tramite outbox |
| T12 | Timeout dopo ordine creato da Shopify | IMPORT_UNKNOWN; niente seconda creazione |
| T13 | Ordine già importato da Channable | Mapping adottato, nessuna duplicazione |
| T14 | Ordine multi-SKU/multi-pagina | Un ordine, prenotazioni coerenti |
| T15 | Pending -> cancellazione confermata | Rilascio soltanto secondo stato e prova |
| T16 | BYPASS o decremento doppio | Test blocca la configurazione errata |
| T17 | Ultimo pezzo acquistabile in due mercati | Nessuna nuova sovra-allocazione autorizzata |
| T18 | Riduzione inviata ma non confermata | Capacità non riutilizzata |
| T19 | Aumento incerto e tentativo successivo | Riconciliazione prima di nuova scrittura |
| T20 | Stock esterno scende sotto esposizione | CAPACITY_DEFICIT e riduzioni prioritarie |
| T21 | Vendita concorrente sito/POS | STRICT_POOL provato o rischio esplicito |
| T22 | Stesso inventario remoto condiviso fra paesi | Conteggio per superficie reale |
| T23 | Ordine FBA | Nessun decremento FBM locale |
| T24 | Cambio ownership durante richiesta HTTP | Vecchio job non autorizza altro lavoro |
| T25 | Migrazione con ordine che attraversa il cutoff | Un solo importatore e mapping stabile |
| T26 | Tracking duplicato/parziale/corretto | Identità collo e quantità preservate |
| T27 | Annullamento richiesto o rimborso senza reso fisico | Nessuna disponibilità inventata |
| T28 | 429/5xx e coda catalogo massiva | Stock/ordini non affamati, retry limitati |
| T29 | Schema mutato o preview scaduta | Piano da rivalidare |
| T30 | ACCEPTED ma issues bloccanti | Non dichiarato vendibile |
| T31 | Calendario IT e cambio ora legale | Gate per brand/stagione/mercato corretto |
| T32 | Import attiva email/campagne | Gate fallisce e automatismo disabilitato |
| T33 | Ripristino database dopo invio remoto | Riconciliazione, non replay cieco |
| T34 | Provider completamente irraggiungibile | Esposizione incerta e allarme indipendente |
| T35 | Fixture/log con dati operativi o segreti | Build/review blocca pubblicazione |
| T36 | Spartoo adapter con semantica diversa | Stesse invarianti, contratto specifico |

Nella revisione è stato eseguito separatamente un modello sintetico di esposizione/inbox: 12 scenari deterministici e 2.646 transizioni enumerate. Non usa API e non è il coordinatore di produzione. Verifica un sottoinsieme delle regole locali; non prova la convergenza remota, la corretta importazione ordini o l'assenza assoluta di overselling.

## 16. Sequenza implementativa e gate di uscita

| Incremento | Contenuto | Gate prima del successivo |
|---|---|---|
| R0 | Correggere PR #199, contratto reader/schema, fixture sintetiche e test negativi | Test reale dei moduli collegati; nessuna scrittura |
| R1 | Core TypeScript + DO: identità, ownership, inbox/outbox, ledger, exposure | T07–T11, T17–T20, T24, T33 nel runtime |
| R2 | Ingestione Shopify e ordini Amazon read-only, cursori, riconciliazione | Completezza e freschezza dimostrate, tutti i pool censiti |
| R3 | Payload Offer Only + schema + VALIDATION_PREVIEW | Preview provider documentata, piano immutabile, nessuna pubblicazione |
| R4 | Ordini/import/stock/tracking e STRICT_POOL, oppure delega temporanea comprovata | Ciclo end-to-end verificato e responsabilità trasferibile |
| R5 | Cutover di un lotto minimo e prima quantità positiva | Readback vendibile, ordine/stock/tracking coperti, rollback provato |
| R6 | Secondo mercato, lotti graduali e soak test | Nessun duplicato, drift o esito incerto aperto nell'ambito |
| R7 | Adapter Spartoo sullo stesso core | Contratto provider acquisito e stessi test comuni |

R0 e contratti possono essere implementati subito. R2/R3 possono procedere in parallelo dopo contratti stabili. Nessuna quantità positiva per anticipare R4. I lotti massivi arrivano dopo il controllo del ciclo operativo, non prima.

Prima di ogni release: baseline e diff esatti, test, approvazione coerente col rischio, feature flag spenti per le nuove scritture, deploy isolato, smoke test autenticato e readback. Un merge non deve essere usato come scorciatoia per saltare il consenso al passaggio di responsabilità. Non disattivare globalmente Channable.

## 17. Decisioni ancora subordinate a prove

Restano da provare: scope/ruoli reali per singola operazione; meccanismo Shopify STRICT_POOL e location routing; copertura ordini/tracking durante il pilot; contratto Spartoo; idempotenza/readback delle operazioni provider; monitor indipendente; conservazione dati; soglie operative. Non sono motivi per bloccare la scrittura del codice R0–R3; sono gate che impediscono di vendere con un sistema incompleto.

La revisione architetturale è sufficiente per tornare allo sviluppo a blocchi. Tornare a una revisione profonda dopo ledger + import ordini e prima della prima quantità positiva, non dopo avere già allargato il lotto.

## Fonti primarie consultate il 18 ottobre 2026

- [S1] Amazon, Listings Items e stato submission: https://developer-docs.amazon.com/sp-api/reference/putlistingsitem
- [S2] Amazon, Validation Preview e Product Type Definitions: https://developer-docs.amazon.com/sp-api/docs/preview-errors-before-creating-a-listing ; https://developer-docs.amazon.com/sp-api/reference/getdefinitionsproducttype
- [S3] Amazon, conferma spedizione: https://developer-docs.amazon.com/sp-api/docs/confirm-the-shipment-status ; https://developer-docs.amazon.com/sp-api/reference/confirmshipment
- [S4] Shopify, ordering e riconciliazione webhook: https://shopify.dev/docs/apps/build/webhooks
- [S5] Shopify, verifica HMAC, duplicati e riscontro: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- [S6] Shopify, creazione ordini e comportamento inventario: https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate ; https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OrderCreateOptionsInput
- [S7] Shopify, idempotenza per mutation supportate: https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency
- [S8] Cloudflare, storage transazionale DO: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- [S9] Cloudflare, delivery guarantees: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- [S10] Cloudflare, Workers KV: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- [S11] Amazon, migrazione Orders: https://developer-docs.amazon.com/sp-api/docs/orders-api-migration-guide
- [S12] Amazon, tipi di notifiche: https://developer-docs.amazon.com/sp-api/docs/notification-type-values

Le fonti descrivono i contratti generali, non attestano permessi o idoneità dell'account. Alcune pagine pubbliche espongono versioni/cache non allineate; pinning e prove per l'operazione concreta restano obbligatori.
