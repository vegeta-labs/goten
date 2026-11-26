# Allocation hand-off format v1

Status: **approved 2026-11-25** (Goten owner 「批准文档」 after Bulma review and three Codex rounds); reviewed by Bulma before any code (Goten PRD v0.9 C-ALL-12, R-ALL-14; Bulma PRD §5.7). Owner of this file: Goten. Changes after review need both sides' agreement and a new format version if they are not backward compatible.

Two JSON files: a **request** (Bulma → Goten) and a **result** (Goten → Bulma). Both are UTF-8 JSON objects. Goten reads and writes them only in the browser (file open / file save); nothing is sent over a network.

## 1. Number encoding

The examples in §2 and §3 are illustrative (IDs are elided as `p_…`; real IDs are unique) and show one deal: one person, on top 4%, commitment £10,000, platform fee 2.5% with no minimum paid by investors, price £1.25 → T £10,000, own fee £400, S £250, I £9,750, 7,800 shares.

Text lengths (IDs, names, emails, labels, `handoff_id`, `deal_id`, `status`, `decision`) are counted in **UTF-16 code units**, as JavaScript's `.length` (an emoji counts 2), on both sides.

Every number is a **decimal integer string** (`"1040000"`), never a JSON number, so no reader rounds it:

| Kind | Unit | Example |
|---|---|---|
| money | minor units (pence, cents) | `"1040000"` = £10,400.00 |
| rate | basis points (1% = `"100"`) | `"400"` = 4% |
| share price | micro-units of the currency | `"1250000"` = £1.25 |
| order | integer from `"1"` | `"3"` |

Negative values are never valid in v1. Leading zeros, `+`, spaces and decimals are invalid (`"0"` is valid).

## 2. Request — `goten.allocation-request/1`

```json
{
  "format": "goten.allocation-request/1",
  "handoff_id": "ho_7K2M9Q…",
  "deal_id": "deal_…",
  "engine": "goten-rules/0.9",
  "projection_hash": "sha256:<64 lowercase hex>",
  "projection": { … },
  "bookkeeping": { … }
}
```

- `handoff_id`, `deal_id`: opaque strings, 1–80 characters from U+0021 to U+007E (printable ASCII, no space). Goten shows them and returns `handoff_id` unchanged.
- `engine`: the **required** Goten rules version. Goten refuses the file if it differs from its own (`This request needs engine {x}; this copy of Goten runs {y}`); it never computes under other rules.
  - The rules version changes only when a calculation rule, rounding or this format changes (a new PRD rules version). A release that changes only copy, styles or docs keeps it.
  - Goten v0.9 rules: `goten-rules/0.9`.
- `projection_hash`: see §4. Goten recomputes it; a mismatch refuses the file (`The file was changed after it was exported`).

### 2.1 `projection` (hashed)

```json
{
  "currency": "GBP",
  "instrument": "equity",
  "share_price_micros": "1250000",
  "cap": "30000000",
  "minimum": "100000",
  "platform_fee": {
    "rate_bps": "250", "minimum": "0",
    "payer": "investors"
  },
  "deal_fees": [],
  "participants": [
    {
      "id": "p_…", "order": "1", "status": "active", "decision": "allocate",
      "terms": { "fee_mode": "on_top", "fee": { "kind": "rate", "rate_bps": "400" }, "carry_bps": "2000" },
      "commitment": "1000000", "cash_due": "1040000", "allocation_amount": "1040000",
      "scheme": "none"
    },
    { "id": "p_…", "order": "2", "status": "withdrawn", "decision": "refund" }
  ]
}
```

