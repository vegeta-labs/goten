#!/usr/bin/env python3
"""Independent reference implementation ("oracle") of the Goten — Deal Calculations engines.

Written from the PRD §5.0-5.4 (v0.8: C-REC-7, C-ALL-10, C-ALL-11; v0.9 decision J:
C-ALL-0, C-ALL-9a/9b, C-ALL-12, C-REC-4/9, C-DIS-8/9; Chinese source of truth, English snapshot in
docs/en/01_PRD.md), the test plan, docs/formats/allocation-handoff-v1.md and scripts/oracle/SCHEMA.md only.
Usage: python3 scripts/oracle/oracle.py <case.json>

All money is integer minor units, rates are basis points, prices are micros,
multiples/years are hundredths. Arithmetic is exact (int / Fraction); the only
hurdle (C-DIS-3) is computed exactly too: half-up rounding of C*((1+h)^n - 1) is
decided by exact rational comparisons (see hurdle_amount).
"""
import json
import re
import sys
from datetime import date
from decimal import Decimal, ROUND_HALF_UP, getcontext
from fractions import Fraction

BP = 10000


class Invalid(Exception):
    """Input error (C-03). v0.9: optional `code` / `investor` are reported next to ok:false
    (only for v0.9 rules, so old invalid outputs stay exactly {"ok": false})."""

    def __init__(self, msg="", code=None, investor=None):
        Exception.__init__(self, msg)
        self.code = code
        self.investor = investor


# ---------------------------------------------------------------- helpers

def half_up(x):
    """Round a non-negative (or any) Fraction/int half away from zero."""
    x = Fraction(x)
    if x < 0:
        return -half_up(-x)
    return int((x + Fraction(1, 2)).__floor__())


def floor_frac(x):
    return Fraction(x).__floor__()


def largest_remainder(total, weights):
    """Split integer total in proportion to integer weights; sum is exact.
    Remainders compared exactly; ties go to the earlier item."""
    wsum = sum(weights)
    if wsum <= 0:
        return [0] * len(weights)
    shares = []
    rems = []
    for w in weights:
        q, r = divmod(total * w, wsum)
        shares.append(q)
        rems.append(r)
    left = total - sum(shares)
    order = sorted(range(len(weights)), key=lambda i: (-rems[i], i))
    for i in order[:left]:
        shares[i] += 1
    return shares


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def need_int(v, lo=None, hi=None):
    if not is_int(v):
        raise Invalid("not an integer: %r" % (v,))
    if lo is not None and v < lo:
        raise Invalid("below range: %r" % (v,))
    if hi is not None and v > hi:
        raise Invalid("above range: %r" % (v,))
    return v


MONEY_MAX = 100000000000  # 1,000,000,000.00 in minor units (I-01)


# ---------------------------------------------------------------- allocation

def parse_platform_fee(pf):
    """C-ALL-9b settings (v0.9). None = no platform fee."""
    if pf is None:
        return None
    if not isinstance(pf, dict):
        raise Invalid("platformFee")
    rate = need_int(pf.get("rate"), 0, BP)
    mn = need_int(pf.get("minimum", 0) if pf.get("minimum") is not None else 0, 0, MONEY_MAX)
    mx = pf.get("maximum")
    if mx is not None:
        need_int(mx, 0, MONEY_MAX)
        if mn > mx:
            raise Invalid("platform fee minimum > maximum")
    thr = pf.get("addOnThreshold")
    add = pf.get("addOnRate")
    if thr is not None:
        need_int(thr, 0, MONEY_MAX)
        need_int(add, 0, BP)
    else:
        if add not in (None, 0):
            raise Invalid("add-on rate without threshold")
        add = 0
    payer = pf.get("payer")
    if payer not in ("investors", "lead", "company"):
        raise Invalid("platform fee payer")
    return {"rate": rate, "minimum": mn, "maximum": mx, "threshold": thr, "addOn": add, "payer": payer}


def platform_fee_amount(pf, B):
    """C-ALL-9b: halfUp(min(max, max(min, B x rate))) + halfUp(max(0, B - threshold) x add-on rate);
    each part rounded separately."""
    first = max(Fraction(pf["minimum"]), Fraction(B * pf["rate"], BP))
    if pf["maximum"] is not None:
        first = min(Fraction(pf["maximum"]), first)
    second = 0
    if pf["threshold"] is not None:
        second = half_up(Fraction(max(0, B - pf["threshold"]) * pf["addOn"], BP))
    return half_up(first) + second


def parse_own_terms(t, iid):
    """C-ALL-0: returns (mode, p, F, kind) where kind is 'percent' | 'fixed' | None."""
    if not isinstance(t, dict):
        raise Invalid("ownTerms")
    mode = t.get("mode")
    if mode not in ("deducted", "onTop"):
        raise Invalid("own fee mode")
    fee = t.get("fee")
    if fee is None:
        return (mode, 0, 0, None)
    kind = fee.get("kind")
    if kind == "percent":
        f = need_int(fee.get("value"), 0, BP)
        if mode == "deducted" and f >= BP:
            raise Invalid("own rate >= 100% deducted", code="own-rate-100", investor=iid)
        return (mode, f, 0, "percent")
    if kind == "fixed":
        return (mode, 0, need_int(fee.get("value"), 1, MONEY_MAX), "fixed")
    raise Invalid("own fee kind")


