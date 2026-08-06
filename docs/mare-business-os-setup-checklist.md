# MARE Business OS — Setup una tantum

## Cloudflare

Creare o verificare, senza condividere i valori in chat:

- `MARE_BUSINESS_ACCESS_TOKEN`
- `TIKTOK_APP_ID`
- `TIKTOK_APP_SECRET`
- `TIKTOK_ADVERTISER_ID`
- facoltativo `TIKTOK_ACCESS_TOKEN` quando viene inserito direttamente come long-term Marketing API token
- facoltativo `TIKTOK_AUTHORIZATION_URL` quando si usa il flusso autorizzativo web
- `KLAVIYO_OPERATIONS_API_KEY`
- `GITHUB_OPERATIONS_TOKEN`
- `GITHUB_OPERATIONS_REPOSITORIES`
- future credenziali Merchant Center, Amazon, Spartoo e Miinto

## Shopify

Dopo il deploy, riautorizzare l’app tramite `/install` per concedere gli scope aggiuntivi richiesti dal sistema unificato.

Non è richiesto `write_themes`: le modifiche frontend passano da GitHub, pull request, test e preview.

## TikTok

1. Impostare nel portale TikTok il redirect:
   `https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/tiktok/callback`
2. Generare l’Advertiser authorization URL.
3. Configurare app ID e secret in Cloudflare.
4. Autorizzare l’advertiser oppure salvare direttamente il long-term access token in Cloudflare.
5. Verificare `tiktok.authorization.status`.
6. Eseguire prima una lettura campagne.
7. Eseguire come primo write soltanto una campagna in `DISABLE`.

## Workspace

Non creare l’app finché PR, deploy e collaudo del contratto non sono completi.

Configurazione finale:

- Nome: `MARE Business OS`
- Endpoint: `https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/mcp-business`
- Autenticazione: bearer token dedicato
- Agente pilota: `MARE Control Tower V2`
- Visibilità: privata durante il collaudo

## Criterio di uscita

Le vecchie app e i vecchi agenti vengono rimossi soltanto dopo il parallel run e dopo avere superato i test su catalogo, artifact, immagini, Shopify write, Meta, Google Ads, TikTok, Klaviyo, GitHub e feed marketplace.
