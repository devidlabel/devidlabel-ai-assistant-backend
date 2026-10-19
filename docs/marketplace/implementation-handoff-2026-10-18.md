# Passaggio alla fase implementativa — 18 ottobre 2026

Questo documento integra normativamente `architecture-v1-2026-10-18.md` e `pr-199-review-2026-10-18.md`. Il disegno è pronto per essere implementato a blocchi; non attesta che gli adapter o il coordinatore siano già in produzione.

## 1. Autonomia reale: non chiedere conferma per ogni ordine

La chat non deve approvare ogni aggiornamento stock o tracking. Il titolare approva una policy circoscritta con tenant/account, marketplace, ambito prodotti, flussi, limiti quantitativi, intervalli prezzo, finestre temporali, scadenza e criteri di arresto. La policy non può essere impostata da contenuti catalogo o da un comando non autenticato.

All'interno di quella policy, il coordinatore genera e autorizza server-side comandi immutabili per gli aggiornamenti ordinari, conservandone motivazione ed evidenze. Una nuova revisione stock genera un nuovo comando sotto la stessa policy valida: non richiede una nuova conversazione. Questo è un percorso da implementare e testare; non equivale ad avere disabilitato oggi le approvazioni delle capability M.A.R.E. esistenti.

| Operazione dopo abilitazione del relativo flusso | Comportamento proposto |
|---|---|
| Letture, riconciliazione, refresh dei requisiti | Automatico, con limiti e monitor |
| Riduzione stock/zero in ambito posseduto | Automatico e prioritario, con riscontro |
| Aumento stock entro budget e policy | Automatico solo con fonti complete/recenti e nessun esito incerto |
| Prezzo entro regole e soglie approvate | Automatico con controllo variazione e valuta |
| Import ordine nuovo dell'ambito assegnato | Automatico, unico importatore, deduplica e prova stock |
| Tracking di un collo effettivamente evaso | Automatico con mapping corriere e quantità |
| Nuovo paese, nuovo brand o nuova categoria | Nuova abilitazione del perimetro |
| Creazione catalogo con fatti incerti | Revisione; nessuna invenzione automatica |
| Rimborso monetario, cancellazione richiesta dal cliente, modifica ordine preesistente | Flusso e autorizzazione separati |
| Trasferimento da/verso Channable o cambio dei limiti | Nuova approvazione e prove esterne |

Il kill switch è nello stato autorevole del coordinatore, non esclusivamente in una cache a consistenza eventuale. `PAUSE_INCREASES` blocca nuova esposizione senza perdere ordini; `EMERGENCY_ZERO` tenta riduzioni nel perimetro posseduto; `STOP_DISPATCH` sospende tutti gli invii previsti dal piano di incidente. Nessuna modalità dichiara annullati gli effetti già remoti. In caso di compromissione l'incident runbook può richiedere revoca server-side, distinta da un normale stop operativo.

## 2. Catalogo continuo: uscire dal filtro non deve lasciare stock remoto

Il filtro ACTIVE + stock positivo è un criterio per candidare NUOVE offerte. Non è il filtro dell'intero sistema di riconciliazione.

Se un'offerta già gestita passa a stock zero, prodotto DRAFT/ARCHIVED, variante rimossa, sospensione commerciale o esclusione approvata, mantenere la sua identità nel registro e produrre il desiderato sicuro, di norma quantità zero. Verificare l'effetto remoto prima di chiudere il caso. Non cancellare l'offerta o rinominare lo SKU come effetto implicito.

L'assenza di un prodotto da una pagina o da una scansione incompleta non dimostra cancellazione: servono tombstone o lettura completa/esplicita con riscontro. Non trasformare un errore di lettura in una modifica indiscriminata a tutto il catalogo. I codici legacy e gli SKU presenti soltanto sui marketplace restano in inventario di riconciliazione e in quarantena fino a una policy verificata.

Questo requisito evita un difetto comune: eliminare dal feed i prodotti esauriti, lasciando l'ultima quantità positiva pubblicata sul marketplace.

## 3. Contratto di copertura prima del primo pezzo vendibile

Il pilot può iniziare con letture e preview senza ordini reali. Prima della quantità positiva deve esistere una prova per ciascuno di questi punti:

