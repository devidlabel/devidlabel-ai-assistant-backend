# Accesso Amazon per M.A.R.E. S.R.L.

Verifica del 9 ottobre 2026: MARE Business OS espone amazon_sp_api configured=false e amazon.listings.sync implemented=false. Shopify è configurato e la prima scansione shadow Cloudflare è completa; non esiste ancora una verifica autenticata di Amazon. Nessuna credenziale va inserita in chat, file del repository o screenshot.

## Intervento del proprietario

1. Con l’utente principale di Seller Central, aprire Apps and Services → Develop Apps oppure il Solution Provider Portal. Verificare prima l’elenco delle applicazioni della società: non usare né revocare l’autorizzazione Channable.
2. Se non esiste l’applicazione privata MARE, registrare il profilo sviluppatore privato e un’applicazione SP-API per la propria organizzazione. Completare gli eventuali passaggi di verifica Amazon; non presumere che l’approvazione sia immediata.
3. Autorizzare l’applicazione privata per l’account venditore corretto. Anche un’app privata in stato draft può essere auto-autorizzata: non serve pubblicarla nello store. Questa operazione genera il refresh token.
4. Inserire i valori direttamente come Secrets del Worker Cloudflare esistente, usando esattamente i nomi già riconosciuti da MARE:

| Nome | Valore |
| --- | --- |
| AMAZON_SP_API_CLIENT_ID | Client ID Login with Amazon dell’app |
| AMAZON_SP_API_CLIENT_SECRET | Client secret Login with Amazon dell’app |
| AMAZON_SP_API_REFRESH_TOKEN | Refresh token dell’auto-autorizzazione del venditore |

Client ID, client secret e refresh token devono appartenere alla stessa applicazione/account. Non sovrascrivere valori esistenti senza verificarne prima la provenienza. Comunicare in chat soltanto che l’inserimento è stato completato. Seller ID e paesi/marketplace abilitati saranno verificati separatamente; non richiedere la password Seller Central.

## Primo controllo dopo la configurazione

Scambio LWA e GET /sellers/v1/marketplaceParticipations sull’endpoint della regione appropriata. Non richiede pubblicazione di offerte né modifiche agli ordini. Il pilota successivo confronterà EAN, ASIN, modello, colore e taglia e i requisiti paese; ogni quantità pubblicabile resterà bloccata finché GPSR, prenotazioni ordini, dati freschi e passaggio del singolo writer non saranno verificati. Il reader Python di riferimento esiste; l’adapter eseguibile Cloudflare è ancora da implementare.

Fonti ufficiali verificate il 9 ottobre 2026:
- https://developer-docs.amazon.com/sp-api/docs/register-as-a-private-developer
- https://developer-docs.amazon.com/sp-api/docs/self-authorization
- https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
