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
| GitHub | Backend, workflow e job letti; deploy storico confermato | Nessun deploy nuovo; valori secret non letti |

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

## Esecuzione autonoma su Cloudflare

La destinazione scelta è Cloudflare. Il template systemd e il daemon Python
restano riferimenti di sviluppo; non sono il percorso di installazione operativo.
`src/marketplace-shadow.ts` riutilizza il Worker `worker-v4.ts` e i suoi accessi
Shopify esistenti. Non serve una nuova app Shopify né copiare token in chat.
Il runner `MareMarketplaceShadow` usa un nuovo Durable Object con backend SQLite,
isolato dallo stato della chat. La chiusura della chat non influenza cron/allarmi
DOPO il deploy e l'abilitazione. Il primo deploy è verificato; l'abilitazione
è proposta nel rilascio successivo e deve essere verificata sullo stato live.

Configurazione in `wrangler.toml`:

- `MARE_MARKETPLACE_SHADOW_ENABLED="true"`: abilita esclusivamente scansioni in
  lettura nel rilascio proposto dopo conferma Workers Paid. Il primo deploy
  usava false; la configurazione proposta non dimostra ancora attività live.
- binding `MARE_MARKETPLACE_SHADOW`, classe `MareMarketplaceShadow`, migrazione
  `v3_mare_marketplace_shadow`; preservare le due migrazioni esistenti.
- cron `*/5 * * * *` UTC: watchdog che ripristina l'allarme, non una scansione
  completa ogni cinque minuti. Allarmi DO: una pagina di massimo 20 prodotti,
  attesa minima 2 secondi; nuove scansioni ogni 30 minuti dalla partenza precedente.
- osservabilità abilitata; log di errore limitati a codice, contatore e data del
  prossimo tentativo. Nessun token, payload cliente o errore provider integrale.

Checkpoint, fotografie e prossimo allarme sono aggiornati in transazione.
Prima della lettura viene salvato un lease di 120 secondi con token; una risposta
scaduta non può aggiornare una pagina riassegnata. Un errore lascia il cursore
invariato; backoff da 5 secondi a 15 minuti con jitter, senza abbandonare il lavoro.
La pulizia elimina il precedente snapshot in lotti da 100 chiavi, conservando
quello completato più recente durante la scansione successiva. Gli SKU numerici
sono `legacy_zero`; prefissi non classificati, incluso 4B12, sono `quarantine`.
Ogni record ha quantità proposta zero: non esiste un sender marketplace nel runner.
Il ledger prenotazioni Python NON è ancora portato nel runner Cloudflare.

Le scansioni usano ordine ID crescente e cursori validati; il comportamento
UPDATED_AT preesistente rimane il default per gli altri utilizzatori del reader.
Le scansioni shadow non generano migliaia di artefatti temporanei nel KV OAuth.
Non sono snapshot atomici: prodotto e stock possono cambiare durante una passata.
I flag di completezza restano falsi per media/collezioni/sedi troncate; GPSR non
è letto. La versione API operativa rimane 2025-10; il toolkit ha rifiutato tale
versione e le query aggiornate sono state validate contro 2026-10. Il precedente
reader era già validato contro 2025-10. Verificare la versione supportata in
produzione e pianificare l'aggiornamento prima dell'esercizio continuativo.

`GET /internal/marketplace/status` richiede il bearer MARE già esistente.
Risponde con scansione in corso, ultima scansione completata, data della più
vecchia osservazione, contatori e prossimo tentativo. Non espone il catalogo.
`healthy` richiede runner abilitato, dati correlati completi, assenza di errori e
osservazioni entro un'ora dalla partenza; `ready_for_marketplace_writes` è SEMPRE
false. Non usare la sola risposta HTTP 200 come prova di salute.