1. Identità prodotto e schema corretti, prezzo approvato, stock riservato secondo il modello scelto.
2. Singolo writer per tutti i campi interessati; nessuna richiesta concorrente o non risolta.
3. Ordini intercettati anche se contengono sia SKU del pilot sia SKU non ancora migrati.
4. Un solo importatore per ordine; mapping e impegno stock verificabili in Shopify.
5. Percorso fulfillment/tracking funzionante, con colli e righe corretti.
6. Allarmi e rollback disponibili senza dipendenza da una chat aperta.

La copertura può essere diretta M.A.R.E. o temporaneamente delegata a un sistema già operativo, ma deve essere provata sul perimetro nuovo. Non è sufficiente dire che Channable importa normalmente gli ordini.

Non creare ordini fittizi su Amazon o dichiarare spedizioni inesistenti per provare il flusso. Test sintetici/sandbox prima; eventuale prova reale soltanto con procedura autorizzata e conforme alle regole del provider.

## 4. Ordine di lavoro per la prossima sessione

**Prima consegna: R0, chiusura dei difetti della PR #199.** Non espandere subito il numero di categorie o mercati. Sostituire il reader incompatibile con un contratto reale completo, aggiungere test che usano il collegamento effettivo, correggere ProductTypeVersion/discovery/404 e rendere sintetiche le fixture. Mantenere la capability in sola lettura.

**Seconda consegna: R1, coordinatore condiviso.** Estrarre i tipi dal documento, persistere inbox/outbox/ownership/exposure/ledger e portarli nei test del runtime Cloudflare. Non limitarsi a trascrivere il prototipo Python: testare crash, risultati incerti e risposte tardive.

**Terza consegna: R2 + R3.** Ingestione Shopify/ordini e riconciliazione; schema e preview Amazon. Questi incrementi possono procedere in parallelo solo dopo che contratti e identità sono stabili. Nessun adattatore Spartoo inventato per completare la tabella delle capability.

**Verifica profonda successiva:** dopo ledger e import ordini e prima del primo stock positivo. Verificare lo stesso disegno con due adapter e con ordini multi-riga; decidere il cutover solo su prove.

Ogni incremento termina con commit/PR, test eseguiti, limiti rimasti, checkpoint e distinzione netta fra codice presente, distribuito e verificato sul provider.

## 5. Modello eseguibile di progetto

Percorso: `docs/marketplace/models/exposure-spec.mjs`.

Esecuzione locale della revisione, Node `v22.16.0`:

```sh
node docs/marketplace/models/exposure-spec.mjs
```

Risultato: 12 scenari deterministici passati e 2.646 transizioni di proposta enumerate su budget sintetici. Nessuna API provider chiamata, nessun test di produzione. SHA-256 del file eseguito: `429a8e9edbc4ade77865774891a7b84ea90fa66121bacfc9ac16d1caf220e274`.

Il modello verifica: ultimo pezzo, riduzione non ancora confermata, riscontro convergente richiesto, aumento pendente, timeout, vecchia epoch, ricevuta duplicata, snapshot ignoto, ordini incompleti, perdita di stock esterna, evento duplicato/conflittuale e tipi quantità.

Limiti: mondo chiuso di superfici note; ricevute convergenti fornite dal test; nessuna verifica di autenticità della ricevuta, ordini/stock Shopify, reale ordinamento remoto, disponibilità provider o reservation ledger di produzione. Un booleano `converged` è solo un ingresso del modello; il servizio reale deve ottenere prove server-side. I 36 scenari di accettazione nell'architettura non sono tutti già implementati.

## 6. Cosa è stato modificato in questa revisione

Aggiunti solo documenti e modello sintetico in un branch dedicato. Nessun merge, deploy, cambio credenziali, aggiornamento stock/prezzo, ordine, tracking o modifica Channable. La PR #199 resta una proposta separata da correggere, non una release approvata.

L'obiettivo del passaggio a una modalità di sviluppo più rapida è implementare questa baseline, non riaprire ogni decisione ad ogni blocco. Nuove evidenze provider possono richiedere un ADR di modifica; le ipotesi ancora non provate non possono essere trasformate in fatti per accelerare il go-live.
