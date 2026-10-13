# BlockFarming — Live Demo Platform

Blockchain-backed fertilizer verification over USSD, with automated mobile-money subsidy settlement to agro-dealers and real-time TFRA (FIS / Ruzuku) integration.

**Runs with Node.js only (v18+). No Docker, no database server, and no `npm install` needed.**

```bash
cd blockfarming-demo
node start.js --reset      # fresh ledger + demo supply chain
# open http://localhost:7070
```
`node start.js` (without `--reset`) keeps the existing data. Stop with `Ctrl+C`.

## Who uses it: three entry points

| Page | Who | Login |
|---|---|---|
| **http://localhost:7070/farmer.html** | Smallholder farmers (public). Verify a bag, see official prices, report a VOID label, check a ref. The same service is on USSD `*150*00#` and SMS `15000`. | **None, public** |
| **http://localhost:7070/portal.html** | One dashboard per stakeholder role (below) | Yes. Data is scoped **server-side** to the user's licence. |
| **http://localhost:7070/** | Live Demo (phone simulator, scratch-label bags, live settlement pipeline) + **Architecture** tab | None (presenter tool) |

### Role dashboards (password for every demo account: `demo1234`)

| Role | Demo user | Dashboard |
|---|---|---|
| Manufacturer | `minjingu`, `yara` | Register a batch (codes hashed, labels sent to the printer), ship to distributors, see where every bag is now, trace its own bags |
| Regional distributor | `dist.morogoro`, `dist.mbeya` | Stock on hand from the ledger (serial ranges), dispatch to licensed dealers, dealer licence status, regional quota use |
| Agro-dealer | `neema`, `kilimobora`, `uyole` | Licence status, price board for farmers, stock in shop, sales verified by farmers, subsidy received / pending / under review, SMS |
| TFRA regulator | `tfra` | Ledger integrity, national KPIs, regional table with quotas, **approve/reject** held payouts, suspend/reinstate licences (written to FIS), alerts, bag audit trail |
| System administrator | `admin` | Control room (health, KPIs, alerts, reset demo data), **Redundancy switches** (aggregators, mobile-money rails, TFRA), USSD sessions, settlement queue + SMS + MNO gateway, supply chain, **Blockchain & security** (tamper test, forged/replayed webhooks), TFRA integration (FIS actions, outbox, quarantine), Architecture |
| Field inspector | `inspector.mor`, `inspector.mby` | Alerts and tamper reports in their region, dealers with flagged/expired stock, log a signed PASS/FAIL inspection (pushed to Ruzuku), bag trace |

Every dashboard has a sidebar with sections (a slide-out ☰ menu on phones and tablets). The TFRA regulator also gets read-only **Blockchain ledger** and **FIS / Ruzuku** pages. Operator endpoints (switches, tamper, attacks, reset) require the `admin` login.

Access rules enforced by the API: dealers see only their own sales and stock. Manufacturers ship only to distributors and can trace only their own bags. Distributors ship only to licensed dealers. Inspectors act only in their region. Only TFRA decides on held payouts and licences.

Presenter shortcut: `portal.html#login=neema` (or any demo username) signs in directly.

## Services

| Service | Port | Role |
|---|---|---|
| `platform/server.js` | 7070 | Dashboard, USSD/SMS gateway, settlement queue, TFRA adapter |
| `chain/node.js` | 7071 | Permissioned ledger (Proof-of-Authority), `TokenRegistry` smart contract |
| `mno/gateway.js` | 7072 | Mobile money mock (M-Pesa, Mixx/Tigo Pesa, Airtel Money, HaloPesa) |
| `tfra/fis.js` | 7073 | TFRA FIS registry + Ruzuku portal mock (legacy data formats) |

Diagrams are in the dashboard's **Architecture** tab and in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The editable draw.io version is [docs/blockfarming-v2.drawio](docs/blockfarming-v2.drawio).

## How the concept brief maps to the code

