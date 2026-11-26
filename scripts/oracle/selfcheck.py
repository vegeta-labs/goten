#!/usr/bin/env python3
"""Self-check the oracle against the hand calculations in docs/04_TEST_PLAN.md
(§2.3 allocation, §2.4 waterfall, §3 sample deal, plus a few §2.2 reconcile rows;
v0.8 §2.5: C-ALL-10 fee payer change and C-REC-7 withdrawal; v0.9 §2.6: decision J, TC-J-*).
Usage: python3 scripts/oracle/selfcheck.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle import run  # noqa: E402

PASSED = 0
FAILED = []


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILED.append("%s %s" % (name, detail))
        print("FAIL", name, detail)


def eq(name, got, want):
    check(name, got == want, "got %r want %r" % (got, want))


GBP1 = 1000000  # £1.00 in price micros


def alloc(investors, fees=(), basis="deducted", minimum=0, cap=None, price=GBP1):
    return run({
        "kind": "allocation", "feeBasis": basis, "minimum": minimum, "cap": cap,
        "priceMicros": price, "fees": list(fees),
        "investors": [{"id": i, "received": r, "scheme": s} for i, r, s in investors],
    })


PF3 = {"id": "pf", "kind": "percent", "value": 300, "payer": "investors"}

# ---------------------------------------------------------------- §2.3 allocation
r = alloc([("A", 100000, "none")])
eq("ALL-01 I", r["investors"]["A"]["invested"], 100000)
eq("ALL-01 shares", r["investors"]["A"]["microShares"], 1000000000)
eq("ALL-01 refund", r["investors"]["A"]["refund"], 0)

r = alloc([("A", 1000000, "none")], [PF3])
eq("ALL-02", (r["investors"]["A"]["invested"], r["investors"]["A"]["fees"], r["investors"]["A"]["refund"]),
   (970000, {"pf": 30000}, 0))

r = alloc([("A", 1030000, "none")], [PF3], basis="onTop")
eq("ALL-03", (r["investors"]["A"]["invested"], r["investors"]["A"]["fees"], r["investors"]["A"]["refund"]),
   (1000000, {"pf": 30000}, 0))

r = alloc([("A", 500000, "SEIS")], price=2413700)
a = r["investors"]["A"]
eq("ALL-05", (a["invested"], a["microShares"], a["claimableShares"], a["claimableAmount"]),
   (500000, 2071508472, 2071, 499877))
eq("ALL-05 unclaimable", a["invested"] - a["claimableAmount"], 123)

r = alloc([("A", 100000, "none")], minimum=100000, price=2413700)
eq("ALL-06", (r["investors"]["A"]["participating"], r["investors"]["A"]["invested"],
              r["investors"]["A"]["microShares"]), (True, 100000, 414301694))

r = alloc([("A", 90000, "none")], [PF3], minimum=100000)
eq("ALL-07", (r["investors"]["A"]["participating"], r["investors"]["A"]["refund"], r["investors"]["A"]["fees"]),
   (False, 90000, {}))
eq("ALL-07/14 blocker", r["blockers"], ["no-participants"])

r = alloc([("A", 102000, "none")], [PF3], basis="onTop", minimum=100000)
eq("ALL-08", (r["investors"]["A"]["participating"], r["investors"]["A"]["refund"]), (False, 102000))

r = alloc([("A", 400000, "none"), ("B", 200000, "none")], cap=300000)
eq("ALL-09", [(r["investors"][i]["invested"], r["investors"][i]["refund"]) for i in "AB"],
   [(200000, 200000), (100000, 100000)])
eq("ALL-09 blockers", r["blockers"], [])

r = alloc([("A", 100000, "none"), ("B", 100000, "none")], minimum=100000, cap=150000)
eq("ALL-10", ([r["investors"][i]["invested"] for i in "AB"], r["blockers"]),
   ([75000, 75000], ["scale-back-below-minimum"]))

fees11 = [{"id": "admin", "kind": "perInvestor", "value": 1000, "payer": "investors"},
          {"id": "kyc", "kind": "perInvestor", "value": 500, "payer": "investors"}]
r = alloc([("A", 100000, "none"), ("B", 200000, "none")], fees11)
eq("ALL-11 fees", [r["investors"][i]["fees"] for i in "AB"], [{"admin": 1000, "kyc": 500}] * 2)
eq("ALL-11 totals", r["feeTotals"], {"admin": 2000, "kyc": 1000})
eq("ALL-11 I", [r["investors"][i]["invested"] for i in "AB"], [98500, 198500])

r = alloc([("A", 100000, "none")], [{"id": "legal", "kind": "fixed", "value": 150000, "payer": "company"}])
eq("ALL-13", r["blockers"], ["company-fees-exceed"])

r = alloc([])
eq("ALL-14 empty", r["blockers"], ["no-participants"])

r = alloc([("A", 1000000, "none")], [{"id": "legal", "kind": "fixed", "value": 150000, "payer": "company"},
                                     {"id": "lead", "kind": "percent", "value": 200, "payer": "lead"}])
eq("ALL-15", (r["wire"], r["leadInvoice"], r["companyFees"], r["blockers"]), (850000, 20000, 150000, []))

ok17 = True
for rec in range(1000, 1400):
    r = alloc([("A", rec, "none")], [{"id": "pf", "kind": "percent", "value": 350, "payer": "investors"}],
              price=333333)
    a = r["investors"]["A"]
    if a["refund"] < 0 or a["invested"] + sum(a["fees"].values()) + a["refund"] != rec:
        ok17 = False
check("ALL-17 invariant 10.00..13.99", ok17)

r = alloc([("A", 1000, "none"), ("B", 10000, "none")],
          [{"id": "fx", "kind": "perInvestor", "value": 1000, "payer": "investors"}])
eq("ALL-21 A", (r["investors"]["A"]["participating"], r["investors"]["A"]["refund"], r["investors"]["A"]["fees"]),
   (False, 1000, {}))
eq("ALL-21 B", (r["investors"]["B"]["invested"], r["investors"]["B"]["fees"]), (9000, {"fx": 1000}))

fees22 = [{"id": "f%d" % i, "kind": "percent", "value": 100, "payer": "investors"} for i in range(5)]
r = alloc([("A", 53, "none")], fees22, price=10000)
eq("ALL-22", (r["investors"]["A"]["invested"], r["investors"]["A"]["fees"], r["investors"]["A"]["refund"]),
   (48, {"f%d" % i: 1 for i in range(5)}, 0))

eq("ALL invalid p>=100%", alloc([("A", 100, "none")], [{"id": "x", "kind": "percent", "value": 10000,
                                                       "payer": "investors"}]), {"ok": False})
eq("ALL invalid investor fixed", alloc([("A", 100, "none")], [{"id": "x", "kind": "fixed", "value": 10,
                                                              "payer": "investors"}]), {"ok": False})

# ---------------------------------------------------------------- §3 sample: allocation
sample_alloc = [("amelia", 1000000, "SEIS"), ("ben", 500000, "EIS"), ("chloe", 2000000, "none"),
                ("david", 200000, "SEIS"), ("elena", 1500000, "EIS"), ("farhan", 1000000, "EIS"),
                ("grace", 2500000, "none"), ("hugo", 500000, "SEIS"), ("isla", 100000, "none"),
                ("james", 0, "EIS"), ("kavya", 750000, "SEIS"), ("lucas", 300000, "none")]
r = alloc(sample_alloc, [{"id": "platform", "kind": "percent", "value": 300, "payer": "investors"},
                         {"id": "legal", "kind": "fixed", "value": 150000, "payer": "company"}],
          minimum=100000, cap=15000000, price=2413700)
eq("S-ALL received total", sum(x[1] for x in sample_alloc), 10350000)
eq("S-ALL participants", sum(1 for v in r["investors"].values() if v["participating"]), 11)
eq("S-ALL totals", (r["totalInvested"], r["feeTotals"], r["companyFees"], r["wire"], r["blockers"]),
   (10039500, {"platform": 310500, "legal": 150000}, 150000, 9889500, []))
eq("S-ALL refunds", sum(v["refund"] for v in r["investors"].values()), 0)
for iid, rec, _ in sample_alloc:
    if rec:
        v = r["investors"][iid]
        check("S-ALL %s 0.97/0.03" % iid, v["invested"] * 100 == rec * 97 and v["fees"]["platform"] * 100 == rec * 3)
am, dv = r["investors"]["amelia"], r["investors"]["david"]
eq("S-ALL amelia", (am["invested"], am["microShares"], am["claimableShares"], am["claimableAmount"]),
   (970000, 4018726436, 4018, 969824))
eq("S-ALL david", (dv["invested"], dv["microShares"], dv["claimableShares"], dv["claimableAmount"]),
   (194000, 803745287, 803, 193820))
eq("S-ALL isla", r["investors"]["isla"]["invested"], 97000)
check("S-ALL james out", r["investors"]["james"]["participating"] is False)
holdings = [{"id": k, "capital": v["invested"]} for k, v in r["investors"].items() if v["participating"]]


# ---------------------------------------------------------------- §2.4 waterfall
def wf(proceeds, exit_costs=0, years100=500, k=2000, h=0, c=0, tiers=None, hold=None):
    carry = {"mode": "tiered", "tiers": tiers} if tiers else {"mode": "fixed", "k": k, "h": h, "c": c}
    return run({"kind": "waterfall",
                "holdings": hold or [{"id": "a", "capital": 6000000}, {"id": "b", "capital": 4000000}],
                "proceeds": proceeds, "exitCosts": exit_costs, "years100": years100, "carry": carry})


r = wf(30000000)
eq("DIS-01", (r["carry"], r["distributions"]), (4000000, {"a": 15600000, "b": 10400000}))
eq("DIS-19 profit", (r["distributions"]["a"] - 6000000, r["distributions"]["b"] - 4000000), (9600000, 6400000))
r = wf(8000000)
eq("DIS-02", (r["carry"], r["investorsTotal"], r["returnOfCapital"]), (0, 8000000, 8000000))
eq("DIS-03", wf(30000000, exit_costs=1000000)["carry"], 3800000)
r = wf(30000000, h=800, c=10000)
eq("DIS-04", (r["hurdlePaid"], r["catchUpTranche"], r["catchUpToLead"], r["carry"]),
   (4693281, 1173320, 1173320, 4000000))
eq("DIS-04 residual", r["carry"] - r["catchUpToLead"], 2826680)
eq("DIS-05", wf(30000000, h=800, c=0)["carry"], 3061344)
r = wf(30000000, h=800, c=5000)
eq("DIS-06", (r["catchUpTranche"], r["catchUpToLead"], r["carry"] - r["catchUpToLead"], r["carry"]),
   (3128854, 1564427, 2435573, 4000000))
eq("DIS-07", wf(14000000, h=800, c=10000)["carry"], 0)
r = wf(30000000, h=800, c=0, years100=250)
eq("DIS-08", (r["hurdlePaid"], r["carry"]), (2121584, 3575683))
T23 = [{"upTo100": 300, "rate": 2000}, {"upTo100": None, "rate": 3000}]
eq("DIS-09", wf(50000000, tiers=T23)["carry"], 10000000)
eq("DIS-10a", wf(31000000, exit_costs=1000000, tiers=T23)["carry"], 4000000)
eq("DIS-10b", wf(31001000, exit_costs=1000000, tiers=T23)["carry"], 4000300)
r = wf(100, k=0, hold=[{"id": "x", "capital": 1}, {"id": "y", "capital": 1}, {"id": "z", "capital": 1}])
eq("DIS-12", r["distributions"], {"x": 34, "y": 33, "z": 33})
r = wf(100, exit_costs=200)
eq("DIS-13", (r["blockers"], r["shortfall"], r["costsPaid"], r["carry"], r["distributions"]),
   (["exit-cost-shortfall"], 100, 100, 0, {"a": 0, "b": 0}))
eq("DIS-14 zero capital", wf(100, hold=[{"id": "a", "capital": 0}]), {"ok": False})
eq("DIS-14 c without h", wf(100, h=0, c=5000), {"ok": False})
eq("DIS-14 c <= k", wf(100, h=800, c=2000), {"ok": False})
eq("DIS-14 tiers not increasing", wf(100, tiers=[{"upTo100": 300, "rate": 2000}, {"upTo100": 200, "rate": 2500},
                                                 {"upTo100": None, "rate": 3000}]), {"ok": False})
r = wf(16000000, h=800, c=5000)
eq("DIS-16", (r["catchUpTranche"], r["catchUpToLead"], r["carry"], r["investorsTotal"]),
   (1306719, 653360, 653360, 15346640))
eq("DIS-17", [wf(g, tiers=T23)["carry"] for g in (29999999, 30000000, 30000001)], [4000000] * 3)
r = wf(2, tiers=[{"upTo100": 150, "rate": 10000}, {"upTo100": None, "rate": 10000}],
       hold=[{"id": "a", "capital": 1}])
eq("DIS-18", (r["carry"], r["investorsTotal"]), (1, 1))
bad = run({"kind": "waterfall", "holdings": [{"id": "a", "capital": 100}], "proceeds": 1000, "exitCosts": 0,
           "years100": 500, "carry": {"mode": "tiered", "h": 800, "tiers": T23}})
eq("DIS-20", bad, {"ok": False})
r = wf(2900, k=0, hold=[{"id": "a", "capital": 19}, {"id": "b", "capital": 10}])
eq("DIS-22", r["distributions"], {"a": 1900, "b": 1000})
r = wf(2900, k=0, hold=[{"id": "a", "capital": 19}, {"id": "b", "capital": 20}])
eq("DIS-21a", r["distributions"], {"a": 1413, "b": 1487})

r = run({"kind": "waterfall", "holdings": [{"id": "a", "capital": 5000}], "proceeds": 5001, "exitCosts": 0,
         "years100": 100, "carry": {"mode": "fixed", "k": 10000, "h": 1, "c": 0}})
eq("REVIEW hurdle exact half-penny", (r["hurdlePaid"], r["carry"], r["distributions"]), (1, 0, {"a": 5001}))
from oracle import hurdle_amount  # noqa: E402
eq("REVIEW hurdle 1.21^0.5 exact", hurdle_amount(5, 2100, 50), 1)  # 5 * 0.1 = 0.5 -> 1
eq("REVIEW hurdle 2.5y", hurdle_amount(10000000, 800, 250), 2121584)

# ---------------------------------------------------------------- §3 sample: waterfall
r = run({"kind": "waterfall", "holdings": holdings, "proceeds": 39000000, "exitCosts": 450000,
         "years100": 600, "carry": {"mode": "fixed", "k": 2000, "h": 800, "c": 10000}})
eq("S-DIS", (r["returnOfCapital"], r["hurdlePaid"], r["catchUpTranche"], r["catchUpToLead"],
             r["carry"] - r["catchUpToLead"], r["carry"], r["investorsTotal"]),
   (10039500, 5891925, 1472981, 1472981, 4229119, 5702100, 32847900))
eq("S-DIS split sum", sum(r["distributions"].values()), 32847900)

# ---------------------------------------------------------------- §3 sample: reconcile
names = [("amelia", "Amelia Hart", 1000000), ("ben", "Ben Okafor", 500000), ("chloe", "Chloe Martin", 2000000),
         ("david", "David Kim", 250000), ("elena", "Elena Rossi", 1500000), ("farhan", "Farhan Malik", 1000000),
         ("grace", "Grace Liu", 2500000), ("hugo", "Hugo Bernard", 500000), ("isla", "Isla Campbell", 100000),
         ("james", "James Whitfield", 2000000), ("kavya", "Kavya Iyer", 750000), ("lucas", "Lucas Meyer", 300000)]
commitments = [{"id": i, "name": n, "reference": "NW-%03d" % (k + 1), "cashDue": d}
               for k, (i, n, d) in enumerate(names)]
L = [("t01", "10-06", 1000000, "A HART", "NW-001"), ("t02", "10-06", 500000, "B OKAFOR", "NW002 NORTHWIND"),
     ("t03", "10-07", 2000000, "CHLOE MARTIN", ""), ("t04", "10-07", 200000, "D KIM", "NW-004"),
     ("t05", "10-08", 1500000, "ROSSI FAMILY OFFICE LTD", "NORTHWIND SEED"),
     ("t06", "10-08", 1000000, "F MALIK", "NW-006"), ("t07", "10-09", 2500000, "GRACE LIU", "NW-007"),
     ("t08", "10-09", 500000, "H BERNARD", "NW-008"), ("t09", "10-10", 500000, "H BERNARD", "NW-008"),
     ("t10", "10-10", 100000, "ISLA CAMPBELL", "NW-009"), ("t11", "10-03", 234000, "WESTBRIDGE SUPPLIES", "INV 4471"),
     ("t12", "10-14", 750000, "K IYER", "NW 11"), ("t13", "10-15", 300000, "L MEYER", "NW-012"),
     ("t14", "10-15", 400000, "SAM PATEL", "NW-0019"), ("t15", "10-15", -4500, "BANK CHARGE", "FEE"),
     ("t16", "10-18", 300000, "J WHITFIELD", "NW-010")]
lines = [{"id": i, "txnId": i, "date": "2026-" + d, "amount": a, "payer": p, "reference": ref}
         for i, d, a, p, ref in L]


def rec(decisions=None, lines_=None, comms=None, as_of="2026-10-16", thr=10):
    return run({"kind": "reconcile", "asOf": as_of, "thresholdDays": thr, "commitments": comms or commitments,
                "lines": lines_ if lines_ is not None else lines, "decisions": decisions or {}})


r = rec()
st = {k: v["status"] for k, v in r["lines"].items()}
for t in ("t01", "t02", "t04", "t06", "t07", "t08", "t09", "t10", "t13"):
    eq("S-REC %s auto" % t, st[t], "auto")
eq("S-REC t03", r["lines"]["t03"]["candidates"][0], {"id": "chloe", "score": 0.55})
eq("S-REC t05", r["lines"]["t05"]["candidates"][0], {"id": "elena", "score": 0.35})
eq("S-REC t12", r["lines"]["t12"]["candidates"][0], {"id": "kavya", "score": 0.8})
eq("S-REC suggested", sorted(k for k, v in st.items() if v == "suggested"), ["t03", "t05", "t12"])
eq("S-REC unmatched", sorted(k for k, v in st.items() if v == "unmatched"), ["t11", "t14"])
eq("S-REC t15/t16", (st["t15"], st["t16"]), ("skipped", "future"))
eq("S-REC totals", r["totals"], {"bank": 11484000, "booked": 6600000, "unbooked": 4884000})
eq("S-REC aged", r["aged"], ["t11"])
cs = {k: (v["status"], v["difference"]) for k, v in r["commitments"].items()}
for k in ("amelia", "ben", "farhan", "grace", "isla", "lucas"):
    eq("S-REC %s paid" % k, cs[k], ("paid", 0))
eq("S-REC david", cs["david"], ("partial", -50000))
eq("S-REC hugo", cs["hugo"], ("overpaid", 500000))
for k in ("chloe", "elena", "kavya", "james"):
    eq("S-REC %s outstanding" % k, cs[k][0], "outstanding")

r = rec({"t03": {"assign": "chloe"}, "t05": {"assign": "elena"}, "t12": {"assign": "kavya"},
         "t11": {"reject": True}, "t14": {"reject": True}})
eq("S-REC after decisions totals", r["totals"], {"bank": 11484000, "booked": 10850000, "unbooked": 634000})
eq("S-REC after decisions aged", r["aged"], [])
carried = {k: min(v["received"], c["cashDue"]) for c in commitments for k, v in r["commitments"].items()
           if c["id"] == k}
eq("S-REC carry-in", (carried["hugo"], carried["david"], carried["james"], sum(carried.values())),
   (500000, 200000, 0, 10350000))

# ---------------------------------------------------------------- §2.2 reconcile spot checks
base = [{"id": "john", "name": "John Smith", "reference": "NW-001", "cashDue": 500000},
        {"id": "priya", "name": "Priya Shah", "reference": "NW-002", "cashDue": 1000000},
        {"id": "tom", "name": "Tom Okafor", "reference": "NW-003", "cashDue": 250000},
        {"id": "ana", "name": "Ana Lima", "reference": "NW-010", "cashDue": 100000}]


def one(amount, payer, ref, txn="x", d="2026-10-10", decisions=None):
    return rec(decisions, [{"id": "x", "txnId": txn, "date": d, "amount": amount, "payer": payer,
                            "reference": ref}], base, as_of="2026-10-12")["lines"]["x"]


for ref in ("NW-001", "nw 001", "NW001 SPV"):
    eq("REC-01 %s" % ref, (one(123, "", ref)["status"], one(123, "", ref)["assignedTo"]), ("auto", "john"))
check("REC-02", one(123, "", "NW-0019")["status"] != "auto")
eq("REC-03", one(123, "", "NW-010")["assignedTo"], "ana")
x = one(123, "", "NW-001 NW-002")
eq("REC-04", (x["status"], [c["id"] for c in x["candidates"]]), ("suggested", ["john", "priya"]))
eq("REC-05", one(1000000, "PRIYA SHAH", "")["candidates"][0], {"id": "priya", "score": 0.55})
eq("REC-07", rec({"x": {"assign": "tom"}}, [{"id": "x", "txnId": "x", "date": "2026-10-10", "amount": 1000000,
                                            "payer": "PRIYA SHAH", "reference": ""}], base,
                 as_of="2026-10-12")["commitments"]["tom"]["difference"], 750000)
eq("REC-11", one(100000, "UNKNOWN", "")["status"], "unmatched")
eq("REC-13", one(250000, "T OKAFOR", "NW 3")["candidates"][0], {"id": "tom", "score": 0.8})
eq("REC-12a", one(1, "J SMITH", "")["candidates"][0]["score"], 0.3)
eq("REC-12b", one(1, "MR JOHN SMITH", "")["candidates"][0]["score"], 0.3)
eq("REC-12c Okafor Holdings", one(250000, "Okafor Holdings Ltd", "")["candidates"][0], {"id": "tom", "score": 0.4})
dup = [{"id": i, "txnId": None, "date": "2026-10-10", "amount": 500000, "payer": "J SMITH", "reference": "NW-001"}
       for i in ("d1", "d2")]
r = rec(None, dup, base, as_of="2026-10-12")
eq("REC-16", [(r["lines"][i]["status"] != "auto", r["lines"][i]["suspectedDuplicate"]) for i in ("d1", "d2")],
   [(True, True)] * 2)
r = rec(None, [{"id": "a", "txnId": "a", "date": "2026-10-01", "amount": 999, "payer": "", "reference": ""},
               {"id": "b", "txnId": "b", "date": "2026-10-02", "amount": 999, "payer": "", "reference": ""},
               {"id": "c", "txnId": "c", "date": "2026-10-03", "amount": 999, "payer": "", "reference": ""}],
        base, as_of="2026-10-12")
eq("REC-18", r["aged"], ["a"])
old_line = [{"id": "a", "txnId": "a", "date": "2026-10-01", "amount": 999, "payer": "", "reference": ""}]
r = rec(None, old_line, base, as_of="2026-10-12")
eq("REC-58 no decision is aged", (r["lines"]["a"]["status"], r["aged"], r["totals"]["unbooked"]),
   ("unmatched", ["a"], 999))
r = rec({"a": {"reject": True}}, old_line, base, as_of="2026-10-12")
eq("REC-58 rejected is not aged, money stays unbooked", (r["lines"]["a"]["status"], r["aged"], r["totals"]["unbooked"]),
   ("rejected", [], 999))
four = [{"id": "j%d" % i, "name": "John Smith", "reference": "JS-%03d" % i, "cashDue": 100} for i in range(4)]
x = rec(None, [{"id": "x", "txnId": "x", "date": "2026-10-10", "amount": 7, "payer": "J SMITH", "reference": ""}],
        four, as_of="2026-10-12")["lines"]["x"]
eq("REC-25", x["candidates"], [{"id": "j%d" % i, "score": 0.3} for i in range(3)])
x = rec(None, [{"id": "x", "txnId": "x", "date": "2026-10-10", "amount": 7, "payer": "J JOHN", "reference": ""}],
        [{"id": "jj", "name": "JOHN JAMES", "reference": "AB-1", "cashDue": 100}], as_of="2026-10-12")["lines"]["x"]
eq("REC-28", x["candidates"], [{"id": "jj", "score": 0.3}])

x = rec(None, [{"id": "x", "txnId": "x", "date": "2026-10-10", "amount": 10000, "payer": "UNKNOWN",
                "reference": "XX 11 INV 4471"}], [{"id": "n", "name": "Nora Wells", "reference": "NW-011",
                                                  "cashDue": 10000}], as_of="2026-10-12")["lines"]["x"]
eq("REVIEW partial by run digits", (x["status"], x["candidates"]), ("suggested", [{"id": "n", "score": 0.5}]))

from oracle import name_similarity  # noqa: E402
ss = [{"id": "s", "name": "Sam Stone", "reference": "SS-001", "cashDue": 10000}]
for memo in ("\u00df001", "Payment SS001\u00c9"):
    x = rec(None, [{"id": "x", "txnId": "x", "date": "2026-10-10", "amount": 1, "payer": "", "reference": memo}],
            ss, as_of="2026-10-12")["lines"]["x"]
    check("v0.7.2 token %r not exact" % memo, x["status"] != "auto" and x["candidates"] == [], repr(x))
eq("v0.7.2 J.A. SMITH", name_similarity("J.A. SMITH", "John Andrew Smith"), 1)
eq("v0.7.2 SMITH,JOHN", name_similarity("SMITH,JOHN", "John Smith"), 1)

eq("v0.7.2 ref E-acute invalid", rec(None, [], [{"id": "e", "name": "Eve", "reference": "\u00c9001",
                                                  "cashDue": 100}], as_of="2026-10-12"), {"ok": False})
eq("v0.7.2 21 fees invalid", alloc([("A", 100000, "none")],
                                   [{"id": "f%d" % i, "kind": "fixed", "value": 1, "payer": "lead"} for i in range(21)]),
   {"ok": False})
r = alloc([("i%d" % i, 100000000000, "none") for i in range(500)],
          [{"id": "l%d" % i, "kind": "percent", "value": 10000, "payer": "lead"} for i in range(20)])
eq("v0.7.2 20 fees x 500 max", (r["ok"], r["totalInvested"], r["leadInvoice"]),
   (True, 50000000000000, 1000000000000000))

from oracle import tokens, name_words, digits_int, edit_distance  # noqa: E402
eq("v0.7.2b SS001E-acute", tokens("SS001\u00c9"), ["SS001\u00c9"])
eq("v0.7.2b en dash", tokens("NW-001\u2013X"), ["NW", "001\u2013X"])
eq("v0.7.2b Ref NW001 U+01A4", tokens("Ref NW001 \u01a4"), ["REF", "NW001", "\u01a4"])
eq("v0.7.2b Jose Garcia", name_words("Jos\u00e9 Garc\u00eda"), ["JOS\u00e9", "GARC\u00edA"])
eq("v0.7.2b J.A. SMITH", name_words("J.A. SMITH"), ["J", "A", "SMITH"])
eq("v0.7.2b non-ASCII digits ignored", digits_int("NW \u0661\u0662 7"), 7)
eq("v0.7.2b edit distance by code point", edit_distance("NW001\U0001F600", "NW001"), 1)


# ---------------------------------------------------------------- v0.8 §2.5: fee payer change (C-ALL-10)
def fpc(investors, fees, fee_id, new_payer, basis="deducted", minimum=0, cap=None, price=GBP1, applied=None):
    case = {"kind": "feePayerChange", "feeBasis": basis, "minimum": minimum, "cap": cap, "priceMicros": price,
            "fees": list(fees), "feeId": fee_id, "newPayer": new_payer,
            "investors": [{"id": i, "cashDue": d} for i, d in investors]}
    if applied is not None:
        case["applied"] = applied
    return run(case)


def codes(r):
    return [(b["code"], b["investor"]) for b in r["blockers"]]


F3I = {"id": "f", "kind": "percent", "value": 300, "payer": "investors"}
F3C = {"id": "f", "kind": "percent", "value": 300, "payer": "company"}

r = fpc([("A", 100000)], [F3I], "f", "company")
a = r["investors"]["A"]
eq("ALL-31 / C-ALL-10 ex1", (a["target"], a["newCashDue"], a["difference"], r["feeBefore"], r["feeAfter"],
                             r["canApply"]), (97000, 97000, -3000, 3000, 2910, True))

r = fpc([("A", 100000)], [F3C], "f", "investors")
a = r["investors"]["A"]
eq("ALL-32 / C-ALL-10 ex2", (a["target"], a["newCashDue"], a["difference"], r["canApply"]), (100000, 103093, 3093, True))
x = alloc([("A", 103093, "none")], [PF3])["investors"]["A"]
eq("ALL-32 fee/refund at N", (x["invested"], x["fees"], x["refund"]), (100000, {"pf": 3093}, 0))
eq("ALL-32 at 1,030.92", alloc([("A", 103092, "none")], [PF3])["investors"]["A"]["invested"], 99999)

r = fpc([("A", 100000)], [F3I], "f", "company", minimum=100000)
eq("ALL-33 / C-ALL-10 ex3", (codes(r), r["canApply"], r["investors"]["A"]["newCashDue"]),
   ([("after-no-participants", None), ("would-fall-below-minimum", "A")], False, 97000))

r = fpc([("A", 100000)], [F3C], "f", "investors", basis="onTop")
a = r["investors"]["A"]
eq("ALL-34 (1) onTop", (a["target"], a["newCashDue"], a["difference"], r["canApply"]), (100000, 103000, 3000, True))
x = alloc([("A", 103000, "none")], [PF3], basis="onTop")["investors"]["A"]
eq("ALL-34 (1) fee at N", (x["invested"], x["fees"]), (100000, {"pf": 3000}))
fees34 = [{"id": "fix", "kind": "perInvestor", "value": 2500, "payer": "investors"},
          {"id": "p2", "kind": "percent", "value": 200, "payer": "investors"}]
x = alloc([("A", 102500, "none")], fees34)["investors"]["A"]
eq("ALL-34 (2) step 1", (x["invested"], x["fees"], x["refund"]), (98000, {"fix": 2500, "p2": 2000}, 0))
r = fpc([("A", 102500)], fees34, "p2", "company")
a = r["investors"]["A"]
eq("ALL-34 (2)", (a["target"], a["newCashDue"], a["difference"], r["canApply"]), (98000, 100500, -2000, True))

r = fpc([("A", 100000), ("B", 200000)], [F3I], "f", "company", basis="onTop", minimum=100000)
eq("ALL-40 step 1", (r["investors"]["A"]["participatingBefore"], r["investors"]["B"]["participatingBefore"],
                     r["investors"]["A"]["unchanged"]), (False, True, True))
eq("ALL-40 blockers", (codes(r), r["canApply"]), ([("would-join", "A")], False))
from oracle import _m_of  # noqa: E402
eq("ALL-40 M values", (_m_of({"feeBasis": "onTop"}, [F3I], 100000), _m_of({"feeBasis": "onTop"}, [], 100000)),
   (97087, 100000))

r = fpc([("A", 100000), ("B", 50000)], [F3I], "f", "company", minimum=97000)
eq("ALL-44", (r["canApply"], r["investors"]["A"]["newCashDue"], r["investors"]["B"]["unchanged"],
              r["investors"]["B"]["newCashDue"], r["investors"]["B"]["difference"]), (True, 97000, True, 50000, 0))

# sample deal (Test Plan §3): cash due list, platform 3% investors, legal £1,500 company, cap £150,000
sample_due = [(i, d) for i, _, d in names]
SFEES = [{"id": "platform", "kind": "percent", "value": 300, "payer": "investors"},
         {"id": "legal", "kind": "fixed", "value": 150000, "payer": "company"}]
r = fpc(sample_due, SFEES, "platform", "company", minimum=100000, cap=15000000, price=2413700)
eq("ALL-35 blocked (Isla)", (codes(r), r["investors"]["isla"]["newCashDue"], r["canApply"]),
   ([("would-fall-below-minimum", "isla")], 97000, False))
r = fpc(sample_due, SFEES, "platform", "company", minimum=97000, cap=15000000, price=2413700)
check("ALL-35 N = 97% each", all(r["investors"][i]["newCashDue"] * 100 == d * 97 for i, d in sample_due))
eq("ALL-35 totals", (r["canApply"], r["totals"]["cashDue"], r["totals"]["newCashDue"], r["totals"]["difference"],
                     r["feeBefore"], r["feeAfter"]), (True, 12400000, 12028000, -372000, 372000, 360840))
eq("R-ALL-12.3 apply text numbers", (r["totals"]["topUpCount"], r["totals"]["topUpTotal"], r["totals"]["refundCount"],
                                     r["totals"]["refundTotal"]), (0, 0, 12, 372000))
saved_T = {i: v["target"] for i, v in r["investors"].items()}
saved_N = {i: v["newCashDue"] for i, v in r["investors"].items()}

r = fpc(sample_due, SFEES, "platform", "company", minimum=100000, cap=8000000, price=2413700)
eq("ALL-41 over cap", (("over-cap", None) in codes(r), r["canApply"], r["totals"]["difference"],
                       r["investors"]["amelia"]["difference"]), (True, False, None, None))

# TC-ALL-42 / 46: re-check step 3 with the saved T_i and the current settings
cur = [dict(SFEES[0], payer="company"), SFEES[1]]
applied = {"targets": saved_T, "newCashDue": saved_N}
r = fpc(sample_due, cur, "platform", "company", minimum=100000, cap=15000000, price=2413700, applied=applied)
eq("ALL-42 min back to 1,000", codes(r), [("would-fall-below-minimum", "isla")])
cur46 = cur + [{"id": "adm", "kind": "perInvestor", "value": 1000, "payer": "investors"}]
r = fpc(sample_due, cur46, "platform", "company", minimum=97000, cap=15000000, price=2413700, applied=applied)
eq("ALL-46 Isla 970 -> 960", (r["investors"]["isla"]["target"], r["investors"]["isla"]["investedAfter"],
                              ("invested-differs", "isla") in codes(r), r["canApply"]), (97000, 96000, True, False))

eq("ALL-38 (5) p' = 100% invalid",
   fpc([("A", 100000)], [{"id": "a", "kind": "percent", "value": 6000, "payer": "investors"},
                         {"id": "b", "kind": "percent", "value": 4000, "payer": "company"}], "b", "investors"),
   {"ok": False})
eq("ALL-38 (4) fixed fee not selectable",
   fpc([("A", 100000)], [{"id": "b", "kind": "fixed", "value": 4000, "payer": "company"}], "b", "lead"), {"ok": False})

# TC-ALL-43: random inputs (fixed seed), N gives I(N) = T and N - 1 gives I < T
import random  # noqa: E402
from oracle import single_invested  # noqa: E402
rng = random.Random(20261023)
bad43 = []
n43 = 0
for k in range(3000):
    basis = rng.choice(["deducted", "onTop"])
    fs = [{"id": "p%d" % j, "kind": "percent", "value": rng.randint(0, 1500), "payer": rng.choice(["investors", "company"])}
          for j in range(rng.randint(1, 5))]
    if rng.random() < 0.5:
        fs.append({"id": "fx", "kind": "perInvestor", "value": rng.randint(1, 5000), "payer": "investors"})
    sel_id = rng.choice([f["id"] for f in fs if f["kind"] == "percent"])
    newp = rng.choice([q for q in ("investors", "company", "lead") if q != [f for f in fs if f["id"] == sel_id][0]["payer"]])
    due_ = rng.randint(1, 5000000)
    r = fpc([("A", due_)], fs, sel_id, newp, basis=basis)
    if r.get("ok") is False:
        continue
    a = r["investors"]["A"]
    if not a["participatingBefore"]:
        continue
    fs2 = [dict(f, payer=newp) if f["id"] == sel_id else f for f in fs]
    cs = {"feeBasis": basis, "priceMicros": GBP1}
    T, N = a["target"], a["newCashDue"]
    n43 += 1
    if single_invested(cs, fs2, N) != T or (N > 1 and single_invested(cs, fs2, N - 1) >= T):
        bad43.append((k, due_, T, N))
check("ALL-43 random 3,000: I(N) = T, I(N-1) < T", not bad43, repr(bad43[:3]))
check("ALL-43 enough participating samples", n43 > 2500, repr(n43))

# ---------------------------------------------------------------- v0.8 §2.5: withdrawal (C-REC-7)
reviewed = {"t03": {"assign": "chloe"}, "t05": {"assign": "elena"}, "t12": {"assign": "kavya"},
            "t11": {"reject": True}, "t14": {"reject": True}}


def recw(withdrawn, lines_=None, adjusted=None):
    case = {"kind": "reconcile", "asOf": "2026-10-16", "thresholdDays": 10, "commitments": commitments,
            "lines": lines_ if lines_ is not None else lines, "decisions": reviewed, "withdrawn": withdrawn}
    if adjusted is not None:
        case["adjustedCashDue"] = adjusted
    return run(case)


base_r = recw([])
r = recw(["lucas"])
eq("REC-47 status", (r["commitments"]["lucas"]["status"], r["commitments"]["lucas"]["withdrawn"]), ("withdrawn", True))
check("REC-47 not chased", all(x["id"] != "lucas" for x in r["chase"]))
check("REC-47 not handed off", "lucas" not in r["handoff"])
eq("REC-47 refunds", r["refunds"], [{"id": "hugo", "amount": 500000, "reason": "overpayment"},
                                    {"id": "lucas", "amount": 300000, "reason": "withdrawn"}])
eq("REC-47 receivable", (base_r["receivable"], base_r["receivable"] - r["receivable"]), (12400000, 300000))
eq("REC-47 summary", r["withdrawnSummary"], {"count": 1, "refund": 300000})
eq("REC-47 identity", (r["refundTotal"], r["checks"]["refundIdentity"]), (800000, True))

t17 = {"id": "t17", "txnId": "t17", "date": "2026-10-16", "amount": 50000, "payer": "", "reference": "NW-012"}
r = recw(["lucas"], lines + [t17])
eq("REC-50", (r["lines"]["t17"]["status"], r["lines"]["t17"]["assignedTo"],
              [x for x in r["refunds"] if x["id"] == "lucas"]), ("auto", "lucas",
                                                                 [{"id": "lucas", "amount": 350000, "reason": "withdrawn"}]))

r = recw(["james"])
eq("REC-51", (any(x["id"] == "james" for x in r["chase"]), any(x["id"] == "james" for x in r["refunds"]),
              base_r["receivable"] - r["receivable"], r["withdrawnSummary"]), (False, False, 2000000, {"count": 1, "refund": 0}))

# C-ALL-11 effective cash due (TC-ALL-36 Amelia; TC-IO-47 David)
adj = {i: d * 97 // 100 for i, d in sample_due}
r = recw([], adjusted=adj)
eq("ALL-36 Amelia effective", (r["commitments"]["amelia"]["cashDue"], r["commitments"]["amelia"]["status"],
                               r["commitments"]["amelia"]["difference"]), (970000, "overpaid", 30000))
check("ALL-36 Amelia refund", {"id": "amelia", "amount": 30000, "reason": "overpayment"} in r["refunds"])
eq("IO-47 David chase", [x for x in r["chase"] if x["id"] == "david"], [{"id": "david", "outstanding": 42500}])
eq("IO-47 David effective", r["commitments"]["david"]["cashDue"], 242500)
eq("v0.8 compat: no new keys without new fields", sorted(rec(reviewed).keys()), ["aged", "commitments", "lines", "totals"])
eq("v0.8 withdrawn unknown id invalid", recw(["nobody"]), {"ok": False})

# ================================================================ v0.9 §2.6: decision J (TC-J-*)
OLD_PASSED = PASSED
OLD_FAILED = len(FAILED)
from oracle import projection_hash  # noqa: E402


def j_alloc(investors, fees=(), basis="deducted", minimum=0, cap=None, price=GBP1, pf=None, instrument=None):
    """investors: (id, received, ownTerms or None[, scheme])."""
    case = {"kind": "allocation", "feeBasis": basis, "minimum": minimum, "cap": cap, "priceMicros": price,
            "fees": list(fees), "investors": []}
    for t in investors:
        inv = {"id": t[0], "received": t[1], "scheme": t[3] if len(t) > 3 else "none"}
        if t[2] is not None:
            inv["ownTerms"] = t[2]
        case["investors"].append(inv)
    if pf is not None:
        case["platformFee"] = pf
    if instrument is not None:
        case["instrument"] = instrument
    return run(case)


def own(mode, kind=None, value=None):
    return {"mode": mode, "fee": None if kind is None else {"kind": kind, "value": value}}


def pfee(rate, minimum=0, maximum=None, thr=None, add=None, payer="investors"):
    return {"rate": rate, "minimum": minimum, "maximum": maximum, "addOnThreshold": thr, "addOnRate": add,
            "payer": payer}


def iv(r, i, *keys):
    return tuple(r["investors"][i][k] for k in keys)


# TC-J-02 C-ALL-0 replaces the deal's investor-paid items
r = j_alloc([("X", 1040000, own("onTop", "percent", 400)), ("Y", 1000000, None)], [PF3])
eq("J-02 X", iv(r, "X", "target", "ownFee", "fees", "refund"), (1000000, 40000, {}, 0))
eq("J-02 Y", iv(r, "Y", "target", "fees", "refund"), (970000, {"pf": 30000}, 0))
# TC-J-03 own terms without a cash fee
r = j_alloc([("X", 500000, own("deducted"))], [PF3])
eq("J-03", iv(r, "X", "target", "ownFee", "refund"), (500000, 0, 0))
# TC-J-04 fixed own fee above receipt
r = j_alloc([("X", 20000, own("deducted", "fixed", 25000))])
eq("J-04", iv(r, "X", "participating", "exclusion", "refund"), (False, "fees-exceed-receipt", 20000))
# format v1 §3: M <= 0 under C-ALL-1 (R > F) is fees-exceed-receipt
r = j_alloc([("X", 1, own("deducted", "percent", 9999))])
eq("FMT §3 M <= 0", iv(r, "X", "participating", "exclusion", "refund"), (False, "fees-exceed-receipt", 1))
# TC-J-05 minimum on M for on top fixed fee
r = j_alloc([("X", 1025000, own("onTop", "fixed", 25000))], minimum=1000000)
eq("J-05 at minimum", iv(r, "X", "participating", "target"), (True, 1000000))
r = j_alloc([("X", 1024999, own("onTop", "fixed", 25000))], minimum=1000000)
eq("J-05 1p below", iv(r, "X", "participating", "exclusion"), (False, "below-minimum"))
# TC-J-06 C-ALL-3 commitment basis per person (R30)
j06 = [("X", 2000000, own("deducted", "fixed", 25000)), ("Y", 10000000, None)]
r = j_alloc(j06, cap=10000000, minimum=1660000)
eq("J-06 T", (r["investors"]["X"]["target"], r["investors"]["Y"]["target"]), (1649269, 8350731))
eq("J-06 16,600 closes", r["blockers"], [])
r = j_alloc(j06, cap=10000000, minimum=1680000)
eq("J-06 16,800 blocks X", (r["blockers"], r["blockerIds"]),
   (["scale-back-below-minimum"], {"scale-back-below-minimum": ["X"]}))
# TC-J-07 deducted 100% invalid (names X); on top 100% legal, M = floor(R / 2)
eq("J-07 deducted 100%", j_alloc([("X", 100000, own("deducted", "percent", 10000))]),
   {"ok": False, "error": "own-rate-100", "investor": "X"})
r = j_alloc([("X", 100001, own("onTop", "percent", 10000))])
eq("J-07 on top 100%", iv(r, "X", "participating", "target"), (True, 50000))

# TC-J-08 C-ALL-9b formula (lead pays so nothing blocks; B = one investor's T)
for B, want in ((10000000, 400000), (50000000, 1250000), (100000000, 2000000), (600000000, 2100000)):
    r = j_alloc([("A", B, None)], pf=pfee(250, 400000, 2000000, 500000000, 10, payer="lead"))
    eq("J-08 B=%d" % B, r["platformFee"]["amount"], want)
r = j_alloc([("A", 100000000, None)], pf=pfee(250, 400000, None, 500000000, 10, payer="lead"))
eq("J-08 no maximum", r["platformFee"]["amount"], 2500000)
r = j_alloc([("A", 100, None)], pf=pfee(50, 0, None, 0, 50, payer="lead"))
eq("J-08 each part rounded", r["platformFee"]["amount"], 2)
# TC-J-09 investor-paid platform fee
pf09 = pfee(250, 400000)
r = j_alloc([("A", 10400000, own("onTop", "percent", 400)), ("B", 10000000, own("deducted", "percent", 400))], pf=pf09)
eq("J-09 fee", (r["platformFee"]["base"], r["platformFee"]["amount"]), (19600000, 490000))
eq("J-09 A", iv(r, "A", "platformFeeShare", "invested"), (250000, 9750000))
eq("J-09 B", iv(r, "B", "platformFeeShare", "invested"), (240000, 9360000))
eq("J-09 identity", (r["received"], r["totalInvested"], r["investorFees"], r["refunds"]),
   (20400000, 19110000, 800000, 0))
# TC-J-10 remainder ties to the earlier person
r = j_alloc([("A", 10000, None), ("B", 10000, None)], pf=pfee(0, 3, 3))
eq("J-10", (r["investors"]["A"]["platformFeeShare"], r["investors"]["B"]["platformFeeShare"]), (2, 1))
r = j_alloc([("B", 10000, None), ("A", 10000, None)], pf=pfee(0, 3, 3))
eq("J-10 reversed", (r["investors"]["B"]["platformFeeShare"], r["investors"]["A"]["platformFeeShare"]), (2, 1))
# TC-J-11 B = 0: no platform fee
r = j_alloc([("A", 50000, None)], minimum=100000, pf=pfee(0, 400000))
eq("J-11", (r["platformFee"], r["investors"]["A"]["refund"], r["blockers"]), (None, 50000, ["no-participants"]))
# TC-J-12 / TC-J-55 / TC-J-58 blocked platform fee
r = j_alloc([("A", 50000, None)], pf=pfee(0, 50000))
eq("J-12 S = T", (r["blockers"], r["blockerIds"], iv(r, "A", "target", "platformFeeShare")),
   (["platform-fee-exceeds"], {"platform-fee-exceeds": ["A"]}, (50000, 50000)))
r = j_alloc([("A", 50000, None)], pf=pfee(0, 60000))
eq("J-12 fee > B", (r["blockers"], r["blockerIds"], r["platformFee"]["amount"], r["platformFee"]["base"]),
   (["platform-fee-exceeds"], {"platform-fee-exceeds": ["A"]}, 60000, 50000))
eq("J-55 diagnostics", iv(r, "A", "invested", "microShares", "claimableShares", "claimableAmount"), (-10000, 0, 0, 0))
r = j_alloc([("A", 50000, None)], [{"id": "c1", "kind": "percent", "value": 100, "payer": "company"}], pf=pfee(0, 60000))
eq("J-58 9a not computed", (r["blockers"], r["companyFees"], r["wire"], r["feeTotals"]["c1"]),
   (["platform-fee-exceeds"], None, None, None))
# TC-J-13 payer company / lead
r = j_alloc([("A", 10000000, None)], pf=pfee(250, payer="company"))
eq("J-13 company", (r["investors"]["A"]["invested"], r["wire"]), (10000000, 9750000))
r = j_alloc([("A", 10000000, None)], pf=pfee(250, payer="lead"))
eq("J-13 lead", (r["investors"]["A"]["invested"], r["leadInvoice"], r["wire"]), (10000000, 250000, 10000000))
# TC-J-14 C-ALL-9a base after the investor-paid platform fee
r = j_alloc([("A", 10000000, None)], [{"id": "c1", "kind": "percent", "value": 100, "payer": "company"}], pf=pfee(250))
eq("J-14", (r["platformFee"]["amount"], r["investors"]["A"]["invested"], r["feeTotals"]["c1"], r["wire"]),
   (250000, 9750000, 97500, 9652500))
# TC-J-15 instruments
r = j_alloc([("A", 1000000, None, "SEIS")], price=None, instrument="convertible")
eq("J-15 convertible", iv(r, "A", "invested", "microShares", "claimableShares", "claimableAmount"),
   (1000000, None, None, None))
eq("J-15 price must be empty", j_alloc([("A", 1000000, None)], price=GBP1, instrument="convertible"),
   {"ok": False, "error": "share-price-not-empty"})
r = run({"kind": "feePayerChange", "feeBasis": "deducted", "minimum": 0, "cap": None, "priceMicros": None,
         "instrument": "fund_units", "fees": [F3I], "feeId": "f", "newPayer": "company",
         "investors": [{"id": "A", "cashDue": 1000000}]})
eq("J-15 fund_units preview", (r.get("ok"), r.get("canApply"), r["investors"]["A"]["newCashDue"]), (True, True, 970000))


# TC-J-16 / TC-J-17 / TC-J-57 fee payer change
def j_fpc(investors, fees, fee_id, new_payer, pf=None, **kw):
    case = {"kind": "feePayerChange", "feeBasis": kw.get("basis", "deducted"), "minimum": kw.get("minimum", 0),
            "cap": kw.get("cap"), "priceMicros": GBP1, "fees": list(fees), "feeId": fee_id, "newPayer": new_payer,
            "investors": investors}
    if pf is not None:
        case["platformFee"] = pf
    return run(case)


r = j_fpc([{"id": "A", "cashDue": 1000000, "ownTerms": own("onTop", "percent", 400)}, {"id": "B", "cashDue": 1000000}],
          [F3I], "f", "company")
eq("J-16 own fee terms disable", r, {"ok": True, "disabled": "own-fee-terms"})
r = j_fpc([{"id": "A", "cashDue": 1000000, "carry": 2000}], [F3I], "f", "company")
eq("J-16 carry only available", (r["ok"], r["canApply"]), (True, True))
r = j_fpc([{"id": "A", "cashDue": 20000000}], [F3I], "f", "company", pf=pfee(250, 400000))
a = r["investors"]["A"]
eq("J-17", (a["target"], a["newCashDue"], a["difference"], a.get("targetAfter"), r["canApply"]),
   (19400000, 19400000, -600000, 19400000, True))
r = j_fpc([{"id": "A", "cashDue": 50000}], [F3I], "f", "company", pf=pfee(0, 60000))
eq("J-57 blocked", (r["canApply"], [b["code"] for b in r["blockers"]]), (False, ["before-platform-fee-exceeds"]))
eq("J-57 T = 485.00", j_alloc([("A", 50000, None)], [F3I], pf=pfee(0, 60000))["investors"]["A"]["target"], 48500)
# TC-J-60 base after C-ALL-7
r = j_alloc([("A", 3, None)], [dict(F3I, id="f1", value=2500), dict(F3I, id="f2", value=2500)], basis="onTop",
            pf=pfee(2500))
eq("J-60", (iv(r, "A", "target", "fees", "refund"), r["platformFee"]["amount"], r["blockers"]),
   ((1, {"f1": 0, "f2": 0}, 2), 0, []))
# TC-J-61 base after scale-back
r = j_alloc([("A", 10000000, None), ("B", 10000000, None)], cap=10000000, pf=pfee(250))
eq("J-61", ([iv(r, i, "target", "platformFeeShare", "invested", "refund") for i in "AB"],
            r["platformFee"]["base"], r["platformFee"]["amount"]),
   ([(5000000, 125000, 4875000, 5000000)] * 2, 10000000, 250000))


# ---------------------------------------------------------------- reconcile (C-REC-4, C-REC-9)
def j_rec(comms, lines_=(), withdrawn=None):
    case = {"kind": "reconcile", "asOf": "2026-10-16", "thresholdDays": 10, "commitments": comms,
            "lines": list(lines_), "decisions": {}}
    if withdrawn is not None:
        case["withdrawn"] = withdrawn
    return run(case)


def cm(cid, ref, due, name="Amelia Hart", **kw):
    d = {"id": cid, "name": name, "reference": ref, "cashDue": due}
    d.update(kw)
    return d


def ln_(lid, amount, ref, payer="A HART"):
    return {"id": lid, "txnId": lid, "date": "2026-10-10", "amount": amount, "payer": payer, "reference": ref}


r = j_rec([cm("A", "NW-001", 1000000, refunded=100000)], [ln_("t1", 1100000, "NW-001")])
eq("J-20 net", (r["commitments"]["A"]["received"], r["commitments"]["A"]["status"], r["refunds"]), (1000000, "paid", []))
r = j_rec([cm("A", "NW-001", 1000000)], [ln_("t1", 1100000, "NW-001")], withdrawn=[])
eq("J-20 no refunded = v0.8", (r["commitments"]["A"]["status"], r["refunds"]),
   ("overpaid", [{"id": "A", "amount": 100000, "reason": "overpayment"}]))
r = j_rec([cm("A", "NW-001", 100000, refunded=50000), cm("B", "NW-002", 100000, name="Bo Li", refunded=50000,
                                                          refundOnly="closed")])
eq("J-21", ([r["commitments"][i]["status"] for i in "AB"], r["chase"], r["handoffBlockedBy"]),
   (["check-refunds", "check-refunds"], [], ["A", "B"]))
r = j_rec([cm("A", "NW-001", 100000, refundOnly="closed"), cm("C", "NW-003", 50000, name="Cy Ng")],
          [ln_("t1", 100000, "NW-001")])
eq("J-22", (r["commitments"]["A"]["status"], [x["id"] for x in r["chase"]], r["receivable"], r["refunds"],
            "A" in r["handoff"], r["withdrawnSummary"]["count"]),
   ("closed-refund-only", ["C"], 50000, [{"id": "A", "amount": 100000, "reason": "refund-only"}], False, 1))
r = j_rec([cm("A", "NW-001", 100000, refundOnly="withdrawn")], [ln_("t1", 40000, "NW-001")], withdrawn=["A"])
eq("J-23 flag", (r["commitments"]["A"]["status"], r["refunds"]),
   ("withdrawn-imported", [{"id": "A", "amount": 40000, "reason": "withdrawn"}]))
r = j_rec([cm("A", "NW-001", 100000, refundOnly=None)], [ln_("t1", 40000, "NW-001")], withdrawn=["A"])
eq("J-23 cleared -> manual", (r["commitments"]["A"]["status"], r["refunds"]),
   ("withdrawn", [{"id": "A", "amount": 40000, "reason": "withdrawn"}]))
c25 = [ln_("t1", 900000, "NW-001"), ln_("t2", 200000, "NW-002", payer="ZED QUINN")]
r = j_rec([cm("A", "NW-001", 1000000, refunded=100000)], c25)
eq("J-25 net outstanding", (r["lines"]["t2"]["status"], r["lines"]["t2"]["candidates"]),
   ("suggested", [{"id": "A", "score": 0.5}]))
r = j_rec([cm("A", "NW-001", 1000000)], c25)
eq("J-25 no refunded", (r["lines"]["t2"]["status"], r["lines"]["t2"]["candidates"]), ("unmatched", []))
r = j_rec([cm("A", "NW-001", 1000000, refunded=100000)], c25[:1])
eq("J-32 chase net", (r["commitments"]["A"]["received"], r["commitments"]["A"]["refunded"], r["chase"]),
   (800000, 100000, [{"id": "A", "outstanding": 200000}]))
r = j_rec([cm("A", "NW-001", 100000, refundOnly="closed"), cm("B", "NW-002", 100000, name="Bo Li"),
           cm("C", "NW-003", 100000, name="Cy Ng", refunded=0)],
          [ln_("t1", 100000, "NW-001"), ln_("t2", 120000, "NW-002"), ln_("t3", 30000, "NW-003")], withdrawn=["C"])
eq("J-27", (r["refundTotal"], r["checks"]["refundIdentity"]), (150000, True))


# ---------------------------------------------------------------- waterfall (C-DIS-8, C-DIS-9)
def j_wf(hold, G, k=2000, h=0, c=0, years100=100, tiers=None, payees=None, E=0):
    carry = {"mode": "tiered", "tiers": tiers} if tiers else {"mode": "fixed", "k": k, "h": h, "c": c}
    case = {"kind": "waterfall", "holdings": [dict(id=i, capital=cap, **({} if ck == "-" else {"carry": ck}))
                                              for i, cap, ck in hold],
            "proceeds": G, "exitCosts": E, "years100": years100, "carry": carry}
    if payees is not None:
        case["payees"] = payees
    return run(case)


h33 = [("A", 10000000, 2000), ("B", 5000000, 0), ("C", 5000000, 1000)]
r = j_wf(h33, 30000000)
eq("J-33 carry", [r["perInvestor"][i]["carry"] for i in "ABC"], [1000000, 0, 250000])
eq("J-33 dist", ([r["distributions"][i] for i in "ABC"], r["carry"]), ([14000000, 7500000, 7250000], 1250000))
r = j_wf(h33, 30000000, h=800, years100=100)
eq("J-34", [r["perInvestor"][i]["carry"] for i in "ABC"], [840000, 0, 210000])
r = j_wf([("A", 10000000, 1000), ("B", 10000000, 1000)], 30000000)
eq("J-35", (r["carry"], r["distributions"], r["perInvestor"]), (1000000, {"A": 14500000, "B": 14500000}, None))
ra = j_wf([("A", 6000000, None), ("B", 4000000, 2000)], 30000000, h=800, years100=500)
rb = j_wf([("A", 6000000, "-"), ("B", 4000000, "-")], 30000000, h=800, years100=500)
eq("J-36 blank = k", {k_: ra[k_] for k_ in rb}, rb)
T37 = [{"upTo100": 300, "rate": 2000}, {"upTo100": None, "rate": 3000}]
rb = j_wf([("A", 6000000, "-"), ("B", 4000000, "-")], 30000000, tiers=T37)
r = j_wf([("A", 6000000, None), ("B", 4000000, None)], 30000000, tiers=T37)
eq("J-37 all blank", ({k_: r[k_] for k_ in rb}, r["tieredNotice"]), (rb, None))
r = j_wf([("A", 6000000, 1000), ("B", 4000000, 1000)], 30000000, tiers=T37)
eq("J-37 all 10%", ({k_: r[k_] for k_ in rb}, r["tieredNotice"], r["carryUsed"]), (rb, 1000, None))
eq("J-37 mixed", j_wf([("A", 6000000, None), ("B", 4000000, 1000)], 30000000, tiers=T37),
   {"ok": False, "error": "tiered-carry-mixed"})
eq("J-37 differ", j_wf([("A", 6000000, 1000), ("B", 4000000, 2000)], 30000000, tiers=T37),
   {"ok": False, "error": "tiered-carry-differs"})
eq("J-38 (a)", j_wf([("A", 10000000, 2000), ("B", 10000000, 0)], 30000000, h=800, c=1500),
   {"ok": False, "error": "catch-up-k", "investor": "A"})
r = j_wf([("A", 10000000, 1000), ("B", 10000000, 0)], 30000000, h=800, c=1500)
pa = r["perInvestor"]["A"]
eq("J-38 (b) A", (pa["hurdlePaid"], pa["catchUpTranche"], pa["catchUpToLead"], pa["carry"], pa["distribution"]),
   (800000, 1600000, 240000, 500000, 14500000))
eq("J-38 (b) B", (r["perInvestor"]["B"]["catchUpTranche"], r["perInvestor"]["B"]["carry"], r["distributions"]["B"]),
   (0, 0, 15000000))
r = j_wf([("A", 10000000, 1000), ("B", 10000000, 1000)], 30000000, h=800, c=1500)
eq("J-38 (c) original algorithm", (r["ok"], r["perInvestor"]), (True, None))
r = j_wf(h33, 30000000, payees=[{"name": "P1", "share": 5000}, {"name": "P2", "share": 3000}, {"name": "P3", "share": 2000}])
eq("J-39 50/30/20", [p_["amount"] for p_ in r["payees"]], [625000, 375000, 250000])
r = j_wf([("A", 100, None)], 105, payees=[{"name": "P1", "share": 5000}, {"name": "P2", "share": 5000}])
eq("J-39 1p", (r["carry"], [p_["amount"] for p_ in r["payees"]]), (1, [1, 0]))
eq("J-39 99%", j_wf(h33, 30000000, payees=[{"name": "P1", "share": 9900}]), {"ok": False, "error": "payee-sum"})
eq("J-39 0%", j_wf(h33, 30000000, payees=[{"name": "P1", "share": 10000}, {"name": "P2", "share": 0}]),
   {"ok": False, "error": "payee-share-zero"})
eq("J-39 21 payees", j_wf(h33, 30000000, payees=[{"name": "P%d" % q, "share": 500} for q in range(20)]
                          + [{"name": "P21", "share": 0}]), {"ok": False, "error": "payee-count"})
r = j_wf([("A", 100, 0), ("B", 100, 1000), ("C", 100, 2000)], 3)
eq("J-40 D=3", [r["perInvestor"][i]["distributable"] for i in "ABC"], [1, 1, 1])
r = j_wf([("A", 100, 0), ("B", 100, 1000), ("C", 100, 2000)], 2)
eq("J-40 D=2", [r["perInvestor"][i]["distributable"] for i in "ABC"], [1, 1, 0])
r = j_wf([("A", 100, 0), ("B", 200, 1000), ("C", 300, 2000)], 2)
eq("J-40 1:2:3", [r["perInvestor"][i]["distributable"] for i in "ABC"], [0, 1, 1])
r = j_wf(h33, 30000000, payees=[{"name": "Payee 1", "share": 7000}, {"name": "Payee 2", "share": 3000}])
eq("J-62 payees", (r["payees"], r["carryUsed"]), ([{"name": "Payee 1", "amount": 875000},
                                                  {"name": "Payee 2", "amount": 375000}], {"A": 2000, "B": 0, "C": 1000}))
r = run({"kind": "waterfall", "holdings": holdings, "proceeds": 39000000, "exitCosts": 450000, "years100": 600,
         "carry": {"mode": "fixed", "k": 2000, "h": 800, "c": 10000}, "payees": None})
eq("J-62 sample Lead", (r["payees"], r["carryUsed"]), ([{"name": "Lead", "amount": 5702100}], None))


# ---------------------------------------------------------------- hand-off (C-ALL-12, format v1)
def part(pid, order, amount, mode="on_top", fee=None, carry="0", decision="allocate", **extra):
    if decision != "allocate":
        return {"id": pid, "order": str(order), "status": "withdrawn", "decision": decision}
    d = {"id": pid, "order": str(order), "status": "active", "decision": decision,
         "terms": {"fee_mode": mode, "fee": fee, "carry_bps": carry},
         "commitment": amount, "cash_due": amount, "allocation_amount": amount, "scheme": "none"}
    d.update(extra)
    return d


def request(parts, pf=None, price="1000000", instrument="equity", currency="GBP", names=None, rehash=True, **proj):
    pr = {"currency": currency, "instrument": instrument, "minimum": "0", "deal_fees": [], "participants": parts}
    if price is not None:
        pr["share_price_micros"] = price
    if pf is not None:
        pr["platform_fee"] = pf
    pr.update(proj)
    bk = [{"id": p_["id"], "name": (names or {}).get(p_["id"], "Name " + p_["id"])} for p_ in parts]
    return {"format": "goten.allocation-request/1", "handoff_id": "ho_test1", "deal_id": "deal_1",
            "engine": "goten-rules/0.9", "projection_hash": projection_hash(pr), "projection": pr,
            "bookkeeping": {"participants": bk}}


def ho(req, **kw):
    return run(dict({"kind": "handoff", "request": req, "dealCurrency": "GBP"}, **kw))


RATE4 = {"kind": "rate", "rate_bps": "400"}
# format §1/§2 example: on top 4%, £10,000, 2.5% investors, price £1.25
r = ho(request([part("p1", 1, "1040000", fee=RATE4, carry="2000")], pf={"rate_bps": "250", "minimum": "0",
                                                                         "payer": "investors"}, price="1250000"))
eq("FMT §1 example", {k_: r["result"]["participants"][0][k_] for k_ in
                      ("target", "own_fee", "platform_fee_share", "invested", "refund", "micro_shares")},
   {"target": "1000000", "own_fee": "40000", "platform_fee_share": "25000", "invested": "975000", "refund": "0",
    "micro_shares": "7800000000"})
# TC-J-45 TC-J-09 as a request
req45 = request([part("A", 1, "10400000", fee=RATE4), part("B", 2, "10000000", mode="deducted", fee=RATE4)],
                pf={"rate_bps": "250", "minimum": "400000", "payer": "investors"})
r = ho(req45)
res = r["result"]
eq("J-45 rows", [(p_["target"], p_["own_fee"], p_["platform_fee_share"], p_["invested"], p_["refund"])
                 for p_ in res["participants"]],
   [("10000000", "400000", "250000", "9750000", "0"), ("9600000", "400000", "240000", "9360000", "0")])
eq("J-45 header", (res["handoff_id"], res["engine"], res["projection_hash"], res["can_close"]),
   (req45["handoff_id"], req45["engine"], req45["projection_hash"], True))
check("J-45 identity", all(int(p_["allocation_amount"]) == int(q["target"]) + int(q["own_fee"]) + int(q["refund"])
                           for p_, q in zip(req45["projection"]["participants"], res["participants"])))
# TC-J-42 engine
q = request([part("A", 1, "100000")])
q["engine"] = "goten-rules/0.8"
r = ho(q)
check("J-42 engine", r["ok"] is False and "This request needs engine goten-rules/0.8; this copy of Goten runs "
      "goten-rules/0.9" in r["errors"], repr(r))
# TC-J-43 hash
q = request([part("A", 1, "100000")])
q["projection"]["participants"][0]["allocation_amount"] = "90000"
r = ho(q)
check("J-43 changed", r["ok"] is False and "The file was changed after it was exported" in r["errors"], repr(r))
q = request([part("A", 1, "100000")])
q["bookkeeping"]["participants"][0]["name"] = "New Name"
eq("J-43 bookkeeping name", ho(q)["ok"], True)


# TC-J-44 every variant refused
def refused(name, req=None, text=None):
    r = ho(req) if text is None else run({"kind": "handoff", "requestText": text, "dealCurrency": "GBP"})
    check("J-44 " + name, r.get("ok") is False and r.get("errors"), repr(r))


q = request([part("A", 1, "100000"), part("B", 2, None, decision="refund")])
q["projection"]["participants"][1]["terms"] = {"fee_mode": "on_top", "fee": None, "carry_bps": "0"}
q["projection_hash"] = projection_hash(q["projection"])
refused("refund with terms", q)
q = request([part("A", 1, "100000")])
q["bookkeeping"]["participants"] = []
refused("allocate without name", q)
refused("equity without price", request([part("A", 1, "100000")], price=None))
refused("convertible with price", request([part("A", 1, "100000")], instrument="convertible"))
refused("duplicate order", request([part("A", 1, "100000"), part("B", 1, "100000")]))
refused("order out of sequence", request([part("B", 2, "100000"), part("A", 1, "100000")]))
refused("unknown field vat", request([part("A", 1, "100000")], vat="2000"))
good = request([part("A", 1, "100000")])
import json as _json  # noqa: E402
txt = _json.dumps(good)
refused("duplicate key", text=txt.replace('"deal_id": "deal_1"', '"deal_id": "deal_1", "deal_id": "deal_2"'))
refused("lone surrogate", text=txt.replace('"Name A"', '"Name \\ud800"'))
q = request([part("A", 1, "100000")])
del q["projection"]["minimum"]
q["projection_hash"] = projection_hash(q["projection"])
refused("minimum missing", q)
refused("null cap", request([part("A", 1, "100000")], cap=None))
refused("EUR vs GBP", request([part("A", 1, "100000")], currency="EUR"))
# TC-J-52
q = request([part("A", 1, "0"), part("B", 2, "100000")], names={"B": "x" * 256})
r = ho(q)
eq("J-52 zero amount / 256 name", (r["ok"], r["result"]["participants"][0]),
   (True, {"id": "A", "allocated": False, "exclusion": "no-funds", "refund": "0"}))
q = request([part("A", 1, "100000")], names={"A": "\U0001F600" * 128})
eq("J-52 256 UTF-16 units with emoji", ho(q)["ok"], True)
refused("J-52 257-unit name", request([part("A", 1, "100000")], names={"A": "x" * 257}))
q = request([part("A", 1, "100000")])
q["projection"]["participants"][0]["decision"] = "Refund"
del q["projection"]["participants"][0]["terms"]
q["projection_hash"] = projection_hash(q["projection"])
refused("J-52 decision Refund", q)
# TC-J-56 currency messages
r = ho(request([part("A", 1, "100000")], currency="EUR"))
check("J-56 currency", "This request is in EUR; this deal is in GBP. Change the deal currency to EUR in Deal settings, "
      "then import again." in r["errors"], repr(r))
r = ho(request([part("A", 1, "100000")], currency="EUR"), feePayerChangeActive=True)
check("J-56 currency locked", "This request is in EUR; this deal is in GBP. Reverse the active fee payer change first, "
      "then change the deal currency to EUR and import again." in r["errors"], repr(r))
# TC-J-59 blocked result shape
q = request([part("A", 1, "50000", fee=None)], pf={"rate_bps": "0", "minimum": "60000", "payer": "investors"})
r = ho(q)
eq("J-59 blocked", r["result"], {"format": "goten.allocation-result/1", "handoff_id": "ho_test1",
                                 "engine": "goten-rules/0.9", "projection_hash": q["projection_hash"],
                                 "can_close": False, "blockers": [{"code": "platform-fee-exceeds", "ids": ["A"]}]})

# TC-J-01 compatibility: 1,000 random old-style allocations give the same old fields with the v0.9 path forced on
rng = random.Random(20261125)
bad01 = []
for k in range(1000):
    basis = rng.choice(["deducted", "onTop"])
    fs = [{"id": "p%d" % j, "kind": "percent", "value": rng.randint(0, 1500), "payer": rng.choice(["investors", "company", "lead"])}
          for j in range(rng.randint(0, 4))]
    if rng.random() < 0.4:
        fs.append({"id": "fx", "kind": "perInvestor", "value": rng.randint(1, 5000), "payer": "investors"})
    invs = [{"id": "i%d" % j, "received": rng.randint(0, 3000000), "scheme": "none"} for j in range(rng.randint(1, 6))]
    base = {"kind": "allocation", "feeBasis": basis, "minimum": rng.choice([0, 100000, 500000]),
            "cap": rng.choice([None, 2000000, 5000000]), "priceMicros": rng.randint(1, 5000000), "fees": fs, "investors": invs}
    old = run(base)
    new = run(dict(base, instrument="equity"))
    if old.get("ok") is False:
        if new != old:
            bad01.append(k)
        continue
    if {k_: (v if k_ != "investors" else {i: {f: x[f] for f in old["investors"][i]} for i, x in v.items()})
            for k_, v in new.items() if k_ in old} != old:
        bad01.append(k)
check("J-01 random 1,000: v0.9 path equals v0.8 fields", not bad01, repr(bad01[:5]))

print("v0.9 decision J: %d passed, %d failed" % (PASSED - OLD_PASSED, len(FAILED) - OLD_FAILED))
print("existing (v0.8 and earlier): %d passed, %d failed" % (OLD_PASSED, OLD_FAILED))

print("selfcheck: %d passed, %d failed" % (PASSED, len(FAILED)))
sys.exit(1 if FAILED else 0)