def allocation(case):
    investors = case.get("investors") or []
    extended = ("instrument" in case or "platformFee" in case
                or any(isinstance(inv, dict) and "ownTerms" in inv for inv in investors))
    basis = case.get("feeBasis")
    if basis not in ("deducted", "onTop"):
        raise Invalid("feeBasis")
    minimum = case.get("minimum", 0)
    if minimum is None:
        minimum = 0
    need_int(minimum, 0, MONEY_MAX)
    cap = case.get("cap")
    if cap is not None:
        need_int(cap, 1, MONEY_MAX)
    instrument = case.get("instrument", "equity")
    if instrument == "equity":
        price = need_int(case.get("priceMicros"), 1, 1000000 * 1000000)
    elif instrument in ("convertible", "fund_units"):
        if case.get("priceMicros") is not None:  # R-DEAL-06
            raise Invalid("share price must be empty", code="share-price-not-empty")
        price = None
    else:
        raise Invalid("instrument")

    fees = case.get("fees") or []
    if len(fees) > 20:
        raise Invalid("more than 20 fees (I-08)")
    fee_ids = set()
    for f in fees:
        fid = f.get("id")
        if not isinstance(fid, str) or fid in fee_ids:
            raise Invalid("fee id")
        fee_ids.add(fid)
        kind, payer, value = f.get("kind"), f.get("payer"), f.get("value")
        if payer == "investors":
            if kind not in ("percent", "perInvestor"):
                raise Invalid("fee combination")
        elif payer in ("company", "lead"):
            if kind not in ("percent", "fixed"):
                raise Invalid("fee combination")
        else:
            raise Invalid("fee payer")
        if kind == "percent":
            need_int(value, 0, BP)
        else:
            need_int(value, 1, MONEY_MAX)

    inv_pct = [f for f in fees if f["payer"] == "investors" and f["kind"] == "percent"]
    inv_fix = [f for f in fees if f["payer"] == "investors" and f["kind"] == "perInvestor"]
    inv_fee_ids = [f["id"] for f in fees if f["payer"] == "investors"]
    p_deal = sum(f["value"] for f in inv_pct)
    F_deal = sum(f["value"] for f in inv_fix)
    if basis == "deducted" and p_deal >= BP:
        raise Invalid("investor percent fees >= 100% on deducted basis")
    pf = parse_platform_fee(case.get("platformFee"))

    if len(investors) > 500:
        raise Invalid("more than 500 investors (I-08)")
    ids = set()
    terms = {}  # id -> (mode, p, F, own, ownKind)
    for inv in investors:
        if not isinstance(inv.get("id"), str) or inv["id"] in ids:
            raise Invalid("investor id")
        ids.add(inv["id"])
        need_int(inv.get("received"), 0, MONEY_MAX)
        if inv.get("scheme", "none") not in ("none", "SEIS", "EIS"):
            raise Invalid("scheme")
        if inv.get("ownTerms") is not None:
            mode, p_i, F_i, k_i = parse_own_terms(inv["ownTerms"], inv["id"])
            terms[inv["id"]] = (mode, p_i, F_i, True, k_i)
        else:
            terms[inv["id"]] = (basis, p_deal, F_deal, False, None)

    def M_of_R(iid, R):
        mode, p, F = terms[iid][:3]
        if mode == "deducted":
            return floor_frac(Fraction((R - F) * (BP - p), BP))
        return floor_frac(Fraction((R - F) * BP, BP + p))

    # C-ALL-1 / C-ALL-2 (each person's own mode, p, F: C-ALL-0)
    M_of = {}
    exclusion = {}
    for inv in investors:
        iid, R = inv["id"], inv["received"]
        mode, p, F = terms[iid][:3]
        if R == 0:
            exclusion[iid] = "no-funds"
            continue
        if R <= F:
            exclusion[iid] = "fees-exceed-receipt"
            continue
        M = M_of_R(iid, R)
        if M <= 0:  # format v1 §3: M <= 0 under C-ALL-1 counts as fees-exceed-receipt
            exclusion[iid] = "fees-exceed-receipt"
            continue
        amt = R if mode == "deducted" else M
        if amt < minimum:
            exclusion[iid] = "below-minimum"
            continue
        M_of[iid] = M

    part_ids = [inv["id"] for inv in investors if inv["id"] in M_of]
    blockers = set()
    bl_ids = {}

    def block(code, iid=None):
        blockers.add(code)
        lst = bl_ids.setdefault(code, [])
        if iid is not None and iid not in lst:
            lst.append(iid)

    # C-ALL-3 (v0.9: commitment basis per person, exact fractions)
    T_of = dict(M_of)
    msum = sum(M_of.values())
    if cap is not None and msum > cap:
        split = largest_remainder(cap, [M_of[i] for i in part_ids])
        T_of = dict(zip(part_ids, split))
        for i in part_ids:
            T = T_of[i]
            mode, p, F = terms[i][:3]
            if mode == "deducted":
                amt = Fraction(T * BP, BP - p) + F
            else:
                amt = Fraction(T)
            if amt < minimum:
                block("scale-back-below-minimum", i)

    def person_fees(iid, I):
        """C-ALL-4 / C-ALL-6 for one person; I = T before the platform fee."""
        mode, p, F, own, kind = terms[iid]

        def pct(rate):
            if mode == "deducted":
                return half_up(Fraction(I * rate, BP - p))
            return half_up(Fraction(I * rate, BP))
        if own:
            if kind == "percent":
                return {"__own__": pct(p)}
            return {"__own__": F}
        fmap = {}
        for f in fees:
            if f["payer"] != "investors":
                continue
            fmap[f["id"]] = pct(f["value"]) if f["kind"] == "percent" else f["value"]
        return fmap

    res_of = {}
    for inv in investors:
        iid, R = inv["id"], inv["received"]
        if iid not in T_of:
            continue
        I = T_of[iid]
        res = None
        while I > 0:  # C-ALL-7
            fmap = person_fees(iid, I)
            refund = R - I - sum(fmap.values())
            if refund >= 0:
                res = (I, fmap, refund)
                break
            I -= 1
        if res is None:
            exclusion[iid] = "zero-investment"
        else:
            res_of[iid] = res
    final_ids = [i for i in part_ids if i in res_of]

    # C-ALL-9b platform fee (v0.9)
    B = sum(res_of[i][0] for i in final_ids)
    pf_amount = None
    S_of = {i: 0 for i in final_ids}
    pf_blocked = False
    if pf is not None and B > 0:
        pf_amount = platform_fee_amount(pf, B)
        if pf["payer"] == "investors":
            shares = largest_remainder(pf_amount, [res_of[i][0] for i in final_ids])
            S_of = dict(zip(final_ids, shares))
            if pf_amount > B or any(S_of[i] >= res_of[i][0] for i in final_ids):
                pf_blocked = True
                block("platform-fee-exceeds")
                for i in final_ids:
                    if S_of[i] >= res_of[i][0]:
                        block("platform-fee-exceeds", i)

    out_inv = {}
    total_invested = 0
    fee_totals = {f["id"]: 0 for f in fees}
    own_fee_total = 0
    refund_total = 0
    n_part = 0
    for inv in investors:
        iid, R = inv["id"], inv["received"]
        own = terms[iid][3]
        if iid not in res_of:
            refund_total += R
            out_inv[iid] = {
                "participating": False, "invested": 0, "fees": {}, "refund": R,
                "microShares": 0 if price else None, "claimableShares": 0 if price else None,
                "claimableAmount": 0 if price else None,
            }
            if extended:
                out_inv[iid].update({"target": 0, "ownFee": 0 if own else None, "platformFeeShare": 0,
                                     "exclusion": exclusion[iid]})
            continue
        T, fmap, refund = res_of[iid]
        S = S_of[iid]
        I = T - S
        n_part += 1
        total_invested += I
        refund_total += refund
        own_fee = None
        for k, v in fmap.items():
            if k == "__own__":
                own_fee = v
                own_fee_total += v
            else:
                fee_totals[k] += v
        if price is None:
            ms = cs = ca = None
        elif I <= 0:
            ms = cs = ca = 0
        else:
            cs = (I * BP) // price
            ms = (I * BP * 1000000) // price
            ca = (cs * price) // BP
        out_inv[iid] = {
            "participating": True,
            "invested": I,
            "fees": {} if own else {k: fmap[k] for k in inv_fee_ids},
            "refund": refund,
            "microShares": ms,
            "claimableShares": cs,
            "claimableAmount": ca,
        }
        if extended:
            out_inv[iid].update({"target": T, "ownFee": own_fee, "platformFeeShare": S, "exclusion": None})

    # C-ALL-9a (not computed when the platform fee blocks)
    company_fees = 0
    lead_invoice = 0
    wire = None
    if pf_blocked:
        for f in fees:
            if f["payer"] != "investors":
                fee_totals[f["id"]] = None
        company_fees = lead_invoice = None
    else:
        for f in fees:
            if f["payer"] == "investors":
                continue
            amt = half_up(Fraction(total_invested * f["value"], BP)) if f["kind"] == "percent" else f["value"]
            fee_totals[f["id"]] = amt
            if f["payer"] == "company":
                company_fees += amt
            else:
                lead_invoice += amt
        if pf_amount is not None and pf["payer"] == "company":
            company_fees += pf_amount
        if pf_amount is not None and pf["payer"] == "lead":
            lead_invoice += pf_amount
        wire = total_invested - company_fees
        if wire < 0:
            block("company-fees-exceed")
    if n_part == 0:
        block("no-participants")

    # arithmetic check (C-ALL-9b): sum R = sum I + cash fees + investor platform fee + refunds
    received_total = sum(inv["received"] for inv in investors)
    cash_fees = own_fee_total + sum(v for k, v in fee_totals.items() if k in inv_fee_ids)
    inv_pf = pf_amount if (pf_amount is not None and pf["payer"] == "investors") else 0
    if received_total != total_invested + cash_fees + inv_pf + refund_total:
        raise ArithmeticFail("allocation identity")

    out = {
        "ok": True,
        "investors": out_inv,
        "feeTotals": fee_totals,
        "totalInvested": total_invested,
        "companyFees": company_fees,
        "leadInvoice": lead_invoice,
        "wire": wire,
        "blockers": sorted(blockers),
    }
    if extended:
        out.update({
            "blockerIds": {k: bl_ids.get(k, []) for k in sorted(blockers)},
            "platformFee": None if pf_amount is None else {"amount": pf_amount, "base": B, "payer": pf["payer"]},
            "received": received_total,
            "investorFees": cash_fees,
            "refunds": refund_total,
        })
    return out


# ---------------------------------------------------------------- fee payer change (C-ALL-10, v0.8)

class ArithmeticFail(Exception):
    """C-03 'arithmetic check failed' (internal error): never caught by run()."""


