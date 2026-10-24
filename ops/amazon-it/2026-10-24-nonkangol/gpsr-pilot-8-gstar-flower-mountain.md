# Amazon IT — primo pilot GPSR per 8 offerte esistenti (G-Star e Flower Mountain)

**Data di verifica live:** 24/10/2026. **Merchant:** M.A.R.E. S.R.L. / Devid Label. **Sicurezza:** Kangol escluso, nessuna modifica a stock/prezzi/Channable/Shopify; zero nuovi ASIN. Tutti gli 8 SKU qui sotto hanno stock positivo Shopify e Amazon e sono **NON BUYABLE**, con issue Amazon `100632` e nessun altro ERROR.

## Situazione per SKU

| Brand | Seller SKU | ASIN Amazon IT | PTD attuale | Produttore nella proiezione seller listing | Responsabile UE nella proiezione seller listing |
|---|---|---|---|---|---|
| G-Star | `GST_D26999-D776_H465_34` | `B0FSBKRWY8` | `PANTS` | NOT_OBSERVED | NOT_OBSERVED |
| Flower Mountain | `FWM_2018888-02-0D02_37_EU` | `B0HKB18RKR` | `SHOES` | PRESENT | NOT_OBSERVED |
| Flower Mountain | `FWM_2019510-05-1L11_40_EU` | `B0GNJTYB9R` | `SHOES` | NOT_OBSERVED | NOT_OBSERVED |
| Flower Mountain | `FWM_2019510-05-1M11_41_EU` | `B0GTZGPLG1` | `SHOES` | NOT_OBSERVED | NOT_OBSERVED |
| Flower Mountain | `FWM_2020101-70-4D53_37_EU` | `B0H2F86RGT` | `SHOES` | PRESENT | NOT_OBSERVED |
| Flower Mountain | `FWM_2020101-70-4D53_38_EU` | `B0H2FBXMYL` | `SHOES` | PRESENT | NOT_OBSERVED |
| Flower Mountain | `FWM_2020101-70-4D53_39_EU` | `B0H2FGYXHZ` | `SHOES` | PRESENT | NOT_OBSERVED |
| Flower Mountain | `FWM_2020101-70-4D53_40_EU` | `B0H2FC5J5B` | `SHOES` | PRESENT | NOT_OBSERVED |

**Dati mancanti nel listing ≠ mancanti o respinti in Amazon Account Health.** La registrazione ufficiale dei contatti non è stata letta dalle API. Nessun contatto è stato scritto in Amazon, e l'evidenza di marca/impresa non dimostra automaticamente la qualifica di responsabile UE.

## Dove sono i riferimenti aziendali già raccolti

- [AMAZON_RECOVERY_2026-09-25 — Compliance Master](https://docs.google.com/spreadsheets/d/1qBSG5DjD57ClDcnLTpboCRhxrD5hB86pOA4sRWVhzaM/edit): G-Star e Flower Mountain/FALC sono marcati ad alta confidenza nel dossier storico. **Riferimento di lavoro**, non prova che Amazon abbia approvato i contatti o che FALC sia la persona responsabile per ogni prodotto. Non ricopiare indirizzi/email in repository pubblici.
- [Fonte ufficiale G-Star con etichetta Manufacturer (GPSR)](https://www.g-star.com/en_it/shop/men/jackets_and_blazers/d29117-e360-001): verificare il contatto e l'applicabilità all'articolo concreto prima della registrazione.
- Flower Mountain: usare etichetta fisica, documentazione brand/FALC e conferma del soggetto legalmente rilevante; per due SKUs il manufacturer non è osservato nel seller listing, per cinque è osservato.

## Procedura esecutiva in Seller Central — una famiglia per volta

1. Entrare in [Account Health → Regulatory Compliance](https://sellercentral-europe.amazon.com/performance/account/health/product-policies?t=regulatory-compliance) dell'account **M.A.R.E. S.R.L.** e cercare gli ASIN sopra; registrare **lo stato reale** di produttore, eventuale operatore/responsabile UE e avvertenze.
2. Per G-Star e Flower Mountain, confrontare il contatto del fabbricante con la documentazione autentica brand e con le informazioni già registrate su Amazon. Registrare soltanto contatti corretti; una società con sede UE non va trasformata automaticamente in un responsabile UE nominato.
3. Verificare avvertenze, istruzioni di sicurezza, materiale allegato o esenzione applicabile al prodotto. Non selezionare automaticamente `gpsr_safety_attestation=true`.
4. Solo dopo che Amazon mostri le registrazioni pertinenti validate, procedere con l'associazione all'ASIN ed eventuale **PATCH selettiva su attributi GPSR** secondo lo schema PTD corrente `SHOES` o `PANTS`. La funzione di scrittura GPSR **non è attualmente implementata** nel M.A.R.E. Business OS: non inviare un FULL PUT o modificare price/quantity per aggirare il blocco.
5. Controllare il risultato immediato e successivamente `getListingsItem`: rimozione `100632`, status `BUYABLE` (o eventuali ERROR nuovi), invariati ASIN, prezzi, stock e writer Channable.

## Criterio di chiusura del pilot

Tutti gli 8 SKU con `100632` risolto e `BUYABLE` confermato live; altrimenti l'intervento resta APERTO. **Alla data di questo audit, 0/8 BUYABLE**.

Piani più ampi:
- [Matrice GPSR-only 101 SKU](gpsr-only-101-activation-queue.csv).
- [Matrice 154 SKU e product type](gpsr-154-ptd-blocker-matrix.csv).
- [Issue globale Amazon IT #320](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/320).

Non si deve confondere l'accettazione tecnica di una chiamata SP-API con la reale approvazione GPSR o l'abilitazione dell'offerta.
