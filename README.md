# Nettkø NO1 + NO5 — REAL DATA ONLY

Denne versjonen inneholder ingen demodata.

## Hva som er reelt
- Statnett-kildestatus og metodikk
- Statnett-nettiltak i NO1/NO5
- Kildebelagte regionale fakta
- Alle kø-/reservasjonsrader som importeres fra Statnetts offentlige liste

## Hvorfor køtabellen starter tom
Statnett publiserer de faktiske kø- og reservasjonsradene i offentlige Power BI-visninger.
Statnetts egen nettside beskriver manuell kopiering til Excel. Vi har ikke identifisert en
dokumentert stabil offentlig eksport-API for disse radene.

I stedet for å bruke demodata viser dashboardet derfor «Ikke hentet» frem til reelle rader
er importert.

## Import
Eksporter/kopier Statnett-tabellen til CSV og importer den direkte i dashboardet, eller kjør:

    python import_statnett.py fil.csv

Parseren forsøker å gjenkjenne norske kolonnenavn og filtrerer til NO1/NO5.

## Daglig drift
For full automatikk trengs én av:
1. dokumentert eksport-API fra Statnett,
2. avtalt datafeed,
3. en browser/RPA-jobb som eksporterer den offentlige Power BI-tabellen.

Etter dette kan `import_statnett.py` kjøres daglig og snapshots lagres.
