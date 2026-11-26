# Oracle case format (shared by the TypeScript engines and the Python oracle)

Each case is one JSON file. All money is integer minor units (pence/cents). Percentages are integer basis
points (1% = 100). Share prices are integer micros (1e-6 of the currency unit). Multiples and years are
integer hundredths (3.00x = 300, 2.5 years = 250). Inputs in case files are always already parsed and valid
unless the case says `"expectInvalid": true`.

Both implementations read a case and print one JSON object (keys sorted, no extra whitespace needed). The
compare script diffs the two outputs field by field; any difference fails CI.

## allocation

Input:
```json
{
  "kind": "allocation",
  "feeBasis": "deducted" | "onTop",
  "minimum": 100000,
  "cap": 15000000 | null,
  "priceMicros": 2413700,
  "fees": [ { "id": "f1", "kind": "percent" | "perInvestor" | "fixed", "value": 300, "payer": "investors" | "company" | "lead" } ],
  "investors": [ { "id": "c01", "received": 1000000, "scheme": "none" | "SEIS" | "EIS" } ]
}
```
Allowed fee combinations: payer `investors` → kind `percent` or `perInvestor`; payer `company`/`lead` → kind `percent` or `fixed`.

Output:
```json
{
  "ok": true,
  "investors": {
    "c01": {
      "participating": true,
      "invested": 970000,
      "fees": { "f1": 30000 },
      "refund": 0,
      "microShares": 4018726436,
      "claimableShares": 4018,
      "claimableAmount": 969824
    }
  },
  "feeTotals": { "f1": 31050 },
  "totalInvested": 0,
  "companyFees": 150000,
  "leadInvoice": 0,
  "wire": 0,
  "blockers": ["company-fees-exceed" | "no-participants" | "scale-back-below-minimum"]
}
```
- Non-participating investors: `participating: false`, `invested: 0`, `fees: {}` (no keys), `refund` = received, `microShares: 0`, `claimableShares: 0`, `claimableAmount: 0`.
- `fees` for a participant has one key per investor-paid fee (percent and perInvestor), including zero amounts.
- `feeTotals` has one key per fee in the input (all payers).
- `microShares` = floor(invested × 10,000 × 1,000,000 ÷ priceMicros). `claimableShares` = floor(invested × 10,000 ÷ priceMicros). `claimableAmount` = floor(claimableShares × priceMicros ÷ 10,000). These are reported for every participant regardless of scheme.
- `blockers` sorted alphabetically, empty array if none.
- If the input violates PRD rules (e.g. deducted basis with investor percent fees summing to ≥ 100%), output `{ "ok": false }`.

## waterfall

Input:
```json
{
  "kind": "waterfall",
  "holdings": [ { "id": "a", "capital": 6000000 } ],
  "proceeds": 30000000,
  "exitCosts": 0,
  "years100": 500,
  "carry": { "mode": "fixed", "k": 2000, "h": 800, "c": 10000 }
        | { "mode": "tiered", "tiers": [ { "upTo100": 300, "rate": 2000 }, { "upTo100": null, "rate": 3000 } ] }
}
```
Output:
```json
{
  "ok": true,
  "blockers": [] | ["exit-cost-shortfall"],
  "shortfall": 0,
  "costsPaid": 0,
  "returnOfCapital": 0,
  "hurdlePaid": 0,
  "catchUpTranche": 0,
  "catchUpToLead": 0,
  "carry": 0,
  "investorsTotal": 0,
  "distributions": { "a": 0 }
}
```
- When `exit-cost-shortfall` is a blocker: `shortfall` = exitCosts − proceeds, `costsPaid` = proceeds, every other amount 0 and every distribution 0.
- Fields that do not apply (e.g. hurdle in tiered mode) are 0.
- Invalid input → `{ "ok": false }`.

## reconcile

