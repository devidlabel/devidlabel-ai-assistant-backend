# MARE Business OS — Architettura unificata

## Obiettivo

Creare un’unica app Workspace stabile, capace di leggere, preparare ed eseguire operazioni su tutti i sistemi aziendali senza aggiungere nuove app o ricostruire gli agenti quando viene implementata una nuova funzione.

Endpoint MCP:

`/mcp-business`

## Contratto MCP congelabile

Gli strumenti pubblici rimangono dieci:

1. `mare_system_status`
2. `mare_capabilities`
3. `mare_describe`
4. `mare_read`
5. `mare_prepare`
6. `mare_validate`
7. `mare_execute`
8. `mare_job_status`
9. `mare_job_control`
10. `mare_artifact_get`

Nuovi provider e nuove azioni vengono aggiunti come `capability_id` nel registro dinamico, non come nuovi strumenti MCP.

## Moduli interni riutilizzati

- MARE Commerce OS: reporting Shopify, Meta, Google Ads, GA4, Search Console e Klaviyo.
- MARE Operations OS: Klaviyo draft, Meta mutations, Google Ads updates e GitHub PR.
- MARE Product Media OS: lettura immagini, preview e pubblicazione controllata.
- Canonical Shopify Catalog: prodotti, varianti, prezzi, costi, inventario per sede, collezioni e media.
- Artifact Store: JSON, CSV, feed, Matrixify e future immagini/report.
- TikTok Marketing API adapter.
- Marketplace Feed Engine.

## Catalogo canonico

Shopify è la fonte primaria per:

- product ID e variant ID;
- handle, vendor, product type e tag;
- SKU, barcode, prezzo e compare-at price;
- costo unitario;
- inventario per sede;
- collezioni;
- media, URL, alt text, dimensioni e ordine;
- SEO title e description.

Ogni feed o file Matrixify deve essere generato da questo modello canonico, con mapping specifico per canale.

## Feed e sostituzione Channable

### Canali previsti

- Google Merchant Center;
- Meta Catalog;
- TikTok Catalog;
- Amazon SP-API;
- Spartoo;
- Miinto;
- altri canali tramite mapping configurabile.

### Pipeline

`Shopify canonical catalog → channel mapping → validation → artifact/version → preview/diff → API push → diagnostics → retry/dead-letter → reconciliation`

### Stato iniziale implementato

Il backend può produrre artifact strutturali per:

- Google Merchant CSV;
- Meta Catalog CSV;
- TikTok Catalog CSV;
- Amazon JSON_LISTINGS_FEED skeleton;
- Spartoo/Miinto/generic CSV;
- Matrixify catalog CSV.

Questi artifact non sono ancora equivalenti a una sincronizzazione diretta certificata. Prima della dismissione di Channable servono adapter API, mapping completi e collaudo per ogni canale.

### Criteri obbligatori prima di eliminare Channable

1. Copertura di tutti i prodotti e varianti attivi.
2. Mapping categorie completo.
3. Prezzi, sconti, stock e immagini coerenti.
4. Validazione feed senza errori critici.
5. API push o feed-hosting accettato dal canale.
6. Aggiornamenti incrementali e full refresh.
7. Retry automatici, rate-limit handling e dead-letter queue.
8. Log e diagnostica leggibili dagli agenti.
9. Confronto giornaliero Shopify ↔ destinazione.
10. Parallel run con Channable per un periodo concordato.
11. Rollback documentato.
12. Conferma del risparmio netto rispetto ai costi API, storage e modelli AI.

## Livelli di rischio

- `read_only`: esecuzione automatica.
- `artifact_only`: genera file o preview, nessuna modifica esterna.
- `reversible_write`: piano immutabile e conferma `EXECUTE MARE PLAN`.
- `live_write`: piano immutabile e conferma `EXECUTE MARE LIVE PLAN`.
- `irreversible`: non esposto nella fondazione iniziale.

## TikTok

L’app Marketing API approvata abilita la fase di autorizzazione advertiser. Il backend supporta:

- scambio dell’authorization code con long-term access token;
- storage server-side del token;
- elenco campagne;
- creazione campagne forzata in `DISABLE`;
- aggiornamenti controllati;
- cambio stato tramite endpoint dedicato e conferma separata.

La presenza dell’app approvata non equivale ancora all’autorizzazione dell’account pubblicitario: servono authorization code, advertiser ID e verifica degli scope concessi.

## Shopify

La fondazione richiede scope aggiuntivi per la gestione a 360°:

- `write_products`;
- `write_inventory`;
- `write_files`;
- `write_discounts`;
- `write_content`;
- `write_metaobjects` e `write_metaobject_definitions`;
- `write_translations`;
- `write_online_store_navigation`;
- `write_publications`.

Le modifiche al tema rimangono escluse dalle scritture Shopify dirette e passano da GitHub, pull request, test e preview.

## Provider successivi

### Google Merchant

Implementare:

- data source API dedicata;
- insert/update/delete prodotti;
- supplemental inventory;
- product status e issues;
- report e reconciliation.

### Amazon

Implementare:

- Product Type Definitions;
- Listings Items API per singoli aggiornamenti;
- JSON_LISTINGS_FEED per batch;
- submission status e processing report;
- mapping categorie/attributi.

### Spartoo e Miinto

Prima dello sviluppo servono i contratti API effettivamente disponibili sull’account, credenziali, limiti e mapping richiesti. Non dedurre endpoint o formati dai vecchi feed Channable.

## Multi-model router

Claude, Gemini e altri modelli possono essere aggiunti come capability interne per analisi, revisione o multimodal QA. Nessun modello scrive direttamente sui provider: ogni output passa da validazione, piano, conferma ed esecuzione server-side.

## Migrazione Workspace

1. Non pubblicare `MARE Business OS` finché il contratto dei dieci strumenti non supera il collaudo.
2. Configurare un token dedicato.
3. Creare una sola app Workspace.
4. Creare `MARE Control Tower V2` collegato soltanto a questa app.
5. Superare il collaudo 360°.
6. Creare gli specialisti V2 dalla stessa base.
7. Mantenere vecchie app/agenti solo come rollback temporaneo.
8. Disattivarli dopo il parallel run.
