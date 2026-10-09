# M.A.R.E. — integrazione diretta marketplace, fondazione shadow

Stato al 9 ottobre 2026: codice verificato localmente, nessun deploy eseguito,
nessuna offerta, giacenza, spedizione o ordine modificato. Questo rilascio NON
sostituisce Channable. Il servizio implementa lettura e riconciliazione del catalogo,
un ledger persistente e la preparazione offline del lotto pilota; gli adapter di
scrittura, gli ordini marketplace e i tracking sono ancora da implementare.

## Accessi effettivamente verificati

MARE Business OS `mare_system_status` e `mare_capabilities` sono stati interrogati
il 09/10/2026. Shopify ha risposto con dati reali. Il backend è disponibile nel
repository `devidlabel/devidlabel-ai-assistant-backend`; main usa Cloudflare Worker
`src/worker-v4.ts`, OAuth KV e due Durable Objects. Il file wrangler letto non
configura cron marketplace. Queste verifiche non provano disponibilità di un host
Linux né accesso amministrativo all'account Cloudflare.

| Connessione | Risultato verificato | Limite |
|---|---|---|
| Shopify via MARE | Lettura reale di prodotti, varianti, prezzi e stock | GPSR non esposto nel reader |
| Amazon via MARE | amazon_sp_api configured=false; listings.sync implemented=false | Nessuna chiamata SP-API autenticata possibile |
| Spartoo via MARE | catalog.sync configured=false, implemented=false; SPARTOO_API_KEY mancante | Contratto webservice non verificato |
| Channable | Nessuna capacità esposta dai connettori di questa sessione | Scritture e code non ispezionabili |
| GitHub | File backend letti tramite il connettore | Deploy e credenziali runtime non disponibili |

Non dedurre l'assenza globale di credenziali Amazon dal solo stato del connettore:
prima della configurazione verificare eventuali autorizzazioni già presenti nel
servizio operativo. Non copiare token di Channable e non chiedere segreti in chat.

## Risultati della lettura reale

La richiesta unica da 2.500 prodotti fallisce con `Too many subrequests by single
Worker invocation`. Il reader restituisce un cursore ma ignorava `after` in input.
La lettura è stata eseguita per partizioni di 40 prodotti ordinate per updated_at,
includendo il secondo limite ed escludendo gli ID già letti a quel secondo.
L'ultimo lotto restituisce `truncated=false`. Un errore Shopify 502 è stato superato
riprendendo dall'ultimo lotto riuscito. Sono stati acquisiti 3.982 ID prodotto
distinti e 10.190 varianti. La scansione iniziale più 99 partizioni è documentata
nel fascicolo delle evidenze (verificare il numero nel ledger consegnato).

| Controllo | Risultato |
|---|---:|
| Prodotti ACTIVE / DRAFT / UNLISTED / ARCHIVED | 2.499 / 387 / 1.084 / 12 |
| Varianti senza SKU | 5 |
| SKU composti solo da cifre | 0 |
| SKU da quarantena, inclusi quelli mancanti | 151 |
| Codici a barre mancanti | 2.586 |
| GTIN presenti non validi, lunghezza o checksum | 14 |
| Valori SKU condivisi da più varianti | 169 |
| Valori barcode condivisi da più varianti | 207 |

Il validatore riconosce GTIN-8/UPC-12/EAN-13/GTIN-14. I codici UPC non sono
erroneamente trattati come EAN invalidi. Alcuni SKU iniziano con il marchio 4B12:
non sono numerici obsoleti; attendono una regola di prefisso esplicitamente approvata.
Nel catalogo è stata osservata una sede, `gid://shopify/Location/115366396245`,
`Shop location`. Non è stata verificata indipendentemente la lista completa delle
sedi. Il vecchio reader limita inventoryLevels a 10 e media/collezioni a 20.

Questa è un'enumerazione terminata durante letture successive, non uno snapshot
atomico né una verifica indipendente del conteggio totale Shopify. Le modifiche
avvenute durante la scansione richiedono una seconda passata da started_at e una
riconciliazione degli ID. GPSR, requisiti per paese, catalogo Amazon/Spartoo,
offerte esistenti e ordini marketplace non sono stati letti. Le URL immagini
firmate sono scadenzate: nel fascicolo è rimossa la query; l'accessibilità pubblica
del percorso restante non è verificata e quelle URL non sono pronte per un feed.

## Lotto pilota Amazon

12 varianti ACTIVE, SKU alfabetico univoco, EAN-13 valido e univoco, stock osservato
positivo. Include sneaker BK70 e giacche K-Way. Il manifest è un lotto di analisi
con quantity=0, asin=null e sei blocchi espliciti. Non è un feed SP-API validato,
non dimostra idoneità di brand/categoria e non va caricato su Amazon.

Passi successivi dopo l'accesso autenticato:

