import random, json, sys, os, datetime as dt, io
K=float(os.environ.get('SCALE','1'))
N=lambda x:max(3,int(x*K))
out = sys.argv[1]
R = random.Random(20261023)
CUST = ["ACME TRADING SDN BHD","BRIGHT ELECTRONICS PTE LTD","CITY HARDWARE ENTERPRISE","DELTA LOGISTICS BHD","EVERGREEN SUPPLIES","FUJI PRECISION LTD","GOLDEN BRIDGE TRADING","HARBOUR TECH SDN BHD","IRONWORKS ASIA PTE","JADE MANUFACTURING",
        "KITE SYSTEMS BHD","LOTUS INDUSTRIES","MERIDIAN PARTS CO","NOVA CIRCUITS PTE LTD","ORIENT MACHINERY","PACIFIC COMPONENTS","QUANTUM DEVICES BHD","RIVERSIDE ENGINEERING","SUMMIT CONTROLS","TITAN FASTENERS"]
SHIP = ["SEA","AIR","TRUCK","COURIER","N/A",""]
truth = {}
def d(base, n): return base + dt.timedelta(days=n)
D0 = dt.date(2026,1,1)
def money(x, quoted=True):
    s = f"{abs(x):,.2f}"
    s = f"({s})" if x < 0 else s
    return f'"{s}"' if quoted and "," in s else s

# 1. ERP outstanding report: title block, 2-row header, spacer cols, carry-forward customer, subtotals, page breaks, grand total
def f1():
    L = io.StringIO(); n = 0; grand = 0.0; per = {}
    def hdr(page):
        L.write('"ACME HOLDINGS SDN BHD"\n"SALES ORDER OUTSTANDING REPORT"\n"From 01-01-2026 To 30-06-2026"\n')
        L.write(f'"Printed by: ADMIN  Page {page} of 80",,,,,,,,,,\n\n')
        L.write(",,Order,,Delivery,,,Quantity,,Amount,\n")
        L.write("S/N,Customer,Date,SO No.,Date,CUST P/O NO.,Ship Mode,Ordered,Balance,Price,Balance Amount,\n")
    page = 1; hdr(page); line = 0; sn = 0
    for c in CUST:
        first = True; sub = 0.0
        for _ in range(R.randint(N(120), N(180))):
            sn += 1
            od = d(D0, R.randint(0, 150)); dd = d(od, R.randint(5, 40))
            q = R.randint(10, 2000); bal = R.randint(0, q); pr = round(R.uniform(0.5, 90), 2)
            amt = round(bal * pr, 2); sub += amt; grand += amt; per[c] = per.get(c, 0) + amt
            po = "" if R.random() < 0.37 else f"PO{R.randint(10000,99999)}"
            sh = R.choice(SHIP)
            L.write(f'{sn},{(c if first else "")},{od:%d-%m-%Y},SO{100000+sn},{dd:%d-%m-%Y},{po},{sh},"{q:,}","{bal:,}",{money(pr)},{money(amt)},\n')
            first = False; line += 1; n += 1
            if line % 45 == 0:
                page += 1; L.write("\n"); hdr(page); first = True
        L.write(f',,,,,,,Sub Total:,,,,{money(round(sub,2))},\n,,,,,,,,,,,\n')
    L.write(f',,,,,,,GRAND TOTAL:,,,,{money(round(grand,2))},\n*** End of Report ***\n')
    truth["f1"] = {"rows": n, "grand_total": round(grand, 2), "per_customer": {k: round(v, 2) for k, v in per.items()}}
    return L.getvalue()

# 2. Indented hierarchy with monthly columns + Total column and subtotals
def f2():
    L = io.StringIO(); L.write("Region / Country / Customer,Jan-26,Feb-26,Mar-26,Apr-26,May-26,Jun-26,Total\n"); leaf = 0; tot = 0.0
    for reg in ["ASEAN","NORTH ASIA","EUROPE","AMERICAS"]:
        rv = [0.0]*6; rows = []
        for cty in R.sample(["Singapore","Malaysia","Thailand","Japan","Korea","Germany","France","USA","Canada","Brazil"], 5):
            cv = [0.0]*6; crow = []
            for i in range(R.randint(N(70), N(110))):
                vals = [None if R.random() < 0.08 else round(R.uniform(100, 9000), 0) for _ in range(6)]
                for k, v in enumerate(vals):
                    if v is not None: cv[k] += v
                crow.append(f"        Customer {reg[:2]}{cty[:2]}{i:03d}," + ",".join("n.a." if v is None else f"{v:.0f}" for v in vals) + f",{sum(v for v in vals if v is not None):.0f}"); leaf += 1
            for k in range(6): rv[k] += cv[k]
            rows.append(f"    {cty}," + ",".join(f"{v:.0f}" for v in cv) + f",{sum(cv):.0f}"); rows.extend(crow)
        L.write(f"{reg}," + ",".join(f"{v:.0f}" for v in rv) + f",{sum(rv):.0f}\n"); L.write("\n".join(rows) + "\n"); tot += sum(rv)
    truth["f2"] = {"leaf_rows": leaf, "grand_total": tot}
    return L.getvalue()