Input:
```json
{
  "kind": "reconcile",
  "asOf": "2026-10-16",
  "thresholdDays": 10,
  "commitments": [ { "id": "c01", "name": "Amelia Hart", "reference": "NW-001", "cashDue": 1000000 } ],
  "lines": [ { "id": "t01", "txnId": "t01" | null, "date": "2026-10-06", "amount": 1000000, "payer": "A HART", "reference": "NW-001" } ],
  "decisions": { "t03": { "assign": "c03" } | { "reject": true } }
}
```
Decisions in case files are always valid (invalidation is covered by unit tests).

Output:
```json
{
  "lines": {
    "t01": { "status": "auto" | "confirmed" | "suggested" | "unmatched" | "rejected" | "skipped" | "future",
             "assignedTo": "c01" | null,
             "suspectedDuplicate": false,
             "candidates": [ { "id": "c03", "score": 0.55 } ] }
  },
  "commitments": { "c01": { "received": 1000000, "difference": 0, "status": "paid" | "partial" | "overpaid" | "outstanding" } },
  "totals": { "bank": 0, "booked": 0, "unbooked": 0 },
  "aged": ["t11"]
}
```
- `skipped` = amount ≤ 0; `future` = date after `asOf`. Neither counts in totals, neither has candidates.
- `candidates` only for `suggested` lines (empty list otherwise); `score` rounded to 4 decimal places.
- `aged`: line ids whose status is `suggested` or `unmatched` and whose age in days (asOf − date) is greater than `thresholdDays`; sorted. A `rejected` line ("Not part of this deal") is not aged (C-REC-5, v0.8.9): it has been reviewed, and its amount still counts in `unbooked`. The same line with no decision is aged again.

### reconcile — v0.8 extension (C-REC-7 withdrawal, C-ALL-11 effective cash due)

Two optional input fields. **When neither key is present the output is exactly the v0.7 output above**
(no new keys, byte-identical). When either key is present (even `"withdrawn": []`), the extended output applies.
```json
{
  "withdrawn": ["lucas"],
  "adjustedCashDue": { "amelia": 970000 }
}
```
- `withdrawn`: ids of investors marked Withdrawn (consent ticked, date given; the date does not enter any
  calculation). Ids must exist and be unique, else `{ "ok": false }`.
- `adjustedCashDue`: effective cash due (C-ALL-11: N_i of an active fee payer change whose row is not void),
  integer 1..100,000,000,000. Ids must exist. Investors not listed use `cashDue`.
- The effective cash due replaces `cashDue` everywhere: status, difference, amount match in candidate scoring
  (C-REC-3), refunds, chase list, hand-off. Withdrawn investors' references still match and score as normal and
  their lines still book to them (C-REC-7, R-REC-11.3).

Extended output (adds to the v0.7 output; keys sorted):
```json
{
  "commitments": { "c01": { "received": 0, "difference": 0, "status": "... | withdrawn", "cashDue": 970000, "withdrawn": false } },
  "refunds": [ { "id": "hugo", "amount": 500000, "reason": "overpayment" }, { "id": "lucas", "amount": 300000, "reason": "withdrawn" } ],
  "refundTotal": 800000,
  "receivable": 12100000,
  "withdrawnSummary": { "count": 1, "refund": 300000 },
  "chase": [ { "id": "david", "outstanding": 50000 } ],
  "handoff": { "amelia": 1000000 },
  "checks": { "refundIdentity": true }
}
```
- `status` is `withdrawn` for withdrawn investors (other statuses unchanged); `difference` stays received −
  effective cash due (C-REC-4) for everyone; `cashDue` = effective cash due.
- `refunds`: in commitment-list order. Withdrawn with received > 0 → full received, reason `withdrawn` (none if
  received = 0); others with received > effective cash due → the excess, reason `overpayment`.
- `receivable` = Σ effective cash due of non-withdrawn investors. `withdrawnSummary.refund` = Σ received of
  withdrawn investors.
- `chase`: non-withdrawn investors with received < effective cash due (unpaid or part-paid), list order,
  `outstanding` = effective cash due − received.