| Brief / judge requirement | Implemented as |
|---|---|
| Cryptographic tagging at source (SHA-256) | 12-digit single-use code per bag (11 random digits + Luhn check digit). Only `HMAC-SHA256(pepper, code)` leaves the factory. Batch hash = SHA-256(metadata + all token hashes). |
| Distributed ledger | Hash-chained blocks with Merkle root and validator signature (PoA). State is rebuilt by replaying the chain. `/verify` detects any edit. |
| Smart contract single-use | `REDEEM` moves a token from UNREDEEMED to REDEEMED once. A second use is rejected; the same settlement ref is idempotent. Custody transfers must come from the current holder. |
| Custody tracking | Distributor → dealer transfers by bag serial range, with GPS. Licence and regional quota are checked against the TFRA registry. |
| Payout to the **agro-dealer** | The payee is the bag's custodian on the ledger, **never the phone that dialled**. Harvested codes earn a thief nothing. |
| **Judge #1 – tamper-evident packaging** | Void label (Peel button), USSD option 3 to report a bag (blocked on the ledger), duplicate-use alert, and payee taken from custody |
| **Judge #2 – USSD redundancy** | Fast path under 1 s from cache, ledger and payment asynchronous, SMS fallback on dropped sessions, SMS channel 15000, aggregator failover, durable queue with backoff, idempotency keys, rate limit (5 wrong codes per hour) |
| **Judge #3 – TFRA / Ruzuku protocol** | PULL: signed `GET /fis/v1/registry` every 30 s, last good copy kept. PUSH: outbox, legacy mapper, HMAC-signed webhook, ACK, retries. Bad records are quarantined. |
| HMAC webhooks + TLS | `X-BF-Signature` = HMAC-SHA256(ts + "." + body), 5-minute replay window, constant-time compare. In production this runs over TLS. |
| Cell-tower anomaly detection | Tower region vs dealer region raises a `GEO_ANOMALY` alert for review (it does not block the sale) |

## Demo script (about 10 minutes)

**Live Demo tab**

1. **Genuine bag.** Pick a bag held by *Mama Neema Agrovet*, click **Scratch**, then **Verify on phone**, then press the green **OK** key. The farmer gets GENUINE, the max price, the dealer and a ref in a few ms. The right panel shows the async pipeline: smart contract → block → payee from custody → HMAC payout → signed callback → **PAID**. The dealer gets an SMS (see the Settlements tab).
2. **Same code again** on Juma's phone shows "ALREADY USED – do not buy" and raises a duplicate alert.
3. **Counterfeit.** Click *Generate counterfeit code*, then *Use on phone*, then OK. The code is not registered, and a TFRA alert is raised with the cell tower.
4. **Void label (judge #1).** Click **Peel (fraud)** on a bag: the label shows VOID. Switch to the Fraudster phone and redeem it first. Then the farmer tries: ALREADY USED. The payout still went to the custodian dealer, not the fraudster. Use **Report VOID** to show the bag being blocked.
5. **Congested network (judge #2).** Tick *Simulate congested network*, then verify a bag. The USSD session drops, but the SMS inbox receives the result (FALLBACK).
6. **Diversion.** Verify a bag that is still held by *Morogoro Agro Distributors* (bags #16–20). It goes to MANUAL_REVIEW with a `DIVERSION_SUSPECTED` alert, and no payout is made.
7. **Expired stock.** Verify a bag from batch `MM24001`: the farmer is told "GENUINE but EXPIRED".

**Dashboards → admin → Redundancy** (judge #2)

8. Turn off *Africa's Talking*, then dial again: the session fails over to Beem. Turn off both: the phone is told to use SMS 15000.
9. Turn off *Mixx*, then verify a bag from *Kilimo Bora Shop* (#11–15). The Settlements tab shows retries at 2s → 4s → 8s, and the dealer gets a "queued" SMS. Turn Mixx back on: it is paid **once** (same Idempotency-Key).

**Dashboards → admin → TFRA integration** (judge #3)

10. Turn TFRA off (Control Room): events wait in the outbox as RETRYING, and the registry is served from cache. Turn it back on: they are delivered with ACK numbers.
11. Change the NPK price in FIS: it syncs, and USSD option 2 shows the new price. Suspend a dealer: the next payout for their bag goes to manual review.
12. Show the **Quarantined records** list (a dealer with no MSISDN is never guessed) and the legacy-format payloads.

**Dashboards → admin → Blockchain & security**

13. Click **Insider edits the database**: the result is "TAMPERING DETECTED at block #n (merkle root mismatch)". Then click **Resync from honest peer**.
14. Click **Forged payout** and **Replay attack**: the MNO gateway answers 401 and no money moves.

**Dashboards → minjingu / dist.morogoro**

15. Register a new batch, then transfer it to a distributor. Try to transfer from the wrong holder: the smart contract rejects it (`NOT_CUSTODIAN`).

## What is simulated

USSD aggregators, MNO payout APIs, SMS delivery and TFRA FIS/Ruzuku are local mocks with the same contract shapes (signed requests, async callbacks, idempotency). The ledger is a single-validator PoA chain. The production target is Hyperledger Fabric or Solana with Rust/Anchor contracts. The cache is a JSON store standing in for PostgreSQL/Redis. Plain-text codes in `data/print-runs.json` exist only so the demo has scratch cards; in production they go only to the secure label printer.
