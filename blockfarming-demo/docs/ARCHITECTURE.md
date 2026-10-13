# BlockFarming Architecture

These diagrams render on GitHub, in VS Code (Markdown Preview Mermaid) and in the dashboard Architecture tab.

## 1. System architecture

```mermaid
flowchart TB
  subgraph SRC["Source"]
    F["🏭 Factory<br/>Minjingu · YARA<br/>generate codes + SHA-256"]
    P["🖨️ Secure label printer<br/>scratch panel inside VOID label"]
  end
  subgraph CHAIN_SUPPLY["Distribution"]
    D["🚚 Regional distributor"]
    A["🏪 Agro-dealer"]
    APP["💻 Web / 📱 Flutter app<br/>scan + GPS + sign"]
  end
  subgraph FARM["Last mile"]
    FR["👩🏾‍🌾 Farmer<br/>feature phone"]
  end
  subgraph TEL["Telecom layer (redundant)"]
    MNO1["Vodacom · Airtel · Yas · Halotel<br/>#42;150#42;00#35; provisioned on all"]
    AGG1["Aggregator 1<br/>Africa's Talking"]
    AGG2["Aggregator 2<br/>Beem (failover)"]
    SMS["SMS 15000<br/>fallback channel"]
  end
  subgraph BF["BlockFarming Platform (Node.js)"]
    API["USSD/SMS gateway<br/>FAST PATH &lt; 1 s"]
    CACHE[("Cache / PostgreSQL<br/>token status, sessions")]
    Q["Durable settlement queue<br/>retries + idempotency"]
    OUT["Event outbox<br/>+ legacy mapper"]
  end
  subgraph LEDGER["Permissioned ledger (PoA)"]
    SC["Smart contract<br/>TokenRegistry<br/>single-use REDEEM"]
    BLK[("Hash-chained blocks<br/>Merkle root + validator sig")]
  end
  subgraph PAY["Mobile money"]
    MM["M-Pesa · Mixx · Airtel Money · HaloPesa"]
  end
  subgraph GOV["Government"]
    FIS["TFRA FIS<br/>prices, licences, quotas"]
    RZK["Ruzuku portal<br/>audit + subsidy reports"]
  end
  F -- "batch + token hashes" --> SC
  F -.-> P
  D --> APP
  A --> APP
  APP -- "custody transfer tx" --> SC
  FR -- "dial #42;150#42;00#35;" --> MNO1
  MNO1 --> AGG1
  MNO1 -. "if AGG1 down" .-> AGG2
  AGG1 --> API
  AGG2 --> API
  FR -. "USSD congested" .-> SMS --> API
  API <--> CACHE
  API --> Q
  Q -- "REDEEM tx" --> SC
  SC --> BLK
  Q -- "HMAC-signed payout" --> MM
  MM -- "signed callback" --> Q
  MM -- "subsidy" --> A
  FIS -- "PULL signed REST" --> BF
  OUT -- "PUSH HMAC webhook" --> RZK
  SC -. "ledger events" .-> OUT
  API -- "verification + price" --> FR
```

## 2. USSD verification: fast path + asynchronous settlement

```mermaid
sequenceDiagram
  autonumber
  actor Farmer as Farmer (kitochi)
  participant MNO as MNO USSD switch
  participant AGG as Aggregator
  participant BF as BlockFarming API
  participant C as Cache
  participant Q as Settlement queue
  participant L as Ledger + smart contract
  participant MM as Mobile money
  participant D as Agro-dealer
  participant T as TFRA Ruzuku
  Farmer->>MNO: #42;150#42;00#35; → 1 → 12-digit code
  MNO->>AGG: session (MSISDN, cell-ID)
  AGG->>BF: POST /ussd (text="1*code")
  BF->>BF: Luhn check, rate limit, HMAC-SHA256(code)
  BF->>C: lookup hash → UNREDEEMED
  BF->>C: reserve → PENDING (ref BF-xxxx)
  BF->>Q: enqueue settlement
  BF-->>Farmer: END GENUINE · max price · dealer · ref (under 1 s)
  BF-->>Farmer: SMS receipt
  Note over Farmer,BF: USSD session closed — everything below is asynchronous
  Q->>L: REDEEM(hash, ref)
  L->>L: contract: UNREDEEMED → REDEEMED (rejects any 2nd use)
  L-->>Q: sealed in block #n
  Q->>Q: payee = custodian of the bag on the ledger
  Q->>MM: payout (HMAC signature, Idempotency-Key = ref)
  MM-->>Q: 202 accepted
  MM->>D: TZS subsidy to wallet
  MM-->>Q: signed callback SUCCESS
  Q-->>D: SMS confirmation
  Q->>T: SUBSIDY_REDEEMED + SUBSIDY_PAID (signed webhook)
```

## 3. Telecom and USSD redundancy (judge feedback #2)

