# Amazon IT — Recupero 178 SKU non-Kangol, 24 ottobre 2026

## Fonte dei dati

- Report Seller Central `GET_MERCHANT_LISTINGS_INACTIVE_DATA` #`250479020750` del 24/10/2026.
- Join esatto seller SKU contro Shopify Admin GraphQL: prodotto `ACTIVE`, inventory_quantity >0.
- Ri-verifica Amazon SP-API `getListingsItem` IT per **tutti i 178**: stesso ASIN del report, seller status, quantità FBM e codici di gravità ERROR.
- **Kangol escluso integralmente**: 15 SKU congelati fino alla fattura corretta intestata a M.A.R.E. S.R.L.
- Questo è un'istantanea; quantità e stato devono essere riverificati prima di ogni operazione live.

## File operativo

[CSV unico dei 178 SKU](amazon-it-178-nonkangol.csv), colonne: SKU, brand, ASIN report, ASIN live, stock Shopify, FBM Amazon, EAN/UPC, status Amazon, error codes, route. I cinque file `inactive-*.csv` sono i checkpoint originali che costituiscono la matrice.

**Validazioni del CSV:** 178 righe, 178 SKU distinti, zero Kangol, 178 ASIN live identici al report, Shopify stock >0 su ogni riga; 0 `BUYABLE`, 177 FBM Amazon >0, 1 FBM Amazon=0.

| Route | SKU | Criterio operativo |
|---|---:|---|
| `APPROVAL_REQUIRED` | **15** | Amazon Listings Restrictions restituisce `APPROVAL_REQUIRED` e collegamento Seller Central. **Non prova invio/approvazione** |
| `100632_SUPPORT_GPSR_REVIEW` | **155** | Seller listing ha errore `100632`, ma nessun URL approvazione confermato nella verifica per SKU. In alcuni casi c'è anche `8541`. **Assenza link non è autorizzazione o prova GPSR** |
| `TECHNICAL_PRICE_MEDIA_REVIEW` | **7** | 6 MC2 + 1 Devid Label senza i codici di qualifica esaminati. Errori `19038`, `8541`, `100587`, `5995` in combinazioni diverse |
| `QUARANTINE_WRONG_ASIN` | **1** | `SPR_SP15052` Sprayground: associazione a catalogo Amazon sbagliato; **non pubblicare** |

## Autorizzazioni / blocchi gestionali

- **Polo Ralph Lauren 8**, **Red Sox 5**, **MC2 Saint Barth 1**, **Blundstone 1**: link ufficiali e abbinamenti SKU/ASIN documentati nella [issue #320](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/320).
- Nessuna domanda di approvazione o ticket Seller Support è stata inviata da questa sessione.
- Per la maggioranza dei 155 `100632`, la categoria esatta di disabilitazione richiede diagnostica Seller Support/Account Health; non equivale automaticamente a problema GPSR.
- Per i 53 `8541` nel totale di 193, l'errore può sovrapporsi a `100632`; non associare automaticamente l'ASIN a un catalogo di prodotto corretto soltanto perché l'EAN restituisce `EXACT_ONE`.

## Interventi tecnici prioritari, senza scrivere su Channable

1. **Devid Label `DL_PC2M4_NE`**: Shopify €49,90, Amazon €53,89, errore `19038`. Verificare price bounds Seller Central e regole prezzo Channable prima di cambiare prezzi.
2. **MC2 cinque pochette**: `MC2_ALI0008_01273L`, `MC2_ALI0047_00294L`, `MC2_ALI0047_01270L`, `MC2_ALI0051_00554L`, `MC2_ALIN001_08398L`: errori `100587` (`media_locator`), `8541`, `19038` e talvolta `5995`. Le immagini Shopify sono `READY`, ma Amazon richiede URLs pubblici persistenti corretti e schema PTD; non usare URL temporanei firmati.
3. **MC2 `MC2_MRL0013_08627L_L`**: prezzo Shopify attuale €34,30, compare-at €49,00, offerta Amazon €52,92 (49×1,08). Errore `19038` + `8541`: verificare la selezione `compare_at_price` rispetto al prezzo corrente nel writer Channable.
4. **Quarantena `SPR_SP15052`**: Shopify Sprayground Berretto Basic Nero, EAN `8028661438453`, stock=2; Amazon associa l'EAN all'ASIN `B07TXQCKKK` *Hemio portascopino WC*, product type `CLEANING_BRUSH`, seller FBM=0. NON pubblicare. Richiedere prova GTIN e correzione catalogo/identificatore.

## GPSR e protezioni

Il controllo di presenza su 15 SKU non-Kangol non vede il responsabile UE nella proiezione del seller listing, ma **ciò non dimostra assenza in Account Health**. In alcuni listing il produttore risulta presente. Non inserire indirizzi, email, attestazioni o nomi di responsabili UE senza prova originale per quel brand e senza l'autorizzazione Seller Central.

Shopify è fonte del catalogo/stock; Channable resta writer operativo per offer/stock/price. Nessun nuovo ASIN, PATCH, FULL PUT, variazione prezzi/quantità, pubblicazione di dati GPSR o modifica del frontend è stata eseguita nella generazione di questa matrice.

**KPI utile:** offerte che diventano `BUYABLE` dopo azione Seller Central e ricalcolo di `getListingsItem`, non numero di file o PR.
