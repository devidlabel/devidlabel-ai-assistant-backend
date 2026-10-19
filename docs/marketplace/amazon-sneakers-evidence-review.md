# Amazon EU Sneakers — evidenze PTD SHOES per nuove schede (read-only)

Ultimo checkpoint: [issue #233](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/233).

## Scopo e vincoli

- Shopify e la fonte canonica per catalogo e stock; Channable conserva gestione live di offerte, prezzi, quantita, ordini e tracking.
- Valido solo per prodotti `Sneakers` Shopify ACTIVE, stock positivo, EAN valido e univoco e SKU assente come offerta seller nel mercato; un `NO_EXACT_MATCH` EAN **non** prova l'assenza assoluta di ASIN.
- Nessun dato di scheda o autorizzazione va dedotto da un titolo o da testo marketing.
- La classificazione `TRANSFORM_REVIEW` significa solo **pista da verificare**: non rappresenta un campo Amazon valido e non consente `VALIDATION_PREVIEW`.
- Tutti i gate restano chiusi fino a conferma dell'identita prodotto, completamento requisiti condizionali, documentazione GPSR, autorizzazione brand e test isolati. Non generare feed, listing PUT o pubblicazioni da questo rapporto.

## Evidenze gia osservabili (campioni, non catalogo intero)

| Brand | Fonte Shopify da verificare | Limite attuale |
| --- | --- | --- |
| Back70 | Tag `model`, `color`, `gender`, `style`; opzione taglia e descrizione | Specifiche tecniche e documenti produttore non attestati |
| Pro-Keds | Descrizione con etichette `Modello`, `Codice modello`, `Genere`, `Colore`, `Tomaia`, `Suola` | Valori da controllare con scheda produttore, incluse codifiche Amazon |
| Fessura | Descrizione con dicitura esplicita `Tomaia in ...` e opzione taglia | Non confondere battistrada/intersuola con composizione completa suola |

## Richieste di evidenza tecniche per ogni brand/modello

| Dato richiesto | Evidenza affidabile attesa | PTD Amazon / gate |
| --- | --- | --- |
| Marchio, modello, codice modello e colorway per SKU | Catalogo produttore, fattura/listino con mapping SKU-EAN | `brand`, `model_name`, `model_number`, `color`, identita prodotto |
| Scheda taglie per modello (EU, genere, fascia eta) | Size chart ufficiale e specifica del modello | `footwear_size`, `target_gender`, `age_range_description` |
| Paese di origine e identita legale fabbricante | Dichiarazione/scheda ufficiale produttore | `country_of_origin`, `manufacturer`; non usare distributore come produttore |
| Materiali tomaia e fodera | Scheda materiali/composizione del fabbricante | `outer`, `inner`, `leather_type`, attributi condizionali |
| Suola, costruzione, chiusura, altezza gambale | Specifiche tecniche del modello | `sole_material`, `closure`, `shaft`, `height_map`, `strap_type` se applicabile |
| Resistenza acqua e uso previsto | Certificazioni/specifiche, anche dichiarazioni di non applicabilita verificate | `water_resistance_level`, `lifestyle`, `style` |
| Descrizione e caratteristiche principali | Testo tecnico approvato e verificabile | `item_name`, `product_description`, `bullet_point` |
| Obblighi GPSR per mercato | Dati ufficiali produttore/responsabile UE, avvertenze, contatti/documenti necessari | `gpsr_manufacturer_reference`, `gpsr_safety_attestation`, `dsa_responsible_party_address` quando richiesti |
| Titolarita/permesso di vendita del brand/ASIN | Verifica Seller Central per paese e caso, documenti richiesti da Amazon | Nessun automatismo da `seller listing absent` o `PTD SHOES` |
| Requisiti condizionali PTD attivi | Validazione completa delle regole PTD specifiche per paese/versione | `allOf`, `if/then/else`, `oneOf`, `$ref` e vincoli di enum/valore |

## Sequenza operativa suggerita

1. Per un SKU campione/mercato, usare `amazon.sneakers.sku_state.readonly`: distinguere offerta esistente, candidato ASIN, stato inconcludente.
2. Solo per seller-SKU verificato assente e EAN senza corrispondenza esatta, richiedere `amazon.listing.new_asin.requirements.readonly` con scelta Amazon `SHOES`.
3. Leggere `attribute_gap_report`, verificare *manualmente* ogni `TRANSFORM_REVIEW`, recuperare dal produttore ogni `MISSING`; trattare condizioni come irrisolte.
4. Caricare la documentazione prodotto/conformita in un archivio aziendale accessibile al responsabile approvazione, **non** nel repository pubblico.
5. Solo dopo prova documentale e requisiti Amazon completi progettare in PR separata un eventuale `VALIDATION_PREVIEW`. Il semplice ritorno di `REQUIREMENTS_REVIEW_REQUIRED` non e autorizzazione.
6. L'eventuale passaggio di proprieta writer da Channable richiede percorso indipendente, SKU/mercato isolato e autorizzazione esplicita.

**Nota:** presenza di un attributo in Shopify, anche sotto etichetta tecnica, non equivale a un'informazione verificata dal produttore.
