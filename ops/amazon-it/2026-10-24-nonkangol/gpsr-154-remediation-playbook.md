# Amazon IT — intervento GPSR per 154 offerte già esistenti, 24/10/2026

## Risultato accertato

- Sorgente: `getListingsItem` Amazon SP-API per ogni seller SKU della matrice [178 SKU](amazon-it-178-nonkangol.csv), più ricontrollo privacy-safe delle issue originali tramite la capability `amazon.it.existing_issue_signals.readonly` (PR #322).
- **154/154 SKU esistenti, stock Shopify positivo e stato Amazon non BUYABLE** hanno **`100632` con `GPSR_WORDING` nel messaggio live Amazon**, quattro lotti di verifica 42+42+42+28, **0 errori di lettura e 0 eccezioni**.
- [CSV evidenze SKU/ASIN](gpsr-100632-154-wording-audit.csv) (solo dati di articolo, mai testi grezzi Amazon, email, indirizzi o informazioni delle persone responsabili).
- `GPSR_WORDING` dimostra **il riferimento al GPSR nel messaggio di listing**, non dimostra quale campo sia mancante, che il produttore/RP sia verificato o che la pagina Account Health non abbia già dati registrati. Non provare ad approvare con valori inventati.
- Kangol **completamente escluso** (15 SKU sospesi fino alla fattura corretta intestata a M.A.R.E. S.R.L.).

## Coda di lavoro — 17 brand

| Brand | SKU bloccati da 100632/GPSR |
|---|---:|
| MC2 Saint Barth | 63 |
| Ecoalf | 17 |
| Grace & Mila | 17 |
| Replay | 12 |
| Sprayground | 10 |
| Flower Mountain | 7 |
| Puraai | 6 |
| Rains | 6 |
| Polo Ralph Lauren | 4 |
| Fessura | 2 |
| K-Way | 2 |
| Mou | 2 |
| Red Sox | 2 |
| Distretto 12 | 1 |
| G-Star | 1 |
| Peuterey | 1 |
| Refrigiwear | 1 |
| **Totale** | **154** |

I primi cinque brand per volume (MC2 Saint Barth, Ecoalf, Grace & Mila, Replay, Sprayground) concentrano **119/154 SKU**. Per Sprayground sono già esclusi altri **due** SKU con associazione catalogo incoerente; non inserirli nei lotti.

## Prima procedura: verifica registrazioni ufficiali (Seller Central IT)

1. Aprire **Performance → Account Health → Regulatory Compliance** e controllare, per il brand/prodotto interessato, quali dati GPSR Amazon indica effettivamente come mancanti o respinti. Acquisire lo stato approvato/rifiutato, non solo l'assenza nel `getListingsItem`.
2. Raccogliere e verificare da documenti autentici i riferimenti del fabbricante (email o indirizzo elettronico) e del Responsabile UE, **quando richiesto dalla categoria e dal ruolo legale**. Il responsabile non va impostato automaticamente su M.A.R.E. S.R.L. per altri brand.
3. Registrare i contatti di fabbricante e Responsabile UE in Seller Central e verificarne l'approvazione. **Questo deve precedere gli invii API GPSR**.
4. Verificare le istruzioni/avvertenze di sicurezza specifiche, lingua e immagini/documenti. Usare `gpsr_safety_attestation` solo quando le condizioni di esenzione risultano realmente soddisfatte; non impostare `true` come default.
5. Solo dopo evidenza approvata, predisporre JSON PTD per **l'attuale product type Amazon di ogni SKU** e provare **PATCH selettive GPSR-only** o JSON_LISTINGS_FEED parziale; mai FULL PUT, modifica inventario/prezzo/ASIN, né cambio di writer Channable. Valutare la condivisione dei dati GPSR per brand quando Amazon la permette e conserva corretta associazione a SKU/ASIN.
6. Monitorare risposta sincrona, elaborazione asincrona, `getListingsItem` issue codes e soprattutto lo stato **BUYABLE** per ogni variante. Rimuovere separatamente eventuali `8541` catalogo e `19038` prezzo, che potrebbero permanere anche dopo GPSR.

**Importante:** dal campione precedente di 15 SKU non-Kangol, `dsa_responsible_party_address` risultava non osservato nel listing; non va equiparato a 'mancante in Account Health'.

## Code separate non risolvibili con la sola GPSR

- **15** SKU con `APPROVAL_REQUIRED` ufficiale: [collegamenti Seller Central](seller-central-approvals-15.md); possono avere anche altri errori.
- **7** SKU con anomalie tecniche prezzo/media/identità e senza codice qualifica esaminato (5 pochette MC2, 1 costume MC2, 1 Devid Label).
- **2** Sprayground in quarantena per mancata coerenza catalogo prodotto: `SPR_SP15052` (Amazon portascopino WC Hemio anziché berretto) e `SPR_910CL290NSZ` (Amazon apparel SHABBAT anziché valigia).
- **8** SKU con prezzo max Amazon `19038` rilevato sull'intera matrice; uno (`MC2_CHARF01_01797I`) appartiene anche alla coorte GPSR. Amazon offer price segue il fattore 1,08 del prezzo compare-at Shopify; per `MC2_MRL0013_08627L_L` il compare-at è €49 anziché prezzo vendita €34,30.

## Stato operativo e vincoli

**0 offerte nuovamente BUYABLE confermate**. Questo dossier è un audit e un percorso operativo **read-only**: nessuna richiesta approvativa/ticket Seller Support, PATCH o media GPSR sono stati inviati. Nessuna immagine Shopify, stock, prezzo, ordine, tracking, frontend o Channable writer sono stati modificati.

Fonti Amazon:
- [Supporto GPSR via Listings Items API e JSON Listings Feeds](https://developer-docs.amazon.com/sp-api/changelog/developers-can-use-attributes-in-their-programmatic-listings-submissions-to-comply-with-gpsr)
- [Legacy Feeds GPSR e prerequisiti contatti Seller Central](https://developer-docs.amazon.com/sp-api/changelog/correction-legacy-feeds-api-can-now-support-gpsr-attributes)
- [Issue troubleshooting Listings Items](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/listings-items-api-issues-troubleshooting)

Tracciamento operativo aperto: [issue #320](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/320).
