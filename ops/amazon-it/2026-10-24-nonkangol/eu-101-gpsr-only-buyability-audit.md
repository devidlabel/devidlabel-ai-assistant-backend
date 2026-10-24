# Amazon EU — 101 IT GPSR-only offers, cross-market sellability audit

**Data:** 24 ottobre 2026. **Scope:** gli SKU della [coda dei 101 GPSR-only IT](gpsr-only-101-activation-queue.csv), basata su Seller Central IT con 100632 unico errore, prima degli aggiornamenti stock in tempo reale. **Kangol e due falsi abbinamenti Sprayground esclusi**.

## Fonte e metodo

`amazon.inventory.eu.shadow.readonly` usata per tutte **101/101 SKU**, lotti di massimo 8, per confrontare Shopify disponibile e seller listing Amazon **IT, DE, FR, ES** (identità ASIN, quantità e status `BUYABLE`). Zero offerte nuove, zero mutazioni, Channable resta writer. I dati dei singoli mercati sono una **fotografia dinamica**: il ritardo tra i lotti impedisce di considerare i primi conteggi una situazione simultanea.

### Risultati iniziali sui 101

| Mercato | BUYABLE osservati (SKU-offerta per mercato) |
|---|---:|
| IT | 0 |
| DE | 24 |
| FR | 20 |
| ES | 12 |

**56 istanze** di offerte BUYABLE in 3 mercati, su **28 SKU distinti** osservati in almeno un paese. Non sono 56 unità fisiche e non sono attivazioni eseguite in questa sessione.

### Ricontrollo mirato di tutti i 28 SKU positivi

Una successiva verifica live sugli **stessi 28/28 SKU** ha trovato:

| Mercato | BUYABLE al ricontrollo |
|---|---:|
| IT | 0 |
| DE | 23 |
| FR | 19 |
| ES | 12 |

**54 istanze** in DE/FR/ES su **27 SKU distinti** rimasti BUYABLE fuori dall'Italia. Nessun altro SKU dei 28 è diventato completamente non BUYABLE.

La variante `PUI_101_101_VINTAGE_ECLIPSE_43_EU` (Puraai), in precedenza BUYABLE in DE/FR, è scesa a **0 stock disponibile Shopify**; il ricontrollo ha trovato FBM=0 e NON BUYABLE in tutti e quattro i mercati. `amazon.inventory.eu.shared_stock_guard.readonly` conferma le quantità **riallineate a zero**, senza affermare che la sincronizzazione atomica sia garantita. Il conteggio **101 SKU con Shopify stock positivo era corretto allo snapshot originale**, ma per le operazioni live va filtrato sullo stock del momento.

## Segmenti dove esistono già offer BUYABLE in DE/FR/ES

Questi modelli sono stati osservati acquistabili su uno o più dei tre mercati esteri, a seconda della variante:
- **Flower Mountain**: 4 taglie del modello `FWM_2020101-70-4D53` BUYABLE DE; stesse offerte non BUYABLE IT/FR/ES.
- **Ecoalf**: 3 offerte BUYABLE DE/FR/ES.
- **Puraai**: taglie `40,41,42,44,45` del modello `101_101_VINTAGE_ECLIPSE` BUYABLE DE/FR (taglia 43 ora a zero).
- **Replay**: 5 offerte, alcune BUYABLE DE, altre FR/ES.
- **MC2 Saint Barth**: 7 offerte, principalmente BUYABLE DE/FR/ES; una `MC2_QUE0033_04027I_S` BUYABLE FR.
- **K-Way**: `KWAY_K8133EW_AL9_S` BUYABLE FR e assente come seller SKU in DE/ES al controllo.
- **Sprayground**: `SPR_910B8026NSZ` BUYABLE DE/FR/ES. Gli altri due Sprayground in quarantena NON sono inclusi.
- **Rains**: `RNS_RA14160_BLU` BUYABLE DE.

**Implicazione operativa:** il solo stato 100632 di Amazon Italia NON implica che la stessa offerta sia bloccata in tutti i mercati; non scrivere a tappeto su quattro mercati. Fare gestione GPSR/Account Health e patch per ogni mercato con le sue evidenze, senza modificare seller SKU, ASIN, quantità o prezzi.

## Progressi tecnici

[PR #326](https://github.com/devidlabel/devidlabel-ai-assistant-backend/pull/326) è merged e CI + deploy Cloudflare verificati. La capability live `amazon.it.existing_gpsr_ptd.readonly` è stata eseguita su un SKU rappresentativo di **tutti i 21 product type Amazon** della coorte IT con esito **21/21 `GPSR_PTD_SCHEMA_INSPECTED`**. Ciascun PTD ha restituito i quattro attributi `gpsr_manufacturer_reference`, `dsa_responsible_party_address`, `gpsr_safety_attestation`, `compliance_media`. Vedi [report schemi PTD](gpsr-21-ptd-live-schema-audit.md).

**Nessuna approvazione GPSR account verificata, nessuna patch live possibile oggi tramite Business OS** (writer listings sync non implementato), nessun cambio stock, prezzo o frontend. [Issue #320](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/320) resta aperta fino alla compravendibilità effettiva.