1. GetMarketplaceParticipations: verificare seller, paesi autorizzati e regione.
2. Cercare gli EAN, paginare tutte le risposte e leggere gli attributi dei candidati.
   EAN da solo non basta: confrontare brand, modello, colore, taglia e sistema taglia.
   Non abbinare al parent ASIN quando occorre una variante child.
3. Per prodotto/paese recuperare Product Type Definitions, categorie, browse nodes,
   enum e vincoli; salvare versione/hash/schema e provenienza di ogni mapping.
4. Ricostruire GPSR da dati verificati: produttore, contatti, responsabile UE ove
   applicabile, avvertenze e documenti richiesti dallo schema. Non inferire contatti.
5. Generare payload offer-only per ASIN esistente; nuova scheda solo con dati
   completi. Eseguire VALIDATION_PREVIEW, conservare gli issue per SKU/paese/campo.
6. Leggere tutti gli ordini e prenotare le vendite non ancora riflesse in Shopify.
   Identificare FBA/FBM, pending e cancellazioni. FBA non usa lo stock FBM Shopify.
7. Verificare il passaggio di responsabilità da Channable; poi inviare il lotto
   minimo con lettura di riscontro, controllo issues e stato effettivamente vendibile.

Il client Amazon incluso implementa soltanto LWA, partecipazioni e ricerca EAN.
Non è stato testato contro SP-API, non pagina ancora i candidati e non recupera
lo schema dettagliato. La scrittura e la preview provider non sono implementate.

## Invarianti del nucleo

`core.py` usa SQLite WAL, transazioni immediate e chiavi idempotenti. Memorizza
ownership per canale/paese/flusso/ambito, epoch, ledger ordini, eventi, job,
tentativi, scadenze dei lease, checkpoint e audit. Le prenotazioni duplicate non
si sommano; eventi fuori sequenza non sovrascrivono versioni nuove. Quantità e
versioni conflittuali bloccano l'elaborazione.

Budget = max(0, somma available delle sedi abilitate − vendite marketplace non
ancora riflesse in Shopify − buffer). Shopify available già esclude committed:
non sottrarre committed una seconda volta. Lo stato reflected richiede prova
con versione esatta e lettura di riscontro; dopo una modifica ordine torna falso.
Stock o ordini incompleti/non freschi: budget zero. La somma delle allocazioni
Amazon+Spartoo+altri canali non può superare il budget condiviso. Questa regola
limita il rischio di vendite concorrenti: non costituisce una transazione atomica
fra marketplace. Prenotazioni e allocazioni richiedono un coordinatore unico e
latenze operative misurate prima dell'attivazione.

Gli SKU puramente numerici sono tombstone quantità zero. Quelli presenti solo sui
marketplace vanno censiti leggendo le offerte di quei canali, senza cancellarli.
Quarantena anche per SKU assenti, prefissi non classificati, duplicati e identità
incomplete. Nessuna scrittura su ordini esistenti in analisi/test.

I job hanno lease con token; un worker scaduto non può completare un job riassegnato.
Errori transitori hanno backoff limitato e numero massimo di tentativi; errori
permanenti vanno in dead letter. Un invio esterno con esito incerto richiede
riconciliazione, non reinvio cieco. L'idempotenza locale non prova l'idempotenza
provider. Il rilascio non dispone di dispatcher live.

## Transizione Channable

Channable conserva inizialmente catalogo, prezzi, stock, importazione ordini e
tracking per ogni paese/SKU. La modalità shadow MARE legge e prepara confronti.
L'ownership locale non può bloccare Channable: serve evidenza esterna della sua
esclusione dall'ambito pilota. Prima del cambio: disabilitare il precedente writer,
svuotare/verificare le code in volo, riconciliare ordini e stock, fare readback,
registrare il riferimento della prova e incrementare epoch. I vecchi job MARE
sono invalidi dopo il cambio. Il rollback richiede la stessa procedura inversa;
non riattivare Channable mentre MARE può ancora inviare.

I flussi sono `catalog`, `price`, `inventory`, `order_import`, `shipping`.
Pubblicazione di schede e offerte deve essere valutata insieme agli attributi
che contiene: un PUT completo può alterare stock o prezzi, quindi non è sufficiente
avere ownership del solo catalogo. La configurazione futura deve verificare
ownership di ogni campo/flusso interessato prima del dispatch.

## Servizio sempre acceso

Il template systemd `mare-marketplace.service` è pronto per un host Linux dedicato.
Non è stato installato e la chat chiusa non avvierà questo codice. Python >=3.12,
nessuna dipendenza esterna. Il polling legge una partizione ogni 15 secondi,
con backoff fino a un'ora; completata la scansione, ne avvia un'altra dopo 24 ore.
Non è ancora un cron di riconciliazione stock/offerte né un consumer webhook.
Non condividere un database SQLite via filesystem di rete. Una sola istanza del
scanner; coordinare futuri consumer attraverso il ledger. Backup consistente con
SQLite backup API e ripristino provato prima dell'esercizio.

