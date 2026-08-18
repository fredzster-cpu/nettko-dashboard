
from pathlib import Path
from datetime import datetime
import csv, json, hashlib, sys

ROOT=Path(__file__).parent
DATA=ROOT/"data"
SNAPS=DATA/"snapshots"; SNAPS.mkdir(exist_ok=True)

ALIASES={
    "aktør":"actor","aktor":"actor","kunde":"actor","kundenavn":"actor",
    "prosjekt":"project","prosjektnavn":"project",
    "effekt":"mw","effekt (mw)":"mw","mw":"mw","volum":"mw","volum (mw)":"mw",
    "prisområde":"area","prisomrade":"area","budområde":"area","budomrade":"area",
    "lokasjon":"location","sted":"location","kommune":"location",
    "næring":"industry","naring":"industry","næringskategori":"industry","naringskategori":"industry",
    "status":"status","planlagt ferdigstillelse":"planned_completion",
    "ferdigstillelse":"planned_completion","modenhetsdato":"maturity_date",
    "vilkår":"conditions","vilkar":"conditions"
}
def normalize_header(x):
    x=x.strip().lower()
    return ALIASES.get(x,x.replace(" ","_"))
def parse_num(x):
    x=(x or "").strip().replace("\xa0","").replace(" ","").replace(",",".")
    try:return float(x)
    except:return None
def row_id(r):
    base="|".join(str(r.get(k,"")).strip().lower() for k in ("actor","project","area","location","mw","status"))
    return hashlib.sha1(base.encode()).hexdigest()[:16]
def read_csv(path):
    txt=Path(path).read_text(encoding="utf-8-sig")
    delim=";" if txt.splitlines()[0].count(";")>txt.splitlines()[0].count(",") else ","
    rows=list(csv.reader(txt.splitlines(),delimiter=delim))
    heads=[normalize_header(h) for h in rows[0]]
    out=[]
    for vals in rows[1:]:
        if not any(v.strip() for v in vals): continue
        r={heads[i]:(vals[i].strip() if i<len(vals) else "") for i in range(len(heads))}
        r["mw"]=parse_num(r.get("mw"))
        r["area"]=(r.get("area") or "").upper().strip()
        if r["area"] not in ("NO1","NO5"): continue
        r["id"]=row_id(r); r["provenance"]="Statnett public connection statistics"
        out.append(r)
    return out
def main(path):
    rows=read_csv(path)
    stamp=datetime.now().astimezone().isoformat()
    day=stamp[:10]
    snap={"updated_at":stamp,"data_mode":"REAL_ONLY","queue_projects":rows}
    (SNAPS/f"{day}.json").write_text(json.dumps(snap,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Imported {len(rows)} real NO1/NO5 rows -> {SNAPS/day}.json")
if __name__=="__main__":
    if len(sys.argv)<2: raise SystemExit("Usage: python import_statnett.py <export.csv>")
    main(sys.argv[1])
