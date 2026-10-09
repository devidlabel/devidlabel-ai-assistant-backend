# Controlli live del 9 ottobre 2026

La prima scansione shadow Shopify ha letto 3994 prodotti e 10250 varianti in 711 secondi: healthy=true, stock_fresh=true, related_data_complete=true, failures=0. La seconda scansione è partita 1800 secondi dopo la prima, con avanzamento già osservato. La lettura principale del catalogo è completa secondo i flag del reader; GPSR resta escluso e non è ancora verificato un secondo completamento o il rispetto continuativo della frequenza oraria. Channable mantiene le scritture; nessun ordine esistente è stato modificato.

## YouTube: causa verificata e limite della diagnosi

Il rinnovo del token Google restituisce invalid_grant HTTP 400. Tutte e cinque le sezioni del report falliscono e il backend risponde 502. Il campo authorized preesistente indica presenza di un refresh token in KV, non validità verificata del token. Il codice originale conservava la descrizione generica Bad Request e perdeva il codice OAuth; PR #158 preserva soltanto codici sicuri allowlisted e HTTP status, senza esporre descrizioni o segreti. Test runtime e CI passati; nuova versione Cloudflare 2a3884f8-d0fd-46cd-90fe-ede67ab7cb5e pubblicata, con letture ordini e discovery riuscite. Il gate finale resta fallito perché l'autorizzazione YouTube non è ancora ripristinata; non è stato aggirato.

invalid_grant conferma il rifiuto del refresh token: il solo codice non distingue scadenza, revoca o token associato a un client diverso. Nessuna credenziale è stata cambiata. Il proprietario deve autorizzare nuovamente l'account Google corretto usando il client esistente. Prima verificare lo stato dell'app OAuth: Google documenta una durata di sette giorni per refresh token di app External in Testing con questi scope. Non è stato verificato che questa app sia in Testing. Non cambiare lo stato di pubblicazione o il progetto sulla base di questa ipotesi. Dopo l'autorizzazione ripetere le letture canale/report e la diagnosi.

La diagnosi sicura viene ora eseguita anche dopo i deploy main, inclusi quelli con gate finale fallito. Evidenza aggiornata: ops/diagnostics/youtube-latest.json. Risultati del catalogo e ricevuta: ops/marketplace/verification-2026-10-09.json.

## Prossimo blocco Amazon

MARE Business OS continua a dichiarare amazon_sp_api configured=false. Il prossimo test autenticato richiede l'app privata SP-API autorizzata dal proprietario e i valori LWA inseriti direttamente nei Secrets Cloudflare. I dettagli e i nomi esatti sono in amazon-access-setup.md. Non revocare Channable o riutilizzarne l'app. Nessuna offerta Amazon sarà pubblicata con questa sola configurazione.

Fonti verificate:
- https://developers.google.com/identity/protocols/oauth2#expiration
- https://developer-docs.amazon.com/sp-api/docs/self-authorization