- `handoff` (C-REC-6 snapshot): every non-withdrawn investor → min(received, effective cash due). Withdrawn
  investors are absent.
- `checks.refundIdentity`: `refundTotal` = Σ withdrawn received + Σ others max(0, received − effective cash due),
  computed separately from the list (a mismatch is an internal error, never `false` in practice).

## feePayerChange (C-ALL-10, v0.8)

Input (allocation settings as in `allocation`; investors carry cash due, not received):
```json
{
  "kind": "feePayerChange",
  "feeBasis": "deducted" | "onTop",
  "minimum": 100000,
  "cap": 15000000 | null,
  "priceMicros": 2413700,
  "fees": [ { "id": "platform", "kind": "percent", "value": 300, "payer": "investors" } ],
  "feeId": "platform",
  "newPayer": "investors" | "company" | "lead",
  "investors": [ { "id": "c01", "cashDue": 1000000, "scheme": "none" } ],
  "applied": { "targets": { "c01": 970000 }, "newCashDue": { "c01": 970000 } }
}
```
- `investors` = the scope (non-withdrawn investors in the current allocation snapshot), cash due integer > 0.
- `fees` = the current fee table Fees; Fees' = the same table with only `feeId`'s payer set to `newPayer`.
- `{ "ok": false }` (input error) when: `feeId` is not exactly one `percent` fee; `newPayer` invalid or (without
  `applied`) equal to the current payer; Fees or Fees' fails the `allocation` validation (e.g. deducted basis
  with investor percent fees summing to ≥ 100%); any N_i > 100,000,000,000 (I-01).
- `applied` (optional) = re-check of an applied change (C-ALL-11: settings changed since applying). Then `fees`
  is the CURRENT fee table and step 1/2 are not recomputed: step-1 participants are the ids in `targets`, their
  T_i and N_i come from `applied`; everyone else keeps `cashDue`. Only step 3 runs with the current settings.

Method:
1. Step 1: `allocation` under Fees with received = cashDue. Its blockers are reported as `before-<code>`; if the
   participants' M (C-ALL-1/2) sum exceeds the cap, `over-cap` is added. Any step-1 blocker stops here.
   T_i = step-1 `invested` of each participant.
2. Step 2: N_i = smallest whole-penny R with I(R) ≥ T_i, where I(R) = `invested` of a one-investor allocation
   under Fees' with minimum 0 and no cap. Searched upward from R0 = F' + ⌈T_i ÷ (1 − p')⌉ (deducted) or
   F' + ⌈T_i × (1 + p')⌉ (onTop); below R0, M(R) < T_i so I(R) < T_i. I(N_i) ≠ T_i is an internal error (the
   oracle raises). Non-participants: N_i = cashDue (unchanged).
3. Step 3: `allocation` under Fees' with received = N_i (participants) / cashDue (others). Its blockers are
   reported as `after-<code>`. Per investor: step-1 participant not participating now → `would-fall-below-minimum`
   (M > 0 but the commitment-basis amount < minimum) or `would-leave` (any other reason); non-participant now
   participating → `would-join`; participant in both with invested ≠ T_i → `invested-differs`.

Output (keys sorted):
```json
{
  "ok": true,
  "canApply": true,
  "blockers": [ { "code": "would-fall-below-minimum", "investor": "isla" }, { "code": "over-cap", "investor": null } ],
  "investors": {
    "c01": { "cashDue": 1000000, "participatingBefore": true, "unchanged": false, "target": 970000,
             "newCashDue": 970000, "difference": -30000, "participatingAfter": true, "investedAfter": 970000 }
  },
  "feeBefore": 30000,
  "feeAfter": 29100,
  "totals": { "cashDue": 0, "newCashDue": 0, "difference": 0,
              "topUpCount": 0, "topUpTotal": 0, "refundCount": 0, "refundTotal": 0 }
}
```
- Blocker codes: `before-company-fees-exceed`, `before-no-participants`, `before-scale-back-below-minimum`,
  `over-cap`, `after-company-fees-exceed`, `after-no-participants`, `after-scale-back-below-minimum`,
  `would-join`, `would-leave`, `would-fall-below-minimum`, `invested-differs`. Deal-level blockers have
  `investor: null`. Sorted by (code, investor). `canApply` = no blockers.
