# Amazon EU accessori — Nuovi ASIN MC2 e tutela Product Type (22 ottobre 2026)

M.A.R.E. S.R.L. / Devid Label. Tutte le verifiche del blocco sono **read-only**, nessun prodotto pubblicato e nessuna modifica a Shopify o Channable.

## Nuovo campione accessori MC2 Saint Barth

Quattro Shopify SKU ACTIVE con stock positivo ed EAN-13 verificati tramite Seller Listings GET e Catalog Items EAN exact lookup in ciascuno dei quattro marketplace (16 SKU×market):

| SKU / descrizione | Stock Shopify | EAN | Seller IT/DE/FR/ES | Catalog EAN IT/DE/FR/ES | Rotta |
| --- | ---: | --- | --- | --- | --- |
| `MC2_ALI0031_02715M` / Pochette Aline Denim | 1 | `8051689749201` | PRESENT, BUYABLE 4/4 | EXACT_ONE `B0HM7WDTC4` 4/4 | NON duplicare |
| `MC2_COL0018 00274H` / Borsa Colette In Lino Panna | 1 | `8057338168379` | VERIFIED_ABSENT 4/4 | NO_EXACT_MATCH 4/4 | **NEW_ASIN_RESEARCH**, NON OFFER_ONLY |
| `MC2_BOX0023_03765I` / Christmas Box Red Velvet | 5 | `8057338641070` | VERIFIED_ABSENT 4/4 | NO_EXACT_MATCH 4/4 | **NEW_ASIN_RESEARCH** con categoria da verificare |
| `MC2_ALI0002_02846I` / Pochette Aline Wool Effect | 3 | `8057338617617` | PRESENT 4/4, NOT BUYABLE 4/4, issue 100632 | EXACT_ONE `B0FTG4K3RZ` 4/4 | Seller Central qualification / support; NON duplicare |

I `NO_EXACT_MATCH` sono assenza di corrispondenza EAN nel catalogo, NON prova dell'assenza di prodotti equivalenti né autorizzazione brand. Channable rimane il writer.

## Amazon Product Type Definitions

Per `MC2_COL0018 00274H`, `amazon.listing.new_asin.requirements.readonly` ha restituito `HANDBAG` come candidato in IT/DE/FR/ES. PTD `LISTING` letto nei quattro paesi (nessuna VALIDATION_PREVIEW né pubblicazione). Lo schema IT enumera 23 campi obbligatori statici: `age_range_description`, `brand`, `bullet_point`, `capacity`, `closure`, `color`, `country_of_origin`, `department`, `inner`, `item_dimensions`, `item_name`, `item_type_name`, `manufacturer`, `model_name`, `number_of_compartments`, `number_of_pockets`, `outer`, `product_description`, `size_info`, `strap_type`, `style`, `supplier_declared_dg_hz_regulation`, `target_gender`. Questo insieme statico NON copre ogni vincolo condizionale; checksum non verificato, GPSR e brand approval non provati. Alcune informazioni necessitano di scheda fornitore.

Per `MC2_BOX0023_03765I`, Amazon itemName recommend **`ABIS_MUSIC`** (musica fisica) in IT e ES, ma Shopify product_type è `Pochette e Borselli`. Questa divergenza richiede verifica manuale della natura del Christmas Box tramite foto, componenti/packaging e documento del brand, **non** selezione automatica di ABIS_MUSIC. Non inventare una categoria alternativa senza prove.

## Fix fail-closed: tutela tassonomia accessori

Il reader `src/marketplace-amazon-new-asin-research.ts` riconosce ora raccomandazioni chiaramente estranee alle categorie Shopify accessori (musica fisica, speaker, bevande e giochi da tavolo, e APPAREL per bagagli). Se sono le sole raccomandazioni, risponde `PRODUCT_TYPE_CATEGORY_REVIEW_REQUIRED` senza un tipo selezionabile, senza leggere automaticamente uno schema irrilevante e senza abilitare creazione schede. Con raccomandazioni miste, mostra soltanto i candidati non palesemente incongruenti e registra quelli scartati per revisione. Shopify category è una prova di confronto, NON una categoria Amazon automaticamente approvata. Nessuna mutazione o source write.

Dopo test/deploy usare `amazon.listing.new_asin.requirements.readonly` per ricontrollare Christmas Box IT/ES e Borsa Colette IT/ES: il risultato deve riprodurre il conflitto rilevato senza suggerire musica come categoria da usare. Il blocco non deve precludere oggetti realmente musicali se catalogati in Shopify come musica (test negativo).

## Priorità

1. **Borsa Colette (1 unità in magazzino):** scheda tecnica e foto del fornitore, autorizzazione brand, GPSR, mappatura 23 campi + condizionali `HANDBAG` paese per paese, poi test valido non-live.
2. **Christmas Box Red Velvet (5 unità):** accertare se l'articolo è pochette, gift set o altra categoria; ottenere distinta contenuti, dimensioni e dati ufficiali, quindi richiedere una categoria Amazon coerente. Nessun catalogo musicale per default.
3. **Pochette Aline Wool Effect (3 unità):** offerta Seller già PRESENT 4/4 con 100632, usare `amazon.existing_offers.qualification_triage.readonly` e Seller Central; non ricreare l'offerta.
4. **Pochette Aline Denim (1 unità):** già BUYABLE 4/4, nessuna operazione.