# 3. Three sections stacked with different headers
def f3():
    L = io.StringIO(); a = r = p = 0.0
    L.write("SECTION A: SALES INVOICES\nInvoice No,Date,Customer,Amount,Tax\n")
    for i in range(N(1600)):
        x = round(R.uniform(50, 5000), 2); a += x; L.write(f"INV{i+1:05d},{d(D0,R.randint(0,180)):%Y-%m-%d},{R.choice(CUST)},{x},{round(x*0.08,2)}\n")
    L.write("\n\nSECTION B: CREDIT NOTES\nCN No,Original Invoice,Reason,Credit Amount\n")
    for i in range(N(700)):
        x = round(R.uniform(10, 900), 2); r += x; L.write(f"CN{i+1:04d},INV{R.randint(1,N(1600)):05d},{R.choice(['Damaged','Wrong item','Late','Price adj'])},{x}\n")
    L.write("\n\nSECTION C: PAYMENTS RECEIVED\nReceipt,Paid On,Method,Customer,Paid\n")
    for i in range(N(900)):
        x = round(R.uniform(100, 8000), 2); p += x; L.write(f"RC{i+1:05d},{d(D0,R.randint(0,180)):%d/%m/%Y},{R.choice(['TT','Cheque','GIRO','Cash'])},{R.choice(CUST)},{x}\n")
    truth["f3"] = {"sales": round(a,2), "credit": round(r,2), "paid": round(p,2), "rows": [N(1600),N(700),N(900)]}
    return L.getvalue()

# 4. European: BOM, semicolon, comma decimals, dotted thousands, mixed dates, CJK, embedded newlines, trailing delimiter
def f4():
    L = io.StringIO(); L.write("﻿Auftrag;Datum;Kunde;Beschreibung;Menge;Preis;Betrag;\n"); tot = 0.0
    names = ["上海科技有限公司","株式会社東京精密","Müller & Söhne GmbH","Société Générale Pièces","서울전자","Ångström AB"]
    for i in range(N(4000)):
        q = R.randint(1, 500); pr = round(R.uniform(0.9, 450), 2); amt = round(q*pr, 2); tot += amt
        dt_ = d(D0, R.randint(0, 400)); fmt = R.choice(["%Y-%m-%d","%d.%m.%Y","%d-%b-%y"])
        desc = R.choice(["Standard part", 'Part "X-2"; reinforced', "Multi-line\nnote: handle with care", "Spare; kit"])
        desc = '"' + desc.replace('"', '""') + '"' if any(ch in desc for ch in ';"\n') else desc
        eu = lambda v: f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        L.write(f'A{i+1:05d};{dt_.strftime(fmt)};{R.choice(names)};{desc};{q};{eu(pr)};{eu(amt)};\n')
    truth["f4"] = {"rows": N(4000), "total": round(tot, 2)}
    return L.getvalue()