- Non-participants in step 1: `unchanged: true`, `target: null`, `newCashDue` = cashDue, `difference: 0`.
- `difference` = N_i − cashDue (> 0 top-up, < 0 refund). `topUpTotal` and `refundTotal` are positive amounts.
- `feeBefore` = `feeId`'s total in the step-1 allocation (null with `applied`); `feeAfter` = its total in the
  step-3 allocation.
- When step 1 has any blocker: per investor only `cashDue` and `participatingBefore` are filled; `unchanged`,
  `target`, `newCashDue`, `difference`, `participatingAfter`, `investedAfter` are null; `feeAfter` and every
  total except `totals.cashDue` are null.

## v0.9 extension (decision J, PRD v0.9 decision 16)

**Compatibility rule:** an input with none of the new fields below produces exactly the old output (same keys,
same values). New output keys appear only when the input uses a new field. Input errors caused by a v0.9 rule
may carry `"error": "<code>"` (and `"investor": "<id>"`) next to `"ok": false`; old input errors stay exactly
`{ "ok": false }`.

### allocation — v0.9 (C-ALL-0, C-ALL-3, C-ALL-5/8, C-ALL-9a/9b)

Extended mode is on when the case has `instrument` or `platformFee`, or any investor has the key `ownTerms`.
New optional input:
```json
{
  "instrument": "equity" | "convertible" | "fund_units",
  "priceMicros": null,
  "platformFee": { "rate": 250, "minimum": 400000, "maximum": 2000000 | null,
                   "addOnThreshold": 500000000 | null, "addOnRate": 10 | null,
                   "payer": "investors" | "lead" | "company" },
  "investors": [ { "id": "x", "received": 1040000, "scheme": "none",
                   "ownTerms": { "mode": "deducted" | "onTop",
                                 "fee": null | { "kind": "percent", "value": 400 } | { "kind": "fixed", "value": 25000 } } } ]
}
```
- `instrument` absent = `equity` (then `priceMicros` required as before). For `convertible` / `fund_units`
  `priceMicros` must be null or absent, else `{ "ok": false, "error": "share-price-not-empty" }`.
- `ownTerms` (C-ALL-0): the person's own mode and one cash fee; it **replaces** every investor-paid item of
  `fees` for that person (p = f, F = 0 for percent; p = 0, F = amount for fixed; p = F = 0 for null). Deducted
  with percent ≥ 10000 → `{ "ok": false, "error": "own-rate-100", "investor": id }`. The deal's own fee table
  validation (deducted p < 100%) is unchanged.
- `platformFee`: `maximum` null = no cap; `addOnThreshold` null = no add-on (then `addOnRate` must be null or
  0); threshold set → `addOnRate` required. `minimum` ≤ `maximum`.

Method: C-ALL-1, 2, 3, 4, 6, 7 per person with his own mode, p, F. C-ALL-3 minimum check after scale-back on the
commitment basis T ÷ (1 − p) + F (deducted) or T (on top), exact fraction. Then C-ALL-9b: B = Σ final T of
participants; B = 0 → no platform fee; fee = halfUp(min(max, max(min, B × rate))) + halfUp(max(0, B −
threshold) × addOnRate). Investors pay: S_i = largest remainder of fee by T (ties earlier person), I = T − S;
fee > B or any S ≥ T → blocker `platform-fee-exceeds` (ids: every participant with S ≥ T) and C-ALL-9a is
**not** computed. Lead / company pay: I = T, fee added to `leadInvoice` / `companyFees`. C-ALL-9a base =
Σ I (after S). Arithmetic check Σ R = Σ I + Σ cash fees + investor platform fee + Σ refunds (failure raises).