Installare il codice in `/opt/mare/integrations/marketplace`, creare l'utente di
servizio e la directory protetta `/etc/mare`. Configurare server-side, senza valori
nel repository, `/etc/mare/marketplace.env` con:

```
MARE_READ_ENDPOINT=https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/mcp-business
MARE_BUSINESS_ACCESS_TOKEN=<riferimento al segreto già esistente nel backend>
```

Il bearer esistente non è esposto alla sessione: usare l'accesso amministrativo
all'host/secret store, non creare una nuova app Shopify. Per Amazon verificare in
modo sicuro presenza e autorizzazione di AMAZON_SP_API_CLIENT_ID,
AMAZON_SP_API_CLIENT_SECRET e AMAZON_SP_API_REFRESH_TOKEN; completare seller ID,
marketplace IDs, regione e ruoli effettivi. Non configurarli prima di controllare
eventuali accessi già esistenti. `AmazonReader` non viene chiamato dal daemon:
serve un comando pilota dedicato dopo l'integrazione degli adapter mancanti.

Installare l'unit systemd, poi `systemctl enable --now mare-marketplace` e
verificare `systemctl status mare-marketplace` e journal. Il deploy richiede un
host identificato e autorizzato; il repository da solo non fornisce tale servizio.
Alternativa futura: un Worker dedicato con Queue + Durable Object/D1 + cron,
riutilizzando OAuth Shopify server-side e budgetando le subrequest per task.
Non aggiungere questo polling al thread della chat.

Monitoraggio disponibile: audit SQLite, checkpoint last_success_at, contatori
jobs per state e journal systemd. Da completare: endpoint health, allarmi esterni
su heartbeat >10 minuti, ordini arretrati, issue di pubblicazione e stock divergente.
I log non includono segreti o dati cliente. La loro visibilità fuori dal server
non è stata configurata.

## Spartoo e spedizioni: blocchi e contratto da acquisire

La documentazione ufficiale `https://www.spartoo.com/mp/documentation.php` non è
accessibile dal lettore web usato. Non sono stati inventati endpoint, XML o token.
Verificare con l'accesso venditore già esistente merchant webservice ID, paesi,
autenticazione, formati, categorie/marchi/taglie, immagini, prezzi IVA/valuta,
GPSR, rate limit, stock, ordini pending/cancellati, ack e stati di spedizione,
tracking, resi, errori asincroni, idempotenza e sandbox. Solo dopo fixture ufficiali
e test di contratto implementare il plugin Spartoo.

Tabella corrieri futura versionata per marketplace/paese: codice interno, codice
provider, servizio e formato tracking. Nessun default silenzioso per corriere
ignoto. Confermare spedizione solo dopo evento Shopify di fulfillment verificato,
deduplicando ordine/collo/tracking. Marketplace readback obbligatorio; resi e
cancellazioni devono aggiornare le prenotazioni con stati verificati.

## Test e limiti verificati

Eseguiti localmente: 10 test Python (tutti passati) e test Node della ripresa del
reader e dei flag di completezza (passato). Le due query GraphQL modificate sono
state validate sia dal connettore Shopify sia dal toolkit, contro 2025-10.
Non eseguito typecheck/build dell'intero backend: questa sessione ha letto e
materializzato solo i file necessari, non un checkout completo. Nessun test live
Amazon, Spartoo, webhook, systemd o riconciliazione ordini.

```
cd integrations/marketplace
python3 -m unittest -v test_core.py
python3 service.py --audit-file /path/catalog-snapshot.json
# Dalla root repository, con Node 24:
node scripts/test-marketplace-catalog-resume.mjs
```

Le modifiche a `mare-business-shopify-complete.ts` acquisiscono after e rendono
espliciti i limiti delle connessioni correlate. Non rimuovono il limite 2.500 né
risolvono da sole il limite subrequest: usare lotti da 30 nel servizio.
Resta da implementare paginazione completa di sedi/media/collezioni e GPSR prima
di usare i dati per pubblicare.

## Riferimenti primari verificati

- https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
- https://developer-docs.amazon.com/sp-api/reference/searchcatalogitems
- https://developer-docs.amazon.com/sp-api/reference/getmarketplaceparticipations
- https://developer-docs.amazon.com/sp-api/docs/manage-product-listings-guide
- https://developer-docs.amazon.com/sp-api/docs/listings-items-api
- https://developer-docs.amazon.com/sp-api/docs/notification-type-values
- https://shopify.dev/docs/api/admin-graphql/2026-10/queries/inventoryItem
- https://www.spartoo.com/mp/documentation.php (accesso non riuscito)
