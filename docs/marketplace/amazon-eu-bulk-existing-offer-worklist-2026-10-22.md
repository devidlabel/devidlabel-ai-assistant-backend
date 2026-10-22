# Amazon EU — Worklist massivo 100632, sola lettura

## Nuova capability
`amazon.existing_offers.bulk_case_worklist.readonly` prende **1–9** SKU/EAN con checksum valido, un marketplace (IT, DE, FR, ES) e un eventuale secondo marketplace di confronto. Esempio:

```json
{"marketplace":"FR","items":[
 {"sku":"RNS_15600_COAL","ean":"5715793005679"},
 {"sku":"RNS_14160_COAL","ean":"5715793003613"},
 {"sku":"RNS_15580_COAL","ean":"5715793016255"}
]}
```

Esegue il reader già distribuito `amazon.existing_offers.qualification_triage.readonly` in gruppi sequenziali di **massimo 3**. Ogni gruppo incrocia Listings GET, EAN Catalog Items, ASIN Catalog Items e Listings Restrictions. Nessun PUT, PATCH, POST, seller case, approval, inventory/price update o spostamento della titolarità Channable. Le richieste più grandi e input non validi vengono rifiutati, ogni evidenza parziale o incoerente produce esito fail-closed (nessuna lista operativa da interpretare come confermata).

L'output unisce `counts`, `results` e `worklist` per rotta:
- `EXISTING_OFFER_BUYABLE` → evitare duplicati.
- `SELLER_SUPPORT_100632_NO_APPLICATION_LINK` → aprire pratica Seller Support con SKU/EAN/ASIN verificati.
- `SELLER_CENTRAL_APPROVAL_LINK` → inserire fatture/documenti in Seller Central e inviare personalmente la richiesta.
- `CATALOG_IDENTITY_ESCALATION` → EAN/ASIN incoerenti, distinguere da approval.
- `SELLER_IDENTITY_DIAGNOSTICS` → identità seller sconosciuta, non presumere stato commerciale.
- `NOT_100632_COHORT` → affrontare i codici differenti.
- `RECHECK_REQUIRED` → prova incompleta, nessun tentativo di pubblicazione.

`brand_approval_proven=false`, `can_publish=false`, `provider_mutations=0`, `seller_support_cases_created=0` anche quando si trova un link ufficiale. Non costruisce documenti sensibili e non restituisce dati di clienti/ordini.

## Nuova coorte Rains 22 ottobre 2026 (vedere GitHub #273)

Audit reale `amazon.seller.listings.direct` e `amazon.catalog.exact.match`: **12 SKU × IT/DE/FR/ES = 48** controlli, EAN exact-one **48/48**; seller BUYABLE **22**, seller PRESENT ma non BUYABLE e issue 100632 **23**, seller identity UNKNOWN **3**. La nuova verifica `amazon.existing_offers.qualification_triage.readonly` ha classificato **23** posizioni come `SELLER_SUPPORT_100632_NO_APPLICATION_LINK`, **5** come già BUYABLE su 28 controlli mirati; nessuna approval applicabile è stata dedotta da Restrictions 0.

SKU già esistenti da sottoporre a Seller Support per uno o più paesi: RNS_15600_COAL, RNS_14160_COAL, RNS_15580_COAL, RNS_12870_BEIGE, RNS_RA14160_BLU, RNS_13000_DFT, RNS_14920_BLACK. Priorità FR (7), IT (6), DE (5), ES (5) secondo numero di offerte; è **numero di combinazioni**, NON conteggio delle unità disponibili. Shopify disponibili nel campione Rains: 27 unità fisiche aggregate, non moltiplicare per quattro mercati.

Le tre offerte `RNS_14040_MARSH` IT/FR/ES sono `PRESENT_ATTRIBUTES_UNKNOWN` con issue 13013 e 101067: l'ASIN catalog EAN B0FNKR45TQ esiste, ma seller identity deve essere verificata prima di aggiornare le offerte. In DE è BUYABLE nonostante codici warning: 101067 non prova da solo il blocco.

## Dopo release

1. Verificare CI, deploy, `mare_describe` available.
2. Eseguire worklist 7 Rains SKU per FR, IT, DE, ES con massimo 9 SKU in un'unica chiamata; aspettarsi 7/6/5/5 support routes per la coorte e nessun case ID.
3. Registrare la classifica per paese in #273, aprire effettivamente in Seller Central le pratiche dove abilitato e allegare prove soltanto nell'interfaccia protetta.
4. Rileggere Seller GET, EAN-ASIN e BUYABLE dopo risposta Amazon; conservare storico della pratica. Non ricreare un ASIN esistente e non attivare writer #263 da questa diagnostica.

**Nessun cambiamento al frontend Shopify e nessuna modifica Channable.**