Extended output (adds to the old output):
```json
{
  "investors": { "x": { "...old keys...": 0, "target": 1000000, "ownFee": 40000 | null, "platformFeeShare": 25000,
                        "exclusion": null | "no-funds" | "fees-exceed-receipt" | "zero-investment" | "below-minimum" } },
  "blockerIds": { "scale-back-below-minimum": ["x"], "platform-fee-exceeds": ["x"], "no-participants": [] },
  "platformFee": null | { "amount": 490000, "base": 19600000, "payer": "investors" },
  "received": 0, "investorFees": 0, "refunds": 0
}
```
- `target` = T after C-ALL-7, before the platform fee (0 for non-participants). `invested` = I = T − S (may be
  ≤ 0 while blocked, for diagnosis; then the three share fields are 0).
- `fees` for an own-terms person is `{}`; his fee is `ownFee` (0 when no cash fee). `ownFee` is null for people
  on the deal's default terms.
- Non-equity: `microShares`, `claimableShares`, `claimableAmount` are null for everyone.
- When blocked by `platform-fee-exceeds`: `companyFees`, `leadInvoice`, `wire` and the `feeTotals` of company-
  and lead-paid fees are null.
- `exclusion` order (format v1 §3): R = 0 → `no-funds`; R ≤ F or M ≤ 0 (C-ALL-1) → `fees-exceed-receipt`;
  below the minimum (C-ALL-2) → `below-minimum`; T reaches 0 in the C-ALL-7 retry → `zero-investment`.
- `blocker` codes add `platform-fee-exceeds`. `blockerIds` lists ids in investor order (empty for deal-level).
- `investorFees` = Σ cash fees (own fees + deal investor-paid items); `refunds` = Σ refund incl. non-participants.

### feePayerChange — v0.9 (C-ALL-10)

New optional input: `instrument`, `platformFee` (as in allocation) and per investor `ownTerms` / `carry`.
- Any investor with `ownTerms` (non-null) → `{ "ok": true, "disabled": "own-fee-terms" }` (R-ALL-12.1).
  `carry` alone is ignored.
- Steps 1 and 3 run the full allocation including the platform fee (blockers such as
  `before-platform-fee-exceeds` / `after-platform-fee-exceeds`). Step 2 (single-investor I(R)) ignores it.
- T_i = step-1 `target` (before the platform fee); `invested-differs` compares step-3 `target` with T_i.
- When the allocation runs extended, each computed investor row also has `targetAfter` (step-3 T);
  `investedAfter` stays the step-3 I (= T − S).

### waterfall — v0.9 (C-DIS preamble, C-DIS-8, C-DIS-9)

Extended mode is on when any holding has the key `carry` or the case has the key `payees`.
```json
{ "holdings": [ { "id": "a", "capital": 6000000, "carry": 2000 | null } ],
  "payees": null | [ { "name": "Payee 1", "share": 7000 } ] }
```
- Fixed mode: k_i = carry, blank (null) = deal k. All k_i equal → original algorithm with that common k (the
  k < c check uses it; deal k is not checked when nobody uses it). Otherwise C-DIS-8: D split by capital with
  largest remainder (ties earlier holding), each person's C-DIS-1..5 with C_i, D_i, k_i and the deal h, n, c;
  k_i = 0 skips catch-up; h > 0 and c > 0 needs k_i < c for each k_i > 0, else
  `{ "ok": false, "error": "catch-up-k", "investor": id }`.
- Tiered mode: carries all null → original; all filled and equal → original plus `tieredNotice` = that k;
  mixed → `error: "tiered-carry-mixed"`; filled and different → `error: "tiered-carry-differs"`.
- Payees: 1–20, name 1–120 UTF-16 units, each share > 0 (`payee-share-zero`), sum exactly 10000
  (`payee-sum`); more than 20 or empty → `payee-count`. Null/absent = one payee `Lead`.