```mermaid
flowchart TB
  FR["Farmer dials #42;150#42;00#35;"] --> SW{"MNO switch<br/>Vodacom / Airtel / Yas / Halotel"}
  SW -->|primary healthy| A1["Aggregator 1"]
  SW -->|primary down| A2["Aggregator 2"]
  SW -->|all USSD down| SMSIN["Reply: send code by SMS to 15000"]
  A1 --> FAST
  A2 --> FAST
  SMSIN --> FAST
  FAST["FAST PATH (&lt;1 s)<br/>cache lookup + reserve<br/>no blockchain call in session"] --> ANS{"Session still alive?"}
  ANS -->|yes| U["USSD END message"]
  ANS -->|dropped| FB["SMS fallback with same result + ref"]
  FAST --> Q[("Durable queue")]
  Q --> L["Ledger REDEEM<br/>(retry while node unreachable)"]
  L --> P{"Payout"}
  P -->|202| CB["Wait for signed callback"]
  P -->|"503 / timeout"| R["Retry 2s → 4s → 8s → 16s<br/>same Idempotency-Key = no double pay"]
  R --> P
  R -->|"5 failures"| MR["Manual review + SMS to dealer"]
  CB --> PAID["PAID"]
  REQ["Re-query same code from same phone"] --> IDEM["'Already verified by you · ref · status'"]
  RL["5 wrong codes / hour / phone"] --> BLOCK["Rate-limited (brute-force guard)"]
```

## 4. TFRA FIS / Ruzuku integration protocol (judge feedback #3)

```mermaid
sequenceDiagram
  autonumber
  participant FIS as TFRA FIS (legacy)
  participant ACL as BlockFarming integration adapter
  participant BF as BlockFarming core
  participant L as Ledger
  participant OB as Outbox
  participant RZ as Ruzuku portal
  rect rgb(235,245,255)
  Note over FIS,BF: PULL — every 30 s (and on demand), signed GET
  ACL->>FIS: GET /fis/v1/registry (HMAC + timestamp)
  FIS-->>ACL: prices "45,000/=", MSISDN "0754 111 222", dates DD/MM/YYYY, status A/S/R
  ACL->>ACL: normalise: integers, 2557xxxxxxxx, ISO dates, ACTIVE/SUSPENDED
  ACL->>ACL: invalid record → QUARANTINE (never guessed)
  ACL->>BF: registry (prices, licences, quotas) — last good copy kept if FIS is down
  end
  rect rgb(240,255,240)
  Note over L,RZ: PUSH — every ledger event, at-least-once
  L-->>BF: batch / custody / redeem confirmed (block #n)
  BF->>OB: event (EVENT_ID, LEDGER_TX, BLOCK_NO)
  OB->>OB: map → legacy record (TXN_TYPE, DEALER_LIC, AMT_TZS "25000.00", TXN_DATE dd/mm/yyyy)
  OB->>RZ: POST /ruzuku/v1/events (X-BF-Signature HMAC-SHA256)
  RZ-->>OB: ACK_NO (duplicates by EVENT_ID return same ACK)
  OB->>OB: on 5xx / timeout → retry with backoff until ACK
  end
```

## 5. Void label + single-use code (judge feedback #1)

```mermaid
flowchart LR
  subgraph PHYS["Physical layer — Void label"]
    L1["Code under scratch panel<br/>inside tamper-evident VOID label"]
    L2{"Label peeled<br/>before sale?"}
    L3["'VOID' pattern stays on bag<br/>+ label cannot be re-stuck"]
    L4["Farmer refuses bag<br/>USSD option 3 → report bag #"]
    L1 --> L2
    L2 -->|yes| L3 --> L4
  end
  subgraph DIG["Digital layer — single-use code"]
    D1["Code entered via USSD/SMS"]
    D2{"Smart contract<br/>status?"}
    D3["UNREDEEMED → REDEEMED<br/>dealer paid once"]
    D4["ALREADY USED → 'Do not buy'<br/>alert to TFRA"]
    D5["Reported bag → blocked on ledger"]
    D1 --> D2
    D2 -->|first use| D3
    D2 -->|second use| D4
    D2 -->|flagged| D5
  end
  L2 -->|no, intact| D1
  L4 --> D5
  H["Harvested code used by fraudster first"] --> D2
  D3 -. "payout goes to the custodian dealer,<br/>never to the caller's phone" .-> X["No profit from stolen codes"]
```

## 6. Token and settlement state machines

```mermaid
stateDiagram-v2
  direction LR
  state "Token (bag code)" as TK {
    [*] --> UNREDEEMED: factory REGISTER_BATCH
    UNREDEEMED --> UNREDEEMED: CUSTODY_TRANSFER (holder changes)
    UNREDEEMED --> PENDING: USSD/SMS verify (reserved)
    PENDING --> REDEEMED: smart contract REDEEM sealed
    UNREDEEMED --> FLAGGED: VOID label reported
  }
  state "Settlement" as ST {
    [*] --> QUEUED
    QUEUED --> CHAIN_PENDING
    CHAIN_PENDING --> CONFIRMED
    CONFIRMED --> PAYOUT_READY: dealer licensed
    CONFIRMED --> MANUAL_REVIEW: holder not a dealer / suspended
    PAYOUT_READY --> PAYOUT_SENT
    PAYOUT_READY --> RETRYING: MNO down
    RETRYING --> PAYOUT_SENT
    RETRYING --> MANUAL_REVIEW: 5 failures
    PAYOUT_SENT --> PAID: signed callback
    QUEUED --> BLOCKED_DOUBLE_SPEND: contract rejects
  }
```