def _alloc_case(case, fees, investors, minimum=None, cap="same", platform=True):
    out = {
        "kind": "allocation", "feeBasis": case.get("feeBasis"),
        "minimum": case.get("minimum", 0) if minimum is None else minimum,
        "cap": case.get("cap") if cap == "same" else cap,
        "priceMicros": case.get("priceMicros"), "fees": fees,
        "investors": investors,
    }
    # v0.9: instrument and (in steps 1 and 3 only) the pro-rata platform fee pass through
    if "instrument" in case:
        out["instrument"] = case["instrument"]
    if platform and "platformFee" in case:
        out["platformFee"] = case["platformFee"]
    return out


def _target(v):
    """T before the platform fee (v0.9 C-ALL-10); equals `invested` for old inputs."""
    return v.get("target", v["invested"])


def single_invested(case, fees, R):
    """I(R): C-ALL-1, C-ALL-4, C-ALL-6, C-ALL-7 for one investor under `fees`,
    ignoring cap and minimum (minimum 0, no cap). Reuses allocation()."""
    out = allocation(_alloc_case(case, fees, [{"id": "x", "received": R, "scheme": "none"}], minimum=0, cap=None,
                                 platform=False))
    return out["investors"]["x"]["invested"]


def ceil_frac(x):
    return -((-Fraction(x)).__floor__())


def new_cash_due(case, fees2, T):
    """Smallest whole-penny R with I(R) >= T under fees2 (C-ALL-10 step 2).

    Own derivation: I(R) <= M(R) (C-ALL-7 only lowers I) and M(R) is non-decreasing in R.
    deducted: M(R) = floor((R - F')(1 - p')) >= T  <=>  R >= F' + T/(1 - p')  <=>  R >= F' + ceil(T/(1 - p')).
    onTop:    M(R) = floor((R - F')/(1 + p')) >= T  <=>  R >= F' + T(1 + p')  <=>  R >= F' + ceil(T(1 + p')).
    So no R below R0 can give I(R) >= T; scan upward from R0 (each R checked with the full
    single-investor allocation), which therefore yields the minimum."""
    inv_pct = sum(f["value"] for f in fees2 if f["payer"] == "investors" and f["kind"] == "percent")
    inv_fix = sum(f["value"] for f in fees2 if f["payer"] == "investors" and f["kind"] == "perInvestor")
    if case.get("feeBasis") == "deducted":
        R = inv_fix + ceil_frac(Fraction(T * BP, BP - inv_pct))
    else:
        R = inv_fix + ceil_frac(Fraction(T * (BP + inv_pct), BP))
    for _ in range(100000):
        if R > MONEY_MAX:
            raise Invalid("new cash due above I-01 limit")
        I = single_invested(case, fees2, R)
        if I >= T:
            if I != T:  # PRD C-ALL-10: always exact; otherwise C-03 arithmetic failure
                raise ArithmeticFail("I(N) = %d != T = %d" % (I, T))
            return R
        R += 1
    raise ArithmeticFail("no N found within 100000 pence of the lower bound")


def fee_payer_change(case):
    fees = case.get("fees") or []
    fee_id = case.get("feeId")
    new_payer = case.get("newPayer")
    sel = [f for f in fees if f.get("id") == fee_id]
    if len(sel) != 1 or sel[0].get("kind") != "percent":
        raise Invalid("selected fee must be one percent fee")
    if new_payer not in ("investors", "company", "lead"):
        raise Invalid("new payer")
    applied = case.get("applied")
    if applied is None and sel[0].get("payer") == new_payer:
        raise Invalid("new payer equals current payer")
    fees2 = [dict(f, payer=new_payer) if f.get("id") == fee_id else f for f in fees]

    investors = case.get("investors") or []
    # v0.9 R-ALL-12.1: unavailable when anyone in scope has own fee terms (carry alone does not count)
    if any(isinstance(inv, dict) and inv.get("ownTerms") is not None for inv in investors):
        return {"ok": True, "disabled": "own-fee-terms"}
    ids = []
    for inv in investors:
        iid = inv.get("id")
        if not isinstance(iid, str) or iid in ids:
            raise Invalid("investor id")
        ids.append(iid)
        need_int(inv.get("cashDue"), 1, MONEY_MAX)
    due = {inv["id"]: inv["cashDue"] for inv in investors}
    scheme = {inv["id"]: inv.get("scheme", "none") for inv in investors}

    # input validation of Fees and Fees' (R-ALL-01/02); raises Invalid -> ok:false
    allocation(_alloc_case(case, fees, []))
    allocation(_alloc_case(case, fees2, []))

    blockers = set()
    fee_before = None
    if applied is None:
        # step 1: commitment allocation under Fees with R = cash due
        a1 = allocation(_alloc_case(case, fees, [{"id": i, "received": due[i], "scheme": scheme[i]} for i in ids]))
        part1 = {i: a1["investors"][i]["participating"] for i in ids}
        fee_before = a1["feeTotals"][fee_id]
        for b in a1["blockers"]:
            blockers.add(("before-" + b, ""))
        # C-ALL-3: the round is scaled back iff the participants' M (C-ALL-1/2) sum exceeds the cap
        m_sum = sum(_m_of(case, fees, due[i]) for i in ids if _m_of_participates(case, fees, due[i]))
        if case.get("cap") is not None and m_sum > case["cap"]:
            blockers.add(("over-cap", ""))
        target = {i: _target(a1["investors"][i]) for i in ids if part1[i]}
    else:
        tg = applied.get("targets") or {}
        nd = applied.get("newCashDue") or {}
        if set(tg) != set(nd) or not set(tg) <= set(ids):
            raise Invalid("applied targets / newCashDue")
        for i in tg:
            need_int(tg[i], 1, MONEY_MAX)
            need_int(nd[i], 1, MONEY_MAX)
        part1 = {i: i in tg for i in ids}
        target = dict(tg)

    out_inv = {}
    step1_ok = not blockers
    if not step1_ok:
        for i in ids:
            out_inv[i] = {"cashDue": due[i], "participatingBefore": part1[i], "unchanged": None, "target": None,
                          "newCashDue": None, "difference": None, "participatingAfter": None, "investedAfter": None}
        return _fpc_out(blockers, out_inv, ids, due, fee_before, None, False)

    # step 2
    N = {}
    for i in ids:
        if part1[i]:
            N[i] = new_cash_due(case, fees2, target[i]) if applied is None else applied["newCashDue"][i]
        else:
            N[i] = due[i]
    # step 3
    a3 = allocation(_alloc_case(case, fees2, [{"id": i, "received": N[i], "scheme": scheme[i]} for i in ids]))
    for b in a3["blockers"]:
        blockers.add(("after-" + b, ""))
    F2 = sum(f["value"] for f in fees2 if f["payer"] == "investors" and f["kind"] == "perInvestor")
    minimum = case.get("minimum", 0) or 0
    for i in ids:
        v = a3["investors"][i]
        if part1[i] and not v["participating"]:
            if N[i] > F2:
                M = _m_of(case, fees2, N[i])
                basis_amt = N[i] if case["feeBasis"] == "deducted" else M
                below = M > 0 and basis_amt < minimum
            else:
                below = False
            blockers.add(("would-fall-below-minimum" if below else "would-leave", i))
        elif not part1[i] and v["participating"]:
            blockers.add(("would-join", i))
        elif part1[i] and _target(v) != target[i]:
            blockers.add(("invested-differs", i))
        out_inv[i] = {
            "cashDue": due[i], "participatingBefore": part1[i], "unchanged": not part1[i],
            "target": target[i] if part1[i] else None, "newCashDue": N[i], "difference": N[i] - due[i],
            "participatingAfter": v["participating"], "investedAfter": v["invested"],
        }
        if "target" in v:  # v0.9 extended allocation: also report step-3 T before the platform fee
            out_inv[i]["targetAfter"] = v["target"]
    return _fpc_out(blockers, out_inv, ids, due, fee_before, a3["feeTotals"][fee_id], True)


def _m_of(case, fees, R):
    """M of C-ALL-1 (before rounding adjustments of C-ALL-7); 0 when R <= F."""
    p = sum(f["value"] for f in fees if f["payer"] == "investors" and f["kind"] == "percent")
    F = sum(f["value"] for f in fees if f["payer"] == "investors" and f["kind"] == "perInvestor")
    if R <= F:
        return 0
    if case["feeBasis"] == "deducted":
        return floor_frac(Fraction((R - F) * (BP - p), BP))
    return floor_frac(Fraction((R - F) * BP, BP + p))


