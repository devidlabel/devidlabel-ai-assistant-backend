# Amazon ES — audit massivo 100632, 22 ottobre 2026

Read-only SP-API: nessuna richiesta Seller Central inviata, nessun prezzo/quantita/SKU modificato, nessuna modifica a Shopify o Channable. Worker OFFER_ONLY non abilitato.

## Coorte ES: 72 offerte gia presenti con 100632

I dossier di provenienza sono GitHub #256 Puraai (45 SKU), #257 4B12 (13), #258 Flower Mountain (13), #259 Fessura (1). Le 107 unita FBM sono quelle dello snapshot del 20 ottobre, non del readback completo odierno. Sono stati interrogati il 22 ottobre tutti e 72 gli SKU tramite Amazon Listings Restrictions e tutte le 72 EAN attraverso Catalog Items ES exact match.

| Brand | Offerte 100632 nei dossier | EAN exact-one sullo stesso ASIN ES | 0 restrictions (NON approvazione) | Altri esiti |
| --- | ---: | ---: | ---: | --- |
| Puraai | 45 | 44 | 44 | 1 ASIN_NOT_FOUND |
| 4B12 | 13 | 13 | 13 | 0 |
| Flower Mountain | 13 | 13 | 13 | 0 |
| Fessura | 1 | 1 | 0 | 1 APPROVAL_REQUIRED con link |
| **Totale** | **72** | **71** | **70** | **2** |

I ricontrolli appendice C delle issue #256/#257 hanno colonne SKU, EAN, STATUS, ASIN, ERRORE: per EAN-match usare quarta colonna ASIN, non la terza che contiene PRESENT_100632.

In aggiunta abbiamo rilevato dal vivo 11 offerte ES con seller SKU PRESENT, ASIN verificato, FBM >0, stato DISCOVERABLE senza BUYABLE e issue 100632. Quattro SKU identici, uno per ciascun brand, risultano BUYABLE in Amazon IT con lo stesso ASIN. Questa differenza suggerisce un problema specifico del mercato ES, ma non ne prova la causa. Ulteriori due SKU tecnici ES hanno errori 13013 o 8058+13013 e non fanno parte dei 72.

## Priorita 1: Fessura, procedura ufficiale disponibile

SKU FSA_TRAIL_SBL_07_BLACK-LAND_37_EU, EAN 8050000086452, ASIN B0FGQJWZDN.
GET Seller Listing ES: PRESENT, qty FBM 1, NOT BUYABLE, 100632 + 18299; IT: BUYABLE. Catalog ASIN ES presente, brand FESSURA, tipo SHOES; EAN exact match. Listings Restrictions ES: APPROVAL_REQUIRED, link ricevuto da Amazon:
https://sellercentral.amazon.es/hz/approvalrequest/restrictions/approve?asin=B0FGQJWZDN

Aprire con account seller corretto, leggere la documentazione richiesta, allegare gli originali ed eventualmente inviare la domanda personalmente in Seller Central. Non ancora inviata, nessun ID pratica. Dopo eventuale approvazione rileggere BUYABLE e affrontare separatamente errore 18299.

## Priorita 2: Puraai, identita ASIN incoerente ES vs IT

SKU PUI_101_101_VINTAGE_BAILEYS_41_EU, EAN 8056631940620, ASIN B0HMPHWHXG.
GET Seller Listing ES: PRESENT, FBM 1, NOT BUYABLE, errori 100632 e 18146. Catalog Items ES lookup ASIN: ASIN_NOT_FOUND. Catalog Items ES EAN exact lookup: NO_EXACT_MATCH. Restrictions ES: ASIN_NOT_FOUND, nessun link. Catalog Items IT dello stesso ASIN: READ_ONLY_DETAILS_COMPLETE, brand PURAAI.

Richiedere Seller Support ES riconciliazione della pagina Catalog Items per questo ASIN, non presentare il caso come sola richiesta di brand approval e non creare un secondo ASIN o modificare EAN/SKU.

## Priorita 3: 70 offerte con catalogo coerente e nessun link

- Puraai 44 offerte, dossier #256.
- 4B12 13 offerte, dossier #257.
- Flower Mountain 13 offerte, dossier #258.

Le 70 EAN hanno un esatto abbinamento all'ASIN nel marketplace ES ma Listings Restrictions restituisce NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF, zero application link. L'errore 100632 persiste: chiedere causa ufficiale a Seller Support per account, brand, marketplace e ASIN. Non supporre da zero restrictions che siano approvate e non rifare PUT delle offerte che gia esistono.

Esempi controllati IT BUYABLE vs ES 100632:
- Puraai PUI_101_101_VINTAGE_OSSO_40_EU, B0HMPBFHN8.
- 4B12 4B12_PLAYNEW_D2031_38_EU, B0HFDTFFSN.
- Flower Mountain FWM_2019510-05-1L11_37_EU, B0GNJ3BVRR.
- Fessura FSA_TRAIL_SBL_07_BLACK-LAND_37_EU, B0FGQJWZDN.

## Testo per Seller Support ES — non inviato

Asunto: Amazon.es — ofertas existentes no comprables con error 100632; causa y requisitos exactos para el vendedor

Somos M.A.R.E. S.R.L., vendedor europeo. Tenemos ofertas existentes en Amazon ES con SKU, ASIN y EAN verificados, stock FBM positivo, estado DISCOVERABLE pero no BUYABLE por el error 100632 (QUALIFICATION_REQUIRED). Los mismos SKU/ASIN en Italia son BUYABLE en la muestra revisada. Para los ASIN de este grupo, getListingsRestrictions no devuelve restricciones ni enlaces de autorización; entendemos que eso NO demuestra aprobación. Solicitamos comprobar el motivo específico para nuestra cuenta, marca, ASIN y Amazon ES e indicar si se requiere brand approval, autorización por ASIN/categoría, GPSR/cumplimiento o corrección de otro dato; indiquen la ruta oficial y los documentos necesarios. Podemos entregar facturas originales y documentación mediante Seller Central. No queremos modificar EAN/SKU ni duplicar fichas. Listado completo de SKU/EAN/ASIN disponible en los expedientes por marca.

Per Baileys 41 sostituire l'oggetto con: ASIN B0HMPHWHXG presente en Seller Listings ES pero ASIN_NOT_FOUND en Catalog Items ES; disponible en IT. Error 18146 + 100632.

## Automazione read-only nel branch PR #263

Aggiunto modulo src/marketplace-amazon-100632-triage.ts e test scripts/test-amazon-100632-triage.mjs, senza endpoint pubblico né chiamate provider live. Separa:
- SELLER_CENTRAL_APPROVAL_REQUEST_AVAILABLE soltanto se Amazon restituisce APPROVAL_REQUIRED e URL ufficiale esatto per marketplace/ASIN.
- CATALOG_IDENTITY_ESCALATION se ASIN non esiste o EAN non corrisponde.
- SELLER_SUPPORT_QUALIFICATION_NO_APPLICATION_LINK se catalogo allineato e restrictions vuote.
- RECHECK_REQUIRED, SELLER_LISTING_TECHNICAL_DIAGNOSTICS e ALREADY_BUYABLE per gli altri esiti.

Ogni output include brand_approved=false, can_publish=false, live_mutations=0. Il modulo non dimostra una reale autorizzazione, non allega fatture e non invia pratiche Amazon. Next: pratiche Seller Central ufficiali per caso, Case ID, poi readback BUYABLE; nessun handoff Channable prima delle prove.