| Field | Rule |
|---|---|
| `currency` | `GBP`, `EUR` or `USD`. Must equal the Goten deal's currency, else the file is refused with both currencies and the way out: `This request is in {EUR}; this deal is in {GBP}. Change the deal currency to {EUR} in Deal settings, then import again.`; while a fee payer change is active (currency locked, Goten decision 12) the second sentence is `Reverse the active fee payer change first, then change the deal currency to {EUR} and import again.` (Goten does not change the deal currency on import); changing the deal currency afterwards counts as an edit (no result export, R-ALL-14) |
| `instrument` | `equity`, `convertible` or `fund_units` (R-DEAL-06) |
| `share_price_micros` | required and > 0 for `equity`; must be absent otherwise |
| `cap` | > 0, or absent for no cap |
| `minimum` | required, ≥ 0; `"0"` = no minimum |
| `platform_fee` | absent = none. `rate_bps`, `add_on_rate_bps` 0–10000; `minimum` ≥ 0; `maximum` absent = no cap, `"0"` = a cap of 0; `minimum` ≤ `maximum` when both are present; `add_on_threshold` ≥ 0, absent = no add-on (then `add_on_rate_bps` must be absent or `"0"`); `add_on_threshold` present → `add_on_rate_bps` **required** (no default); `payer` one of `investors` (pro rata), `lead` (the sponsor), `company` (C-ALL-9b) |
| `deal_fees` | company- or lead-paid fees only (no investor-paid items: each person's terms are complete). Each `{ "id", "label", "payer": "company"\|"lead", "kind": "percent"\|"fixed", "value" }`; `id` 1–40 characters, unique; `label` 1–60 characters, no control characters (U+0000–U+001F, U+007F); `value` 0–10000 bps for `percent`, > 0 minor units for `fixed`. The label is inside the hash **on purpose**: a renamed fee is a changed deal sheet, so an older result is refused. Bulma sends `[]` today (no deal-level fees besides the platform fee). May be empty |
| `participants` | every participation that ever had a payment reference, **sorted by `order`, with orders exactly 1..n** (otherwise refused, never re-sorted). Ties in largest-remainder splits go to the lower `order` |
| `status`, `decision` | strings matching `[a-z_]{1,40}` (Bulma sends `decision` = `allocate`, `refund_withdrawn` or `refund_closed`); Goten only hashes them. `decision: "allocate"` = enters the allocation; any other value = listed as "Not in this allocation" and not computed, and must carry no other fields |
| `terms` | required when `decision` is `allocate`. `fee_mode`: `on_top` or `deducted`. `fee`: `null` (no cash fee), `{ "kind": "rate", "rate_bps" }` (0–10000; at most 9999 when deducted) or `{ "kind": "fixed", "amount" }` (> 0). `carry_bps` required, 0–10000 (used only at exit) |
| `commitment`, `cash_due` | the committed amount C and the cash due D (Bulma C-FEE-1). Goten displays them; it does not recompute D |
| `allocation_amount` | min(eligible N, D): Goten's R for this person (C-ALL-1). ≥ 0: a person who committed but paid nothing by close is sent with `"0"` and comes back as `no-funds` |
| `scheme` | `none`, `SEIS` or `EIS` |

Investor IDs: 1–40 characters (Goten I-01 field table), unique. Limits as Goten I-08: at most 500 participants.

Required vs optional: `cap`, `share_price_micros` (non-equity), `platform_fee` and inside it `maximum`, `add_on_threshold`, `add_on_rate_bps` may be absent; every other field listed is required (`deal_fees` may be `[]`). `null` is allowed only for `terms.fee`. **Any field not listed in this section, in `projection`, `bookkeeping` or the top level, refuses the file**: a later field must never be ignored silently, since it may change meaning (a new field needs a new format version). Deal-fee `id`s are unique and labels unique ignoring case and outer spaces (Goten's own fee-table rule).

### 2.2 `bookkeeping` (not hashed)

```json
{ "participants": [ { "id": "p_…", "name": "Ada Lovelace", "email": "ada@example.com", "money_held": "1040000" } ] }
```

Names (required, 1–256 characters), emails (optional, ≤ 320 characters) and money held N (optional, money, never negative: Bulma does not export while any N < 0) are for display and for naming people in blockers. Changing them never changes a number, so they are outside the hash. Every `bookkeeping` ID must appear in `projection.participants` and every allocated participant must have a name; otherwise Goten refuses the file.

## 3. Result — `goten.allocation-result/1`

```json
{
  "format": "goten.allocation-result/1",
  "handoff_id": "ho_…",
  "engine": "goten-rules/0.9",
  "projection_hash": "sha256:…",
  "can_close": true,
  "blockers": [],
  "participants": [
    {
      "id": "p_…", "allocated": true, "exclusion": null,
      "target": "1000000", "own_fee": "40000", "platform_fee_share": "25000",
      "invested": "975000", "refund": "0", "micro_shares": "7800000000"
    },
    { "id": "p_…", "allocated": false, "exclusion": "not-in-allocation" }
  ],
  "totals": {
    "received": "…", "invested": "…", "investor_fees": "…", "platform_fee": "…",
    "platform_fee_payer": "investors", "refunds": "…", "company_fees": "…", "lead_invoice": "…", "wire": "…"
  },
  "deal_fees": [ { "id": "…", "amount": "…" } ]
}
```

- `handoff_id`, `engine`, `projection_hash`: copied unchanged from the request (the engine was checked equal on import).
- **Blocked result:** when any blocker exists (Goten R-ALL-08), the file is a status report, not an allocation: `can_close: false`, `blockers` filled, and **no** `participants`, `totals` or `deal_fees` (a blocked allocation can have diagnostic values that are negative or meaningless, and Bulma must not book them). This is Goten's one exception to "no export while blocked" (C-03), because the sender needs to know why. Example: `{ "format": "goten.allocation-result/1", "handoff_id": "…", "engine": "goten-rules/0.9", "projection_hash": "sha256:…", "can_close": false, "blockers": [ { "code": "platform-fee-exceeds", "ids": ["p_…"] } ] }`. No participants (B = 0) is the blocker `no-participants`, so no platform fee appears.
- `can_close`: true only when there is no blocker; then all fields below are present. `blockers[].code`: `no-participants`, `company-fees-exceed`, `scale-back-below-minimum`, `platform-fee-exceeds` (fee > B or a share ≥ T); `ids` lists the people concerned (may be empty).
- Per participant, in request order:
  - `allocated: false` → `exclusion` is `not-in-allocation` (decision ≠ `allocate`), `no-funds` (`allocation_amount` = 0), `fees-exceed-receipt` (R ≤ F, or M ≤ 0 under C-ALL-1), `below-minimum` (C-ALL-2) or `zero-investment` (T reached 0 in the C-ALL-7 retry), plus `refund` (= `allocation_amount`, absent for `not-in-allocation`); no other fields.
  - `allocated: true` → `target` T (after minimum, scale-back and C-ALL-7, before the platform fee), `own_fee` (the person's cash fee, `"0"` when none), `platform_fee_share` S (`"0"` unless investors pay), `invested` I = T − S, `refund`, and `micro_shares` (only for `equity`; shares × 1,000,000, floor).
  - `refund` is only the part of `allocation_amount` handed back by this allocation (not participating, C-ALL-7 rounding). Money the person sent above `allocation_amount` (over-payment, held money) is **not** in this file; the sender keeps track of it.
  - Identity per person: `allocation_amount` = `target` + `own_fee` + `refund`.
- `totals` (all present when `can_close`): `invested` = Σ I; `investor_fees` = Σ `own_fee`; `refunds` = Σ `refund` of allocate participants; `company_fees` = company-paid deal fees + the platform fee when the company pays; `lead_invoice` = lead-paid deal fees + the platform fee when the lead pays; `wire` = `invested` − `company_fees` (Goten C-ALL-9a). `deal_fees` is always present when `can_close` (`[]` when the request had none).
- `totals.received` = Σ `allocation_amount` of the `allocate` participants, so `received` = `invested` + `investor_fees` + `platform_fee` (when investors pay) + `refunds`.
- `totals.platform_fee` and `platform_fee_payer` are absent when the request had no platform fee.

Goten exports a result only while the allocation inputs are exactly those imported from the request (R-ALL-14). Bulma accepts a result only when `projection_hash` equals the hash of its **current** projection and `engine` equals the version it sent.

## 4. Hash

`projection_hash` = `"sha256:"` + lowercase hex SHA-256 of the UTF-8 bytes of the **canonical JSON** of `projection`, where canonical JSON is **RFC 8785 (JSON Canonicalization Scheme, JCS)**. Because every value in v1 is a string, an object, an array or `null`, JCS reduces to:

1. Object keys sorted by UTF-16 code units (all keys in v1 are ASCII, so this is plain ASCII order); no duplicate keys.
2. No whitespace outside strings.
3. Strings: escape `"` as `\"` and `\` as `\\`; `\b \f \n \r \t` in their short form; every other character below U+0020 as `\u00xx` with **lowercase** hex; everything else literal (including `/`, U+007F, U+2028, U+2029 and all non-ASCII). No Unicode normalisation: strings are hashed exactly as sent.
4. Absent optional fields are **omitted**, never written as `null`, except `terms.fee`, where `null` means "no cash fee" and is required.
5. Arrays keep their order (`participants` sorted by `order`, `deal_fees` as sent).

Shared test vectors (written before code by Goten, used by both repos' tests): `docs/formats/allocation-handoff-v1.vectors.json`, with at least: a request, its canonical bytes (hex) and its hash; strings with a control character, a non-ASCII label, an emoji and U+2028; a file with a duplicate key and one with a lone surrogate (both refused); a platform fee with a threshold but no add-on rate (refused); a name of exactly 256 UTF-16 code units containing emoji (accepted) and one of 257 (refused); participants out of `order` (refused); and the TC-J-45 request with its expected result.

## 5. Errors on import (Goten)

The whole file is refused, with every problem listed (Goten R-REC-02.4 style): invalid JSON, **duplicate keys** or **lone surrogates** (both forbidden by RFC 8785; Goten checks for them explicitly because `JSON.parse` accepts them); unknown `format`; unknown fields; engine mismatch; currency mismatch; hash mismatch; any field failing §2; duplicate IDs or orders; a `bookkeeping` mismatch; and every Goten input rule (I-01 to I-09, C-ALL-0: deducted rate < 100%). Nothing is partly imported.