def _m_of_participates(case, fees, R):
    """C-ALL-1/C-ALL-2 participation (the set whose M is summed in C-ALL-3)."""
    M = _m_of(case, fees, R)
    if M <= 0:
        return False
    amt = R if case["feeBasis"] == "deducted" else M
    return amt >= (case.get("minimum", 0) or 0)


def _fpc_out(blockers, out_inv, ids, due, fee_before, fee_after, computed):
    bl = [{"code": c, "investor": (i or None)} for c, i in sorted(blockers)]
    tot = {"cashDue": sum(due[i] for i in ids), "newCashDue": None, "difference": None,
           "topUpCount": None, "topUpTotal": None, "refundCount": None, "refundTotal": None}
    if computed:
        diffs = [out_inv[i]["difference"] for i in ids]
        tot.update({
            "newCashDue": sum(out_inv[i]["newCashDue"] for i in ids), "difference": sum(diffs),
            "topUpCount": sum(1 for d in diffs if d > 0), "topUpTotal": sum(d for d in diffs if d > 0),
            "refundCount": sum(1 for d in diffs if d < 0), "refundTotal": -sum(d for d in diffs if d < 0),
        })
    return {"ok": True, "canApply": not bl, "blockers": bl, "investors": out_inv,
            "feeBefore": fee_before, "feeAfter": fee_after, "totals": tot}


# ---------------------------------------------------------------- waterfall