# 5. Metadata block, aging buckets, footnote marks, repeated headers with "Continued", totals, footnotes
def f5():
    L = io.StringIO(); meta = [("Report Name","AR Aging Analysis"),("Company","ACME HOLDINGS SDN BHD"),("As At","30-06-2026"),("Currency","MYR"),("Run By","ADMIN"),("Filter: Region","ALL"),("Filter: Salesperson","ALL"),("Aging Basis","Invoice Date")]
    for k, v in meta: L.write(f"{k},{v}\n")
    for i in range(30): L.write(f"Parameter {i+1},Value {i+1}\n")
    L.write("\n"); H = "Customer,Invoice,Current,1-30,31-60,61-90,90+,Balance\n"; L.write(H); tot = 0.0; rows = 0
    for i in range(N(3200)):
        b = [0 if R.random() < 0.55 else round(R.uniform(50, 6000), 0) for _ in range(5)]
        if sum(b) == 0: b[0] = round(R.uniform(50, 800), 0)
        cells = []
        for v in b:
            if v == 0: cells.append(R.choice(["-","n.a.",""]))
            else: cells.append(f"{v:.0f}*" if R.random() < 0.03 else f"{v:.0f}")
        bal = sum(b); tot += bal; rows += 1
        L.write(f"{R.choice(CUST)},IN{i+1:05d}," + ",".join(cells) + f",{bal:.0f}\n")
        if (i+1) % 100 == 0: L.write("\nContinued...\n" + H)
    L.write(f"TOTAL,,,,,,,{tot:.0f}\n\n* Estimated amount\n** Subject to credit review\nEnd of report\n")
    truth["f5"] = {"rows": rows, "total_balance": tot}
    return L.getvalue()

# 6. Grouped two-row header (FY spanning cols, blanks), carry-forward category labels, symbols
def f6():
    L = io.StringIO(); L.write("Category,Product,FY2025,,,,FY2026,,\n,,Q1,Q2,Q3,Q4,Q1,Q2,Q3\n".replace("FY2026,,\n,,Q1,Q2,Q3,Q4,Q1,Q2,Q3","FY2026,,\n,,Q1,Q2,Q3,Q4,Q1,Q2,Q3"))
    L = io.StringIO(); L.write("Category,Product,FY2025,,,,FY2026,,\n,,Q1,Q2,Q3,Q4,Q1,Q2,Q3\n"); tot = 0.0; rows = 0
    for cat in ["Fasteners","Bearings","Valves","Sensors","Cables","Motors","Pumps","Gaskets"]:
        first = True
        for i in range(R.randint(N(200), N(300))):
            vals = []
            for k in range(7):
                if R.random() < 0.1: vals.append("-"); continue
                v = round(R.uniform(100, 20000)); tot += v; vals.append(f'"${v:,}"' if R.random() < 0.7 else f"{v}")
            L.write(f'{cat if first else ""},{cat[:3].upper()}-{i+1:04d},' + ",".join(vals) + "\n"); first = False; rows += 1
    truth["f6"] = {"rows": rows, "total": tot}
    return L.getvalue()

# 7. Fixed-width text report saved as .csv, no delimiters
def f7():
    L = io.StringIO(); L.write("ACME HOLDINGS SDN BHD            STOCK LISTING            30-06-2026\n" + "-"*78 + "\n")
    L.write("ITEM CODE   DESCRIPTION               LOCATION    ON HAND      UNIT COST       VALUE\n" + "-"*78 + "\n"); tot = 0.0; rows = 0
    for i in range(N(3500)):
        q = R.randint(0, 5000); c = round(R.uniform(0.2, 300), 2); v = round(q*c, 2); tot += v; rows += 1
        L.write(f"{'IT'+str(i+1).zfill(5):<12}{R.choice(['HEX BOLT M8','WASHER 10MM','BEARING 6204','VALVE 1/2in','CABLE 2.5mm','SENSOR PNP']):<26}{R.choice(['WH-A1','WH-B2','WH-C3']):<12}{q:>7,}{c:>15,.2f}{v:>14,.2f}\n")
        if (i+1) % 55 == 0: L.write("\f\n" + "ITEM CODE   DESCRIPTION               LOCATION    ON HAND      UNIT COST       VALUE\n" + "-"*78 + "\n")
    L.write("-"*78 + f"\nTOTAL VALUE{' '*50}{tot:>14,.2f}\n")
    truth["f7"] = {"rows": rows, "total_value": round(tot, 2)}
    return L.getvalue()

files = {"w1_erp_outstanding.csv": f1(), "w2_hierarchy_monthly.csv": f2(), "w3_three_sections.csv": f3(), "w4_european_semicolon.csv": f4(), "w5_aging_meta_footnotes.csv": f5(), "w6_grouped_header_carryforward.csv": f6(), "w7_fixed_width_text.csv": f7()}
for name, txt in files.items():
    open(f"{out}/{name}", "w", encoding="utf-8", newline="").write(txt)
    print(name, len(txt.splitlines()), "lines", len(txt.encode()), "bytes")
json.dump(truth, open(f"{out}/truth.json", "w"), indent=1)
