# Amazon IT — schemi GPSR verificati in produzione su 21 Product Type

**Data osservazioni:** 24 ottobre 2026. **Capacità live:** `amazon.it.existing_gpsr_ptd.readonly`, merge [PR #326](https://github.com/devidlabel/devidlabel-ai-assistant-backend/pull/326), CI + deploy di produzione verificati. Tutte le chiamate sono SP-API GET, `LISTING`, `requirementsEnforced=NOT_ENFORCED`, sul PTD **effettivo del listing esistente**, SKU e ASIN verificati, solo offerte IT non BUYABLE con `100632`.

## Risultato 21/21

Per un SKU rappresentativo di **ciascuno** dei seguenti 21 PTD Amazon IT, la risposta PTD `LATEST` ha restituito `GPSR_PTD_SCHEMA_INSPECTED` e confermato i **quattro attributi disponibili**: `gpsr_manufacturer_reference`, `dsa_responsible_party_address`, `gpsr_safety_attestation`, `compliance_media`.

- `SHIRT`
- `APPAREL`
- `SWEATER`
- `CHARM`
- `DRESS`
- `HANDBAG`
- `HAT`
- `SWEATSHIRT`
- `SWIMWEAR`
- `BOOT`
- `SLIPPER`
- `ACCESSORY`
- `BACKPACK`
- `COSMETIC_CASE`
- `TOTE_BAG`
- `DUFFEL_BAG`
- `SUITCASE`
- `WAIST_PACK`
- `PANTS`
- `SHOES`
- `COAT`

**0 errori di schema/identità nei 21 controlli.** In tre PTD (PANTS, SHOES, COAT) sono stati letti anche i nomi dei campi annidati:
- `gpsr_manufacturer_reference.gpsr_manufacturer_email_address`, `marketplace_id`;
- `dsa_responsible_party_address.value`, `marketplace_id`;
- `gpsr_safety_attestation.value`, `marketplace_id`;
- `compliance_media.content_type`, `content_language`, `source_location`, `marketplace_id`.

La presenza nello schema è **capabilità tecnica**, non dimostrazione che il produttore/responsabile UE sia già approvato, che tali dati siano obbligatori per ogni singolo SKU, o che un listing sia pubblicabile. La funzione non restituisce valori, enum seller-specific, email, indirizzi, signed URL o certificati, e **non invia PATCH/PUT**. Il checksum schema non viene verificato crittograficamente, quindi la funzione è una diagnostica e NON un validatore finale di compliance.

## Percorso per una prima correzione

1. Controllare in Seller Central, account **M.A.R.E. S.R.L.**, lo stato reale del produttore, responsabile UE e sicurezza su [Regulatory Compliance](https://sellercentral-europe.amazon.com/performance/account/health/product-policies?t=regulatory-compliance).
2. Associare solo dati/documenti certificati al brand/ASIN; **non** assegnare automaticamente M.A.R.E. S.R.L. come persona responsabile di prodotti altrui, né usare un'email dal sito web come prova di registrazione Amazon.
3. Predisporre **PATCH GPSR-only** contro PTD specifico e schema vigente dopo l'approvazione in Seller Central. `amazon.listings.sync` attualmente non è implementata, quindi non esiste una live mutation GPSR-only abilitata. Nessun FULL PUT che possa riscrivere quantità/prezzi oppure interferire con Channable.
4. Controllare rimozione di `100632`, eventuali altri errori e **BUYABLE** per marketplace. Quadro SKU: [101 GPSR-only](gpsr-only-101-activation-queue.csv); [53 con errori secondari](gpsr-154-ptd-blocker-matrix.csv).

## Sviluppo parallelo Amazon Europa

Un audit read-only separato dei **101 SKU GPSR-only** con `amazon.inventory.eu.shadow.readonly` ha osservato in momenti successivi **IT 0, DE 24, FR 20, ES 12** istanze BUYABLE (56 istanze, 28 SKU distinti osservati con almeno un mercato BUYABLE). Non sono **nuove attivazioni nostre** né unità distinte. Gli SKU già BUYABLE in un mercato possono essere bloccati in un altro; non generalizzare la causa IT a tutte le nazioni.

**Dinamismo stock:** `PUI_101_101_VINTAGE_ECLIPSE_43_EU` era inizialmente BUYABLE in DE/FR durante l'audit, poi Shopify disponibile è passato a **0** e nel successivo controllo tutti IT/DE/FR/ES erano **0** e non BUYABLE; il shared-stock guard ha confermato quantità allineate ma nessuna prova di writer ownership. Non usare la tabella dei conteggi di stato come conferma corrente delle offerte o per moltiplicare lo stock fisico. Channable resta writer unico.

**Kangol 15 esclusi**; **Sprayground 2 falsi abbinamenti** esclusi. Nessuna mutazione Amazon, prezzi, stock, ordini o frontend Shopify in questa attività. [Issue di riattivazione #320](https://github.com/devidlabel/devidlabel-ai-assistant-backend/issues/320) aperta sino a conferma effettiva.