def hurdle_amount(C, h, n100):
    """halfUp(C * ((1 + h/1e4)^(n100/100) - 1)), exact.
    Whole years: exact Fraction power. Fractional years n = a/b: x = (base^a)^(1/b);
    estimate with 60-digit Decimal, then fix the integer m with exact tests
    (1 + (m - 1/2)/C)^b <= base^a < (1 + (m + 1/2)/C)^b."""
    base = Fraction(BP + h, BP)
    n = Fraction(n100, 100)
    if n.denominator == 1:
        return half_up(C * (base ** n.numerator - 1))
    a, b = n.numerator, n.denominator
    target = base ** a
    ctx = getcontext().copy()
    ctx.prec = 60
    est = ctx.power(ctx.divide(Decimal(BP + h), Decimal(BP)), ctx.divide(Decimal(a), Decimal(b)))
    m = int(ctx.multiply(Decimal(C), ctx.subtract(est, Decimal(1))).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    m = max(m, 0)

    def lo_ok(m_):  # x >= 1 + (m_ - 1/2)/C
        t = 1 + Fraction(2 * m_ - 1, 2 * C)
        return t <= 0 or t ** b <= target

    def hi_ok(m_):  # x < 1 + (m_ + 1/2)/C
        return target < (1 + Fraction(2 * m_ + 1, 2 * C)) ** b

    while not lo_ok(m):
        m -= 1
    while not hi_ok(m):
        m += 1
    return m


def _fixed_steps(C, D, k, h, c, n100):
    """C-DIS-1..5 fixed mode on capital C and distributable D; returns
    (returnOfCapital, hurdlePaid, catchUpTranche, catchUpToLead, carry)."""
    roc = min(D, C)
    profit = D - roc
    hurdle_paid = tranche = to_lead_cu = 0
    remaining = profit
    if h > 0 and profit > 0:
        P = hurdle_amount(C, h, n100)
        hurdle_paid = min(remaining, P)
        remaining -= hurdle_paid
        if c > 0 and k > 0:  # v0.9 C-DIS-8: k_i = 0 skips catch-up (for old inputs k > 0 whenever c > 0)
            Y = half_up(Fraction(k * hurdle_paid, c - k))
            tranche = min(remaining, Y)
            to_lead_cu = half_up(Fraction(tranche * c, BP))
            remaining -= tranche
    carry = to_lead_cu + half_up(Fraction(remaining * k, BP))
    return roc, hurdle_paid, tranche, to_lead_cu, carry


def _payees(case, K):
    """C-DIS-9: split K by payee shares (largest remainder, ties to the earlier payee)."""
    payees = case.get("payees")
    if payees is None:
        return [{"name": "Lead", "amount": K}]
    if not isinstance(payees, list) or not 1 <= len(payees) <= 20:
        raise Invalid("payees", code="payee-count")
    for py in payees:
        name = py.get("name")
        if not isinstance(name, str) or not 1 <= utf16_len(name) <= 120:
            raise Invalid("payee name", code="payee-name")
        need_int(py.get("share"), 0, BP)
        if py["share"] <= 0:
            raise Invalid("payee share 0", code="payee-share-zero")
    if sum(py["share"] for py in payees) != BP:
        raise Invalid("Payee shares must add up to 100%", code="payee-sum")
    split = largest_remainder(K, [py["share"] for py in payees])
    return [{"name": py["name"], "amount": v} for py, v in zip(payees, split)]


def utf16_len(s):
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def waterfall(case):
    holdings = case.get("holdings") or []
    extended = "payees" in case or any(isinstance(hh, dict) and "carry" in hh for hh in holdings)
    ids = set()
    for h in holdings:
        if not isinstance(h.get("id"), str) or h["id"] in ids:
            raise Invalid("holding id")
        ids.add(h["id"])
        need_int(h.get("capital"), 1, MONEY_MAX)
        if h.get("carry") is not None:
            need_int(h["carry"], 0, BP)
    C = sum(h["capital"] for h in holdings)
    if C <= 0:
        raise Invalid("total capital must be > 0")
    G = need_int(case.get("proceeds"), 0, MONEY_MAX)
    E = case.get("exitCosts", 0)
    if E is None:
        E = 0
    need_int(E, 0, MONEY_MAX)
    n100 = need_int(case.get("years100"), 0, 5000)

    own = [hh.get("carry") for hh in holdings]
    carry_cfg = case.get("carry") or {}
    mode = carry_cfg.get("mode")
    per_k = None          # list of k_i when C-DIS-8 applies
    tiered_notice = None  # C-DIS-8 first bullet
    if mode == "fixed":
        if "tiers" in carry_cfg:
            raise Invalid("tiers in fixed mode")
        k_deal = need_int(carry_cfg.get("k"), 0, BP)
        h = carry_cfg.get("h", 0)
        c = carry_cfg.get("c", 0)
        h = 0 if h is None else h
        c = 0 if c is None else c
        need_int(h, 0, BP)
        need_int(c, 0, BP)
        if h == 0 and c != 0:
            raise Invalid("catch-up without hurdle")
        used = [k_deal if x is None else x for x in own]  # blanks -> deal k (C-DIS preamble)
        if len(set(used)) <= 1:
            k = used[0] if used else k_deal
            if h > 0 and c > 0 and not (k < c <= BP):
                raise Invalid("catch-up must satisfy k < c <= 100%")
        else:
            per_k = used
            if h > 0 and c > 0:
                for hh, ki in zip(holdings, used):  # C-DIS-8: per person, only k_i > 0
                    if ki > 0 and not (ki < c <= BP):
                        raise Invalid("catch-up must satisfy k_i < c", code="catch-up-k", investor=hh["id"])
    elif mode == "tiered":
        for key in ("k", "h", "c"):
            if carry_cfg.get(key) is not None:
                raise Invalid("fixed-mode field in tiered mode")
        tiers = carry_cfg.get("tiers")
        if not isinstance(tiers, list) or not tiers:
            raise Invalid("tiers")
        prev = 100
        for idx, t in enumerate(tiers):
            need_int(t.get("rate"), 0, BP)
            up = t.get("upTo100")
            last = idx == len(tiers) - 1
            if last:
                if up is not None:
                    raise Invalid("last tier must be unbounded")
            else:
                need_int(up)
                if up <= prev:
                    raise Invalid("tier multiples must strictly increase and be > 1")
                prev = up
        filled = [x for x in own if x is not None]
        if filled and len(filled) != len(own):
            raise Invalid("Fill in every investor's carry, or none, for tiered carry", code="tiered-carry-mixed")
        if filled and len(set(filled)) > 1:
            raise Invalid("Tiered carry needs the same carry for every investor", code="tiered-carry-differs")
        if filled:
            tiered_notice = filled[0]
    else:
        raise Invalid("carry mode")

    def finish(out, K, carry_used):
        if extended:
            out["payees"] = _payees(case, K)
            out["perInvestor"] = out.get("perInvestor")
            out["tieredNotice"] = tiered_notice
            out["carryUsed"] = carry_used
        return out

    # carry column of the exit CSV (§5.5): fixed mode and someone filled a carry -> k actually used
    carry_used = None
    if mode == "fixed" and any(x is not None for x in own):
        carry_used = {hh["id"]: ki for hh, ki in zip(holdings, [k_deal if x is None else x for x in own])}

    zero = {
        "ok": True, "blockers": [], "shortfall": 0, "costsPaid": 0,
        "returnOfCapital": 0, "hurdlePaid": 0, "catchUpTranche": 0,
        "catchUpToLead": 0, "carry": 0, "investorsTotal": 0,
        "distributions": {hh["id"]: 0 for hh in holdings},
    }
    if E > G:
        zero["blockers"] = ["exit-cost-shortfall"]
        zero["shortfall"] = E - G
        zero["costsPaid"] = G
        if extended:
            zero["perInvestor"] = None
            out = finish(zero, 0, carry_used)
            out["payees"] = None
            return out
        return zero

    D = G - E
    if per_k is not None:
        # C-DIS-8: split D by capital, then each person's own fixed waterfall with the deal's h, n, c
        Ds = largest_remainder(D, [hh["capital"] for hh in holdings])
        per = {}
        tot = [0, 0, 0, 0, 0]
        dist = {}
        for hh, Di, ki in zip(holdings, Ds, per_k):
            r = _fixed_steps(hh["capital"], Di, ki, h, c, n100)
            tot = [a + b for a, b in zip(tot, r)]
            dist[hh["id"]] = Di - r[4]
            per[hh["id"]] = {"distributable": Di, "k": ki, "returnOfCapital": r[0], "hurdlePaid": r[1],
                             "catchUpTranche": r[2], "catchUpToLead": r[3], "carry": r[4],
                             "distribution": Di - r[4]}
        out = {
            "ok": True, "blockers": [], "shortfall": 0, "costsPaid": E,
            "returnOfCapital": tot[0], "hurdlePaid": tot[1], "catchUpTranche": tot[2],
            "catchUpToLead": tot[3], "carry": tot[4], "investorsTotal": D - tot[4],
            "distributions": dist, "perInvestor": per,
        }
        return finish(out, tot[4], carry_used)

    roc = min(D, C)
    profit = D - roc
    hurdle_paid = 0
    tranche = 0
    to_lead_cu = 0
    carry = 0

    if mode == "fixed":
        roc, hurdle_paid, tranche, to_lead_cu, carry = _fixed_steps(C, D, k, h, c, n100)
    else:
        prev_b = 0
        for idx, t in enumerate(tiers):
            if t["upTo100"] is None:
                band = max(profit - prev_b, 0)
            else:
                b = half_up(Fraction((t["upTo100"] - 100) * C, 100))
                band = min(max(profit - prev_b, 0), b - prev_b)
                prev_b = b
            carry += half_up(Fraction(band * t["rate"], BP))

    investors_total = D - carry
    split = largest_remainder(investors_total, [hh["capital"] for hh in holdings])
    out = {
        "ok": True, "blockers": [], "shortfall": 0, "costsPaid": E,
        "returnOfCapital": roc, "hurdlePaid": hurdle_paid,
        "catchUpTranche": tranche, "catchUpToLead": to_lead_cu,
        "carry": carry, "investorsTotal": investors_total,
        "distributions": {hh["id"]: v for hh, v in zip(holdings, split)},
    }
    if extended:
        out["perInvestor"] = None
    return finish(out, carry, carry_used)


# ---------------------------------------------------------------- reconcile

STOP = {"MR", "MRS", "MS", "DR", "LTD", "LIMITED", "LLP", "PLC", "AND", "THE"}


INVESTOR_REF = re.compile(r"[A-Za-z0-9]+(?:[ \-/_.][A-Za-z0-9]+){0,2}")


def norm_ref(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


ASCII_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def ascii_upper(s):
    """Upper-case only a-z (PRD v0.7.2); no other case mapping."""
    return (s or "").translate(ASCII_UPPER)


def tokens(s):
    """Separators are only ASCII chars other than A-Z/a-z/0-9 (PRD v0.7.2);
    every non-ASCII code point is part of a token."""
    out, cur = [], []
    for ch in ascii_upper(s):
        if ord(ch) > 127 or ch.isalnum():  # ASCII alnum or any non-ASCII char
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def concats(toks):
    out = []
    for i in range(len(toks)):
        for L in (1, 2, 3):
            if i + L <= len(toks):
                out.append("".join(toks[i:i + L]))
    return out


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def digits_int(s):
    d = "".join(ch for ch in (s or "") if "0" <= ch <= "9")  # ASCII digits only
    return int(d) if d else None


def name_words(s):
    s = "".join(ch if (ord(ch) > 127 or "A" <= ch <= "Z") else " " for ch in ascii_upper(s))
    return [w for w in s.split(" ") if w and w not in STOP]


def word_ok(a, b):
    if a == b:
        return True
    if len(a) == 1 and b[0] == a:
        return True
    if len(b) == 1 and a[0] == b:
        return True
    return False


def max_matching(A, B):
    match_b = [-1] * len(B)

    def try_a(i, seen):
        for j in range(len(B)):
            if j in seen or not word_ok(A[i], B[j]):
                continue
            seen.add(j)
            if match_b[j] == -1 or try_a(match_b[j], seen):
                match_b[j] = i
                return True
        return False

    return sum(1 for i in range(len(A)) if try_a(i, set()))


def name_similarity(a, b):
    A, B = name_words(a), name_words(b)
    if not A or not B:
        return Fraction(0)
    return Fraction(max_matching(A, B), max(len(A), len(B)))


def parse_date(s):
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    raise Invalid("date %r" % (s,))


def score_out(fr):
    q = (Decimal(fr.numerator) / Decimal(fr.denominator)).quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return float(q)


def reconcile(case):
    as_of = parse_date(case["asOf"])
    threshold = case.get("thresholdDays", 10)
    commitments = case.get("commitments") or []
    lines = case.get("lines") or []
    decisions = case.get("decisions") or {}
    if len(commitments) > 500 or len(lines) > 2000:
        raise Invalid("size limits (I-08)")
    for c in commitments:
        ref = c.get("reference")
        if not isinstance(ref, str) or not INVESTOR_REF.fullmatch(ref):
            raise Invalid("investor reference %r" % (ref,))
    cnorm = [norm_ref(c.get("reference")) for c in commitments]
    if any(not 3 <= len(x) <= 20 for x in cnorm) or len(set(cnorm)) != len(cnorm):
        raise Invalid("normalised reference length 3-20 and unique")
    cdigits = [digits_int(c.get("reference")) for c in commitments]

    # v0.8 (C-REC-7, C-ALL-11): optional withdrawn ids and effective cash due
    extended = "withdrawn" in case or "adjustedCashDue" in case
    cids = [c.get("id") for c in commitments]
    withdrawn = case.get("withdrawn") or []
    adjusted = case.get("adjustedCashDue") or {}
    if not isinstance(withdrawn, list) or len(set(withdrawn)) != len(withdrawn) or not set(withdrawn) <= set(cids):
        raise Invalid("withdrawn ids")
    if not isinstance(adjusted, dict) or not set(adjusted) <= set(cids):
        raise Invalid("adjustedCashDue ids")
    for v in adjusted.values():
        need_int(v, 1, MONEY_MAX)
    withdrawn = set(withdrawn)

    # v0.9 (C-REC-4, C-REC-9): optional per-commitment `refunded` and `refundOnly`
    v09 = any("refunded" in c or "refundOnly" in c for c in commitments)
    if v09:
        extended = True
    refunded = {}
    refund_only = {}
    for c in commitments:
        rf = c.get("refunded")
        refunded[c["id"]] = 0 if rf is None else need_int(rf, 0, MONEY_MAX)
        ro = c.get("refundOnly")
        if ro not in (None, "withdrawn", "closed"):
            raise Invalid("refundOnly")
        refund_only[c["id"]] = ro
    # a refund_only flag overrides the manual withdrawal while it exists (C-REC-9)
    manual_w = {cid for cid in withdrawn if refund_only.get(cid) is None}
    out_of_scope = manual_w | {cid for cid in cids if refund_only.get(cid)}

    def eff_due(c):
        return adjusted.get(c["id"], c["cashDue"])

    # suspected duplicates: no txnId, identical (date, amount, payer, reference)
    keyc = {}
    for ln in lines:
        if ln.get("txnId") is None:
            key = (ln.get("date"), ln.get("amount"), ln.get("payer"), ln.get("reference"))
            keyc[key] = keyc.get(key, 0) + 1

    def is_dup(ln):
        if ln.get("txnId") is not None:
            return False
        return keyc[(ln.get("date"), ln.get("amount"), ln.get("payer"), ln.get("reference"))] > 1

    info = {}
    # pass 1: skipped / future / decisions / auto
    for ln in lines:
        lid = ln["id"]
        d = parse_date(ln["date"])
        dup = is_dup(ln)
        rec = {"status": None, "assignedTo": None, "suspectedDuplicate": dup,
               "candidates": [], "_date": d}
        info[lid] = rec
        if ln["amount"] <= 0:
            rec["status"] = "skipped"
            continue
        if d > as_of:
            rec["status"] = "future"
            continue
        dec = decisions.get(lid)
        if dec is not None:
            if dec.get("reject"):
                rec["status"] = "rejected"
            else:
                rec["status"] = "confirmed"
                rec["assignedTo"] = dec["assign"]
            continue
        cc = set(concats(tokens(ln.get("reference"))))
        exact = [i for i, nr in enumerate(cnorm) if nr in cc]
        rec["_exact"] = exact
        rec["_cc"] = cc
        if len(exact) == 1 and not dup:
            rec["status"] = "auto"
            rec["assignedTo"] = commitments[exact[0]]["id"]

    booked = {c["id"]: 0 for c in commitments}
    for ln in lines:
        rec = info[ln["id"]]
        if rec["status"] in ("auto", "confirmed"):
            booked[rec["assignedTo"]] = booked.get(rec["assignedTo"], 0) + ln["amount"]

    # pass 2: candidates for remaining lines
    for ln in lines:
        rec = info[ln["id"]]
        if rec["status"] is not None:
            continue
        cc = rec["_cc"]
        exact = set(rec["_exact"])
        run_digits = {digits_int(x) for x in cc} - {None}
        scored = []
        for i, c in enumerate(commitments):
            s = Fraction(0)
            if i in exact:
                s += Fraction(6, 10)
            else:
                partial = any(edit_distance(x, cnorm[i]) <= 1 for x in cc)
                if not partial and cdigits[i] is not None and cdigits[i] in run_digits:
                    partial = True
                if partial:
                    s += Fraction(1, 4)
            s += name_similarity(ln.get("payer"), c.get("name")) * Fraction(3, 10)
            due = eff_due(c)
            owe = due - (booked.get(c["id"], 0) - refunded[c["id"]])  # v0.9: net received
            if ln["amount"] == due or (owe > 0 and ln["amount"] == owe):
                s += Fraction(1, 4)
            s = min(s, Fraction(1))
            if s >= Fraction(3, 10):
                scored.append((s, i))
        scored.sort(key=lambda t: (-t[0], t[1]))
        top = scored[:3]
        if top:
            rec["status"] = "suggested"
            rec["candidates"] = [{"id": commitments[i]["id"], "score": score_out(s)} for s, i in top]
        else:
            rec["status"] = "unmatched"

    bank = booked_total = 0
    aged = []
    for ln in lines:
        rec = info[ln["id"]]
        st = rec["status"]
        if st in ("skipped", "future"):
            continue
        bank += ln["amount"]
        if st in ("auto", "confirmed"):
            booked_total += ln["amount"]
        elif st in ("suggested", "unmatched") and (as_of - rec["_date"]).days > threshold:
            # C-REC-5 (v0.8.9): a line marked "Not part of this deal" has been reviewed, so it is
            # not aged; its money still counts as unbooked.
            aged.append(ln["id"])

    def net(cid):
        return booked.get(cid, 0) - refunded[cid]

    out_c = {}
    for c in commitments:
        r = net(c["id"])
        diff = r - eff_due(c)
        if v09 and r < 0:
            st = "check-refunds"
        elif v09 and refund_only[c["id"]] == "withdrawn":
            st = "withdrawn-imported"
        elif v09 and refund_only[c["id"]] == "closed":
            st = "closed-refund-only"
        elif c["id"] in withdrawn:
            st = "withdrawn"
        elif r == 0:
            st = "outstanding"
        elif diff == 0:
            st = "paid"
        elif diff > 0:
            st = "overpaid"
        else:
            st = "partial"
        out_c[c["id"]] = {"received": r, "difference": diff, "status": st}
        if extended:
            out_c[c["id"]].update({"cashDue": eff_due(c), "withdrawn": c["id"] in withdrawn})
        if v09:
            out_c[c["id"]].update({"booked": booked.get(c["id"], 0), "refunded": refunded[c["id"]],
                                   "refundOnly": refund_only[c["id"]]})

    out_l = {}
    for ln in lines:
        rec = info[ln["id"]]
        out_l[ln["id"]] = {k: rec[k] for k in ("status", "assignedTo", "suspectedDuplicate", "candidates")}

    result = {
        "lines": out_l,
        "commitments": out_c,
        "totals": {"bank": bank, "booked": booked_total, "unbooked": bank - booked_total},
        "aged": sorted(aged),
    }
    if extended and not v09:
        refunds, chase, handoff = [], [], {}
        for c in commitments:
            cid, r, due = c["id"], booked.get(c["id"], 0), eff_due(c)
            if cid in withdrawn:
                if r > 0:  # C-REC-7: all received, reason Withdrawn; none if nothing received
                    refunds.append({"id": cid, "amount": r, "reason": "withdrawn"})
                continue
            if r > due:  # C-REC-6
                refunds.append({"id": cid, "amount": r - due, "reason": "overpayment"})
            if r < due:  # R-REC-09 / R-REC-10.1: unpaid or part-paid, not withdrawn
                chase.append({"id": cid, "outstanding": due - r})
            handoff[cid] = min(r, due)
        refund_total = sum(x["amount"] for x in refunds)
        # C-REC-7 identity, computed independently of the refund list
        identity = (sum(booked.get(c["id"], 0) for c in commitments if c["id"] in withdrawn)
                    + sum(max(0, booked.get(c["id"], 0) - eff_due(c)) for c in commitments if c["id"] not in withdrawn))
        if identity != refund_total:
            raise ArithmeticFail("refund total identity")
        w_refund = sum(x["amount"] for x in refunds if x["reason"] == "withdrawn")
        result.update({
            "refunds": refunds,
            "refundTotal": refund_total,
            "receivable": sum(eff_due(c) for c in commitments if c["id"] not in withdrawn),
            "withdrawnSummary": {"count": len(withdrawn), "refund": w_refund},
            "chase": chase,
            "handoff": handoff,
            "checks": {"refundIdentity": identity == refund_total},
        })
    elif v09:
        # v0.9: everything on net received (C-REC-4); refund_only people as withdrawn ones (C-REC-9)
        refunds, chase, handoff, blocked = [], [], {}, []
        for c in commitments:
            cid, r, due = c["id"], net(c["id"]), eff_due(c)
            if r < 0:
                blocked.append(cid)  # "Check refunds": hand-off blocked, never treated as 0
            if cid in out_of_scope:
                if r > 0:
                    reason = "refund-only" if refund_only[cid] == "closed" else "withdrawn"
                    refunds.append({"id": cid, "amount": r, "reason": reason})
                continue
            if r > due:
                refunds.append({"id": cid, "amount": r - due, "reason": "overpayment"})
            if 0 <= r < due:
                chase.append({"id": cid, "outstanding": due - r})
            if r >= 0:
                handoff[cid] = min(r, due)
        refund_total = sum(x["amount"] for x in refunds)
        identity = (sum(max(0, net(cid)) for cid in cids if cid in out_of_scope)
                    + sum(max(0, net(c["id"]) - eff_due(c)) for c in commitments if c["id"] not in out_of_scope))
        if identity != refund_total:
            raise ArithmeticFail("refund total identity")
        w_refund = sum(x["amount"] for x in refunds if x["reason"] in ("withdrawn", "refund-only"))
        result.update({
            "refunds": refunds,
            "refundTotal": refund_total,
            "receivable": sum(eff_due(c) for c in commitments if c["id"] not in out_of_scope),
            "withdrawnSummary": {"count": len(out_of_scope), "refund": w_refund},
            "chase": chase,
            "handoff": handoff,
            "handoffBlockedBy": blocked,
            "checks": {"refundIdentity": identity == refund_total},
        })
    return result


# ---------------------------------------------------------------- hand-off (C-ALL-12, v0.9)

ENGINE = "goten-rules/0.9"
NUM_RE = re.compile(r"0|[1-9][0-9]*")
WORD_RE = re.compile(r"[a-z_]{1,40}")


def jcs_string(st):
    """allocation-handoff-v1 §4 rule 3."""
    out = ['"']
    for ch in st:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical(v):
    """RFC 8785 reduced to strings / objects / arrays / null (§4)."""
    if v is None:
        return "null"
    if isinstance(v, str):
        return jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(jcs_string(k) + ":" + canonical(v[k]) for k in keys) + "}"
    raise Invalid("non-string value in projection")


def projection_hash(projection):
    import hashlib
    data = canonical(projection).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


class _Dup(Exception):
    pass


def _pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise _Dup(k)
        d[k] = v
    return d


def _has_lone_surrogate(v):
    if isinstance(v, str):
        return any(0xD800 <= ord(ch) <= 0xDFFF for ch in v)
    if isinstance(v, list):
        return any(_has_lone_surrogate(x) for x in v)
    if isinstance(v, dict):
        return any(_has_lone_surrogate(k) or _has_lone_surrogate(x) for k, x in v.items())
    return False


def _num(errs, where, v, lo=0, hi=None):
    if not isinstance(v, str) or not NUM_RE.fullmatch(v):
        errs.append("number: " + where)
        return None
    n = int(v)
    if n < lo or (hi is not None and n > hi):
        errs.append("range: " + where)
        return None
    return n


def _keys(errs, where, obj, required, optional=()):
    if not isinstance(obj, dict):
        errs.append("object: " + where)
        return False
    for k in obj:
        if k not in required and k not in optional:
            errs.append("unknown-field: %s.%s" % (where, k))
    for k in required:
        if k not in obj:
            errs.append("missing-field: %s.%s" % (where, k))
    return True


def _text(errs, where, v, lo, hi, printable_ascii=False):
    if not isinstance(v, str) or not lo <= utf16_len(v) <= hi:
        errs.append("text: " + where)
        return
    if printable_ascii and any(not 0x20 <= ord(ch) <= 0x7E for ch in v):
        errs.append("text: " + where)


def handoff(case):
    """Validate a goten.allocation-request/1 and compute its goten.allocation-result/1."""
    if "projection" in case and "request" not in case and "requestText" not in case:
        pr = case["projection"]
        return {"ok": True, "canonical": canonical(pr), "hash": projection_hash(pr)}
    errs = []
    if "requestText" in case:
        try:
            req = json.loads(case["requestText"], object_pairs_hook=_pairs)
        except _Dup:
            return {"ok": False, "errors": ["duplicate-key"]}
        except ValueError:
            return {"ok": False, "errors": ["invalid-json"]}
    else:
        req = case.get("request")
    if _has_lone_surrogate(req):
        return {"ok": False, "errors": ["lone-surrogate"]}
    deal_ccy = case.get("dealCurrency", "GBP")
    if not _keys(errs, "request", req, ("format", "handoff_id", "deal_id", "engine", "projection_hash",
                                        "projection", "bookkeeping")):
        return {"ok": False, "errors": errs}
    if req.get("format") != "goten.allocation-request/1":
        return {"ok": False, "errors": ["unknown-format"]}
    _text(errs, "handoff_id", req.get("handoff_id"), 1, 80, True)
    _text(errs, "deal_id", req.get("deal_id"), 1, 80, True)
    eng = req.get("engine")
    if eng != ENGINE:
        errs.append("This request needs engine %s; this copy of Goten runs %s" % (eng, ENGINE))
    ph = req.get("projection_hash")
    if not isinstance(ph, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", ph):
        errs.append("projection_hash format")
    pr = req.get("projection")
    if not _keys(errs, "projection", pr, ("currency", "instrument", "minimum", "deal_fees", "participants"),
                 ("share_price_micros", "cap", "platform_fee")):
        return {"ok": False, "errors": errs}
    try:
        if isinstance(ph, str) and projection_hash(pr) != ph:
            errs.append("The file was changed after it was exported")
    except Invalid:
        errs.append("non-string value in projection")

    ccy = pr.get("currency")
    if ccy not in ("GBP", "EUR", "USD"):
        errs.append("currency")
    elif ccy != deal_ccy:
        if case.get("feePayerChangeActive"):
            errs.append("This request is in %s; this deal is in %s. Reverse the active fee payer change first, "
                        "then change the deal currency to %s and import again." % (ccy, deal_ccy, ccy))
        else:
            errs.append("This request is in %s; this deal is in %s. Change the deal currency to %s in Deal "
                        "settings, then import again." % (ccy, deal_ccy, ccy))
    inst = pr.get("instrument")
    price = None
    if inst not in ("equity", "convertible", "fund_units"):
        errs.append("instrument")
    elif inst == "equity":
        if "share_price_micros" not in pr:
            errs.append("missing-field: projection.share_price_micros")
        else:
            price = _num(errs, "share_price_micros", pr["share_price_micros"], 1, 10 ** 12)
    elif "share_price_micros" in pr:
        errs.append("share price must be empty")
    cap = _num(errs, "cap", pr["cap"], 1, MONEY_MAX) if "cap" in pr else None
    minimum = _num(errs, "minimum", pr.get("minimum"), 0, MONEY_MAX)

    pf = None
    if "platform_fee" in pr:
        q = pr["platform_fee"]
        if _keys(errs, "platform_fee", q, ("rate_bps", "minimum", "payer"),
                 ("maximum", "add_on_threshold", "add_on_rate_bps")):
            pf = {"rate": _num(errs, "platform_fee.rate_bps", q.get("rate_bps"), 0, BP),
                  "minimum": _num(errs, "platform_fee.minimum", q.get("minimum"), 0, MONEY_MAX),
                  "maximum": _num(errs, "platform_fee.maximum", q["maximum"], 0, MONEY_MAX) if "maximum" in q else None,
                  "addOnThreshold": None, "addOnRate": None, "payer": q.get("payer")}
            if "add_on_threshold" in q:
                pf["addOnThreshold"] = _num(errs, "platform_fee.add_on_threshold", q["add_on_threshold"], 0, MONEY_MAX)
                if "add_on_rate_bps" not in q:
                    errs.append("platform_fee.add_on_rate_bps required with a threshold")
                else:
                    pf["addOnRate"] = _num(errs, "platform_fee.add_on_rate_bps", q["add_on_rate_bps"], 0, BP)
            elif "add_on_rate_bps" in q:
                if _num(errs, "platform_fee.add_on_rate_bps", q["add_on_rate_bps"], 0, BP) not in (0, None):
                    errs.append("platform_fee.add_on_rate_bps without threshold")
            if q.get("payer") not in ("investors", "lead", "company"):
                errs.append("platform_fee.payer")
            if pf["minimum"] is not None and pf["maximum"] is not None and pf["minimum"] > pf["maximum"]:
                errs.append("platform_fee minimum > maximum")

    fees = []
    dfs = pr.get("deal_fees")
    if not isinstance(dfs, list):
        errs.append("deal_fees")
        dfs = []
    if len(dfs) > 20:
        errs.append("deal_fees > 20")
    seen_f, seen_l = set(), set()
    for j, f in enumerate(dfs):
        w = "deal_fees[%d]" % j
        if not _keys(errs, w, f, ("id", "label", "payer", "kind", "value")):
            continue
        _text(errs, w + ".id", f.get("id"), 1, 40)
        _text(errs, w + ".label", f.get("label"), 1, 60)
        if f.get("id") in seen_f:
            errs.append("duplicate fee id")
        seen_f.add(f.get("id"))
        lab = f.get("label").strip(" \t\r\n").lower() if isinstance(f.get("label"), str) else None
        if lab in seen_l:
            errs.append("duplicate fee label")
        seen_l.add(lab)
        if f.get("payer") not in ("company", "lead"):
            errs.append(w + ".payer")
        if f.get("kind") == "percent":
            v = _num(errs, w + ".value", f.get("value"), 0, BP)
        elif f.get("kind") == "fixed":
            v = _num(errs, w + ".value", f.get("value"), 1, MONEY_MAX)
        else:
            errs.append(w + ".kind")
            v = None
        fees.append({"id": f.get("id"), "kind": f.get("kind"), "value": v, "payer": f.get("payer")})

    parts = pr.get("participants")
    if not isinstance(parts, list):
        errs.append("participants")
        parts = []
    if len(parts) > 500:
        errs.append("more than 500 participants")
    pids = []
    investors = []
    allocated = set()
    for j, pp in enumerate(parts):
        w = "participants[%d]" % j
        if not isinstance(pp, dict):
            errs.append("object: " + w)
            continue
        dec = pp.get("decision")
        if dec == "allocate":
            ok = _keys(errs, w, pp, ("id", "order", "status", "decision", "terms", "commitment", "cash_due",
                                     "allocation_amount", "scheme"))
        else:
            ok = _keys(errs, w, pp, ("id", "order", "status", "decision"))
        _text(errs, w + ".id", pp.get("id"), 1, 40)
        if pp.get("id") in pids:
            errs.append("duplicate participant id")
        pids.append(pp.get("id"))
        if _num(errs, w + ".order", pp.get("order"), 1) != j + 1:
            errs.append("order must be exactly 1..n in sequence: " + w)
        for key in ("status", "decision"):
            if not isinstance(pp.get(key), str) or not WORD_RE.fullmatch(pp.get(key)):
                errs.append("%s.%s" % (w, key))
        if dec != "allocate" or not ok:
            continue
        allocated.add(pp["id"])
        t = pp.get("terms")
        own = None
        if _keys(errs, w + ".terms", t, ("fee_mode", "fee", "carry_bps")):
            mode = {"on_top": "onTop", "deducted": "deducted"}.get(t.get("fee_mode"))
            if mode is None:
                errs.append(w + ".terms.fee_mode")
            fee = t.get("fee")
            ofee = None
            if fee is not None:
                if isinstance(fee, dict) and fee.get("kind") == "rate":
                    if _keys(errs, w + ".terms.fee", fee, ("kind", "rate_bps")):
                        r_ = _num(errs, w + ".terms.fee.rate_bps", fee.get("rate_bps"), 0, BP)
                        if r_ is not None and mode == "deducted" and r_ >= BP:
                            errs.append(w + ": deducted rate must be < 100%")
                        ofee = {"kind": "percent", "value": r_}
                elif isinstance(fee, dict) and fee.get("kind") == "fixed":
                    if _keys(errs, w + ".terms.fee", fee, ("kind", "amount")):
                        ofee = {"kind": "fixed", "value": _num(errs, w + ".terms.fee.amount", fee.get("amount"), 1, MONEY_MAX)}
                else:
                    errs.append(w + ".terms.fee")
            _num(errs, w + ".terms.carry_bps", t.get("carry_bps"), 0, BP)
            own = {"mode": mode, "fee": ofee}
        _num(errs, w + ".commitment", pp.get("commitment"), 0, MONEY_MAX)
        _num(errs, w + ".cash_due", pp.get("cash_due"), 0, MONEY_MAX)
        R = _num(errs, w + ".allocation_amount", pp.get("allocation_amount"), 0, MONEY_MAX)
        if pp.get("scheme") not in ("none", "SEIS", "EIS"):
            errs.append(w + ".scheme")
        investors.append({"id": pp.get("id"), "received": R, "scheme": pp.get("scheme"), "ownTerms": own})

    bk = req.get("bookkeeping")
    named = set()
    if _keys(errs, "bookkeeping", bk, ("participants",)):
        bps = bk.get("participants")
        if not isinstance(bps, list):
            errs.append("bookkeeping.participants")
            bps = []
        seen_b = set()
        for j, b in enumerate(bps):
            w = "bookkeeping.participants[%d]" % j
            if not _keys(errs, w, b, ("id", "name"), ("email", "money_held")):
                continue
            if b.get("id") not in pids:
                errs.append(w + ": id not in projection")
            if b.get("id") in seen_b:
                errs.append(w + ": duplicate id")
            seen_b.add(b.get("id"))
            _text(errs, w + ".name", b.get("name"), 1, 256)
            named.add(b.get("id"))
            if "email" in b:
                _text(errs, w + ".email", b["email"], 1, 320)
                if isinstance(b["email"], str) and "@" not in b["email"]:
                    errs.append(w + ".email")
            if "money_held" in b:
                _num(errs, w + ".money_held", b["money_held"], 0, MONEY_MAX)
    for i in allocated:
        if i not in named:
            errs.append("allocated participant without a name: %s" % i)

    if errs:
        return {"ok": False, "errors": errs}

    acase = {"kind": "allocation", "feeBasis": "deducted", "minimum": minimum, "cap": cap,
             "instrument": inst, "priceMicros": price, "fees": fees, "investors": investors}
    if pf is not None:
        acase["platformFee"] = pf
    try:
        a = allocation(acase)
    except Invalid as e:
        return {"ok": False, "errors": ["input: %s" % e]}
    head = {"format": "goten.allocation-result/1", "handoff_id": req["handoff_id"], "engine": ENGINE,
            "projection_hash": ph}
    if a["blockers"]:
        res = dict(head, can_close=False,
                   blockers=[{"code": b, "ids": a["blockerIds"][b]} for b in a["blockers"]])
        return {"ok": True, "result": res}
    out_p = []
    for pp in parts:
        if pp["decision"] != "allocate":
            out_p.append({"id": pp["id"], "allocated": False, "exclusion": "not-in-allocation"})
            continue
        v = a["investors"][pp["id"]]
        if not v["participating"]:
            out_p.append({"id": pp["id"], "allocated": False, "exclusion": v["exclusion"], "refund": str(v["refund"])})
            continue
        row = {"id": pp["id"], "allocated": True, "exclusion": None, "target": str(v["target"]),
               "own_fee": str(v["ownFee"] or 0), "platform_fee_share": str(v["platformFeeShare"]),
               "invested": str(v["invested"]), "refund": str(v["refund"])}
        if inst == "equity":
            row["micro_shares"] = str(v["microShares"])
        if int(pp["allocation_amount"]) != v["target"] + (v["ownFee"] or 0) + v["refund"]:
            raise ArithmeticFail("allocation_amount identity")
        out_p.append(row)
    totals = {"received": str(a["received"]), "invested": str(a["totalInvested"]),
              "investor_fees": str(a["investorFees"]), "refunds": str(a["refunds"]),
              "company_fees": str(a["companyFees"]), "lead_invoice": str(a["leadInvoice"]), "wire": str(a["wire"])}
    if pf is not None:
        totals["platform_fee"] = str(a["platformFee"]["amount"])
        totals["platform_fee_payer"] = pf["payer"]
    res = dict(head, can_close=True, blockers=[], participants=out_p, totals=totals,
               deal_fees=[{"id": f["id"], "amount": str(a["feeTotals"][f["id"]])} for f in fees])
    return {"ok": True, "result": res}


# ---------------------------------------------------------------- entry

def run(case):
    kind = case.get("kind")
    try:
        if kind == "allocation":
            return allocation(case)
        if kind == "waterfall":
            return waterfall(case)
        if kind == "reconcile":
            return reconcile(case)
        if kind == "feePayerChange":
            return fee_payer_change(case)
        if kind == "handoff":
            return handoff(case)
    except Invalid as e:
        out = {"ok": False}
        if e.code:
            out["error"] = e.code
        if e.investor:
            out["investor"] = e.investor
        return out
    except (KeyError, TypeError, AttributeError):
        return {"ok": False}
    return {"ok": False}


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: oracle.py <case.json>\n")
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as fh:
        case = json.load(fh)
    print(json.dumps(run(case), sort_keys=True))


if __name__ == "__main__":
    main()
