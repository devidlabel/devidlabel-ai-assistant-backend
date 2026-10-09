# Verifica live shadow — 9 ottobre 2026

PR #155 unita: 84e3b384a2cd9ffa7c45961cc487a72fdb9b083d. Worker pubblicato alle 16:42 UTC, versione dba7f976-fbf2-4518-9480-d94c6754517d. Workers Paid confermato dalla schermata del proprietario; il permesso Billing Read del token resta assente.

Il cron ha avviato la scansione senza intervento manuale. Due letture autentiche di marketplace.shadow.status mostrano avanzamento da 16 pagine / 320 prodotti / 1177 varianti a 22 pagine / 440 prodotti / 1566 varianti. Nessun errore registrato, enabled=true. Le osservazioni e la ricevuta sono in ops/marketplace/activation-verification.json. Il servizio usa cron e allarmi persistenti Cloudflare e prosegue quando la chat viene chiusa.

La prima scansione completa non era ancora terminata al controllo: healthy=false e stock_fresh=false sono coerenti. Non è ancora verificato il rispetto della frequenza oraria; misurare almeno due scansioni complete e recupero live. ready_for_marketplace_writes=false; Channable conserva tutte le scritture marketplace. Non sono stati modificati ordini esistenti, offerte o tracking.

Tutti i controlli della PR sono passati. Il deploy live e i controlli discovery MARE, lettura ordini e visibilità storica sono riusciti. Il gate finale della pipeline risulta fallito esclusivamente per il controllo YouTube read-only HTTP 502, già osservato nel rilascio precedente; nessun rollback automatico è avvenuto.

Restano da completare: accesso Amazon SP-API e verifica reale del pilota, contratto Spartoo, GPSR, completezza dati correlati, ledger prenotazioni ordini su Cloudflare, tracking/corrieri, monitor e allarmi indipendenti. La lettura autonoma non equivale alla disponibilità dell'integrazione marketplace completa.
