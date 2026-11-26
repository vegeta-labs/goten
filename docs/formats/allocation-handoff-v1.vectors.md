# Allocation hand-off v1 — shared test vectors

`allocation-handoff-v1.vectors.json` holds the shared test vectors for the allocation hand-off format (`allocation-handoff-v1.md`, §4). Goten's tests and Bulma's tests both use it. If code disagrees with a vector, check the format doc first. Change the vectors only when the format changes, and both sides must agree to the change.

## Layout

```json
{ "format_doc": "allocation-handoff-v1.md", "vectors": [ { "name", "kind", "description", ... } ] }
```

Every vector has a unique `name`, a `kind` and a one-line `description`. The fields that follow depend on the kind:

| kind | fields | how to check it |
|---|---|---|
| `canonical` | `projection` (object), `canonical_utf8_hex`, `projection_hash` | Canonicalise `projection` as in §4. The UTF-8 bytes must equal `canonical_utf8_hex` (lowercase hex), and `"sha256:"` + SHA-256 of those bytes must equal `projection_hash`. A canonical vector only tests hashing. It does not need to be a valid request; for example, the §2.1 example uses the printed id `p_…` twice. |
| `accept` | `request_text` | Import the exact text. The importer must report no errors, and its recomputed hash must equal the file's `projection_hash`. |
| `refuse` | `request_text`, `reason` | Import the exact text. The whole file must be refused. `reason` names the format rule (by section) that refuses it. Each refuse vector breaks only that one rule; everything else, including the hash, is valid. |
| `result` | `request_text`, `expected_result` | Import the request and compute the allocation. The exported result must equal `expected_result` as a JSON value. Key order does not matter. Array order does matter: `participants` follow request order. |

`request_text` is the file content as a JSON string, so the vectors can contain files that a JSON object could not represent. Examples are a duplicate key, or the six-character escape `\ud800`. Feed that string to the importer unchanged; do not parse and re-serialise it first. Engine checks assume the importer runs `goten-rules/0.9`.

## Coverage

- **Canonical form:** the §2.1 example; string escaping (U+0001 → `\u0001`, U+001F → `\u001f`, tab and `\b \f \n \r` in short form, `"` and `\`); characters that stay literal (é, an emoji, U+2028, U+2029, `/`, U+007F); omitted optional fields; `terms.fee: null`; key order in a full `platform_fee`.
- **Accept:** a base request; the same request with reordered keys and no whitespace, which gives the same hash; a non-ASCII label written literally and the same label written as `\u` escapes, which also give the same hash; a name of exactly 256 UTF-16 code units containing emoji; `allocation_amount` `"0"`.
- **Refuse:** a name of 257 UTF-16 code units; a duplicate key; a lone surrogate; participants out of order; an order gap; `add_on_threshold` without `add_on_rate_bps`; an unknown field at the top level; an unknown field in `projection`; engine `goten-rules/0.8`; a hash mismatch.
- **Result:** TC-J-45, the two-person deal with a platform fee paid by investors pro rata (PRD C-ALL-9b example).

## How the hashes were produced

The vectors were written before any implementation. The canonicaliser is a short Python script that uses only the standard library (`json` for reading files, `hashlib` for SHA-256). It was written from the text of format §4 alone; no third-party JCS library was used and no Goten or Bulma code was read. The canonicaliser:

- sorts object keys by UTF-16 code units;
- writes no whitespace;
- escapes strings as listed in §4 rule 3 and writes every other character literally;
- writes `null` only for `terms.fee`, because absent fields are simply missing from the object;
- encodes the result as UTF-8.

As a cross-check, the canonical vectors also match Python's `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)`. That function happens to coincide with JCS for v1's value types.

The same script contains an independent checker for the §2 rules. It confirmed that each accept vector passes, and that each refuse vector fails only for its stated reason. The TC-J-45 expected result was computed by hand from PRD C-ALL-1, C-ALL-6, C-ALL-7 and C-ALL-9b, and checked against the identities in format §3.