Extended output (adds keys):
```json
{ "perInvestor": null | { "a": { "distributable": 0, "k": 2000, "returnOfCapital": 0, "hurdlePaid": 0,
                                 "catchUpTranche": 0, "catchUpToLead": 0, "carry": 0, "distribution": 0 } },
  "payees": [ { "name": "Lead", "amount": 5702100 } ] | null,
  "tieredNotice": null | 1000,
  "carryUsed": null | { "a": 2000 } }
```
- `perInvestor` is null on the original path. On the C-DIS-8 path the top-level step amounts are the sums over
  people, `carry` = K, `investorsTotal` = D − K, `distributions[i]` = D_i − carry_i.
- `payees` is null when `exit-cost-shortfall` blocks.
- `carryUsed` (exit CSV `carry` column, §5.5): fixed mode and at least one holding has a non-null carry → the k
  each person actually uses; otherwise null.

### reconcile — v0.9 (C-REC-3, C-REC-4, C-REC-6, C-REC-9)

New optional commitment fields (extended v0.9 mode when any commitment has either key):
```json
{ "commitments": [ { "id": "a", "...": "...", "refunded": 100000 | null, "refundOnly": null | "withdrawn" | "closed" } ] }
```
(CSV value parsing such as `yes` → `closed` is not the oracle's job; the case holds the parsed value.)
v0.9 mode implies the v0.8 extended output. Net received = booked − refunded is used for `received`,
`difference`, status, C-REC-3 outstanding in candidate scoring, refunds, chase and hand-off.
- Status adds `check-refunds` (net < 0; wins over everything), `withdrawn-imported`, `closed-refund-only`. A
  `refundOnly` flag overrides a manual `withdrawn` mark while it exists.
- Out of scope (manual withdrawn without flag, or any flag): no chase, not in `receivable`, not in `handoff`;
  refund = net if > 0, reason `withdrawn` (manual or flag `withdrawn`) or `refund-only` (flag `closed`).
- `withdrawnSummary.count` = out-of-scope people; `.refund` = Σ their refunds.
- Others: overpayment refund = net − due when > 0; chase when 0 ≤ net < due; `handoff` = min(net, due) when
  net ≥ 0.
- New keys: per commitment `booked` (gross), `refunded`, `refundOnly`; top level `handoffBlockedBy` = ids with
  net < 0 (incl. out-of-scope people), in list order.
- Identity: refundTotal = Σ out-of-scope max(0, net) + Σ others max(0, net − due).

### handoff — new engine (C-ALL-12, `docs/formats/allocation-handoff-v1.md`)

Input, one of:
```json
{ "kind": "handoff", "projection": { ... } }
{ "kind": "handoff", "request": { ...request object... }, "dealCurrency": "GBP", "feePayerChangeActive": false }
{ "kind": "handoff", "requestText": "<raw JSON text>", "dealCurrency": "GBP" }
```
- `projection` only → `{ "ok": true, "canonical": "<JCS text>", "hash": "sha256:<hex>" }` (format §4).
- `requestText` is parsed with duplicate-key detection; lone surrogates anywhere refuse the file.
- Invalid request → `{ "ok": false, "errors": [ ... ] }` (every problem found; JSON-level problems stop at the
  first). Fixed-text errors use the PRD/format wording verbatim: `This request needs engine {x}; this copy of
  Goten runs goten-rules/0.9`, `The file was changed after it was exported`, and the two currency messages.
- Valid → `{ "ok": true, "result": <goten.allocation-result/1 object> }`, computed by the extended allocation
  with: everyone's `terms` as `ownTerms`, R = `allocation_amount`, `deal_fees` as company/lead fees,
  participants in `order`. Blocked → only the header, `can_close: false` and `blockers`
  (`[{ "code", "ids" }]`, sorted by code). Not blocked → `participants`, `totals`, `deal_fees` as format §3,
  every number a decimal string; identity `allocation_amount` = `target` + `own_fee` + `refund` is checked.