Il limite orario è un obiettivo da misurare, non una garanzia già verificata:
scansioni avviate ogni 30 minuti devono terminare entro 30 minuti sotto carico;
allarmi/cron possono ritardare. Al superamento dell'ora il sistema dichiara stock
non fresco. Nessuna pubblicazione si basa su dati vecchi. Prima dell'attivazione delle scritture marketplace:
monitor indipendente con bearer server-side e allarme su healthy=false/heartbeat,
misura latenza Shopify/ordini, test di recupero in produzione e durata di almeno
due scansioni complete. Monitor/allarmi esterni, webhook, ledger ordini Cloudflare,
GPSR, adapter Amazon/Spartoo e tracking restano da completare.

### Pipeline e rilascio

Il deploy automatico ESISTE in `.github/workflows/deploy-worker.yml` tramite
GitHub Actions + Wrangler; Cloudflare Builds non deve essere ricollegato.
PR su main: solo controlli. Push su main per i percorsi rilevanti o dispatch:
controlli, poi deploy con CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID già referenziati
nei secret GitHub. Un deploy storico riuscito non dimostra validità attuale dei
secret; non sono stati letti o modificati. Il primo controllo della PR #153 era
fallito per campo duplicato nel reader, corretto in questo aggiornamento.

La pipeline usa ora `npm ci` con lockfile, test di recupero/reader, prova locale
workerd e dry-run del bundle prima del deploy. I controlli legacy POST-deploy
possono fallire dopo una pubblicazione riuscita: la ricevuta del 01/09/2026 è
ok=false nonostante worker_deployed=success. Non esiste rollback automatico
verificato. Prima di un rilascio live servono baseline/versione di ritorno e prova
compatibilità migrazioni. Per fermare il runner disabilitare il flag mantenendo
classe/binding/migrazione; non cancellare il DO o riattivare Channable sullo stesso
flusso mentre esistono invii MARE in volo. Il flag shadow non abilita alcuna scrittura.

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

## Test precedenti e limiti verificati

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

## Aggiornamento Cloudflare del 09/10/2026

Typecheck completo passato. Tutti i controlli npm della pipeline sono stati
eseguiti localmente (senza probe live degli ordini). 14 casi di recupero shadow
passati, test del reader su cursori/completezza/ordine ID/assenza artefatti passati,
10 test Python passati. La prova workerd con reader sintetico verifica auth,
transazioni SQLite, allarme automatico, snapshot e persistenza dopo riavvio del
runtime; non chiama Shopify/Amazon e non simula una regione Cloudflare in guasto.
Bundle Wrangler dry-run riuscito, nessun deploy. Risultati dettagliati in
`validation-cloudflare.json` e `graphql-validation.json`.

```
npm ci
npm run typecheck
npm run test:marketplace-shadow
npm run test:marketplace-runtime
npx wrangler deploy --dry-run
```

Nessuna modifica di ordini, offerte, tracking, credenziali o Channable.

### Abilitazione shadow del 9 ottobre 2026

La schermata del proprietario delle 18:31 (Europe/Rome) mostra Purchase complete,
subscription active e Workers Paid Plan a 5 USD/mese. La prova manuale è registrata
in `ops/marketplace/plan-evidence.json`. La diagnosi API precedente resta 403
per permesso billing read assente: non viene riscritta come conferma API positiva.

Il rilascio propone flag true e la capability autenticata read-only
`marketplace.shadow.status`, tramite `mare_read` con richiesta vuota. Espone
progress (inizio, pagine, prodotti, varianti), ultimo snapshot, errori e freschezza;
non avvia scansioni e non espone segreti o catalogo. I deploy vengono serializzati
con concurrency cloudflare-production e cancel-in-progress false.

Verifica locale: typecheck, 16 test di recupero, reader/cursori, workerd con SQLite
e riavvio persistente, contratti MARE e dry-run Wrangler riusciti. La versione
precedente verificata è ec15e867-c930-49ab-b2a4-17a2092aeb8d. Dopo il deploy occorre
verificare enabled=true e last_page_at/progress in aumento; una scansione completa
e la frequenza oraria richiedono misurazioni live ulteriori. ready_for_marketplace_writes
resta false. Il controllo YouTube 502 della pipeline precedente è ancora irrisolto;
controllare ricevuta di deploy e stato live anche se il gate finale fallisce.
