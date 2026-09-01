# SkyScope: kevyet reittitiedot

## Rajaus ja lähde

Pi:n readsb, collector, exporter, ajastimet, tietokanta ja 30 sekunnin lähetys
säilyvät ennallaan. SatDump pysyy pois käytöstä. GitHub Pages, nykyinen Worker/D1,
CSS, navigaatio, CNAME ja DNS säilyvät. Uutta palvelua, API-avainta, maksullista
tilausta tai riippuvuutta ei tarvita.

Nykyisen Workerin Cron Trigger hakee enintään yhden puuttuvan reitin minuutissa.
Ingest ja julkiset GET-pyynnöt eivät tee ulkoisia reittihakuja. Reitti näkyy yleensä
noin 1–2 minuutin ja seuraavan selainpäivityksen kuluttua. Useampi uusi tunnus
käsitellään yksi kerrallaan.

- Aineisto: https://github.com/vradarserver/standing-data
- CC0: https://github.com/vradarserver/standing-data/blob/main/LICENSE
- JSON-peili ja sen ohje: https://github.com/adsblol/vrs-standing-data
- Rakenne: https://github.com/adsblol/vrs-standing-data/blob/main/data/generate-jsons.py
- Esimerkki: https://vrs-standing-data.adsb.lol/routes/FI/FIN6YP.json

Lähteen README ilmoittaa peilin päivittyvän tunnin välein. Tämä EI kerro
yksittäisen reitin ikää. `fetched_at` on oma hakuaika, ei lähteen muutosajankohta.
Reitti on **kutsutunnuksen tietokantareitti**, ei ADS-B:stä saatu reitti,
vahvistettu lentosuunnitelma tai toteutuneen lennon seuranta. Kaikki välilaskut
säilytetään; vastaanottimen sijainnista ei päätellä lennettävää osuutta.
Puuttuvalle tiedolle näytetään `Reitti ei tiedossa`. Sotilaskoneeksi ei luokitella
reitin tai arvauksen perusteella.

Haetaan vain vastaanottimen jo tallentamia tunnuksia: tuore live-tilanne sekä
enintään 100 uusinta ohitusta viimeisen 48 tunnin ajalta. Vanhempaa historiaa
ei täytetä nykyisillä reittiarvauksilla. Nykyiseen 48 tunnin historiaan täydennetyn
reitin yhteydessäkin näytetään oikea hakuaika ja tiedon epävarmuus.

## Omat turvarajat

Nämä ovat omia rajoja, eivät lähteen lupaamaa kapasiteettia.

| Kohde | Raja |
| --- | --- |
| Ulkoiset reittipyynnöt | 200 / UTC-vuorokausi, yksi / ajokerta |
| Vastauksen koko | 16 KiB, myös ilman Content-Length-otsaketta |
| Aikakatkaisu | 4 s, myös vastauksen lukeminen |
| Löydetty / puuttuva reitti | Välimuisti 24 h / 6 h |
| Verkkovirhe tai virheellinen data | Uusinta 15 min kuluttua, yleinen 5 min tauko |
| HTTP 429 | Yleinen 6 h tauko |
| Välimuisti | 2 000 merkintää |
| Tallennettu reitti | 4 096 UTF-8-tavua |
| Ohitusten täydentäminen | Enintään 20 riviä erässä |

Välimuistin reitti-JSONien sisältö on enintään noin 7,8 MiB, lisäksi SQLite-
rakenne ja indeksit. Kahden lentoaseman esimerkkireitti jää alle 1 KiB:n.
Vanhentuneita välimuistimerkintöjä poistetaan seitsemän päivän lisäajan jälkeen,
enintään 100 kerrallaan. Täysi välimuisti estää uudet haut; historiaa ei poisteta.

`pass_routes` säilyttää ohituskohtaiset reittikopiot. Saman kutsutunnuksen
myöhempi reittimuutos ei muuta vanhaa ohitusta. Jos itse ohituksen kutsutunnus
korjataan, eri tunnuksen reitti piilotetaan ja voidaan korvata uudella.
Aiempi `passes`/`daily_stats`-UPSERT-optimointi säilyy.

Reittikopioiden määrä kasvaa ohitushistorian mukana. Koko D1:n tila on edelleen
tarkistettava: ilmaistason yhden tietokannan raja on 500 MB. Pi:n havaintotietokanta
kasvaa ennallaan; tämä muutos ei poista tai rajoita sitä.

## Käyttöönotto nykyiseen palveluun

Oletus on `ROUTE_ENRICHMENT_ENABLED = "false"`. Pelkkä tiedostojen kopiointi ei
kytke reittejä tuotantoon. Muutos valmisteltiin main-commitin
`6ab542f5dc2d9ebd6d9f63ba8525881c7016790f` päälle; säilytä uudemmat käyttäjän muutokset.

1. Tarkista repository, työpuu ja nykyinen Worker/D1. Aja juuresta:

   ```sh
   node --test backend/skyscope-worker/tests/*.test.mjs tests/*.test.mjs
   python3 -m unittest discover -s tools/skyscope-pi/tests -p 'test_*.py'
   ```

2. Testaa todellinen lähde Macilta, **ei Pi:ltä**. Tämä tekee yhden julkisen GET-haun:

   ```sh
   cd backend/skyscope-worker
   node --input-type=module -e 'import {fetchSourceRoute} from "./src/routes.js"; const r = await fetchSourceRoute("FIN6YP", Date.now()); console.log(JSON.stringify(r, null, 2)); if (r.state !== "found") process.exitCode = 1;'
   ```

   Älä ota käyttöön, jos tulos ei ole `found`. Älä raportoi testifixturea live-hakuna.

3. Varmista Cloudflare-kirjautuminen ja nykyisen D1:n varmistus. Tarkista:

   ```sh
   npx --yes wrangler@4.127.1 d1 migrations list skyscope --remote
   ```

   Odotettavissa on vain `0004_route_enrichment.sql`. Selvitä mahdolliset muut
   odottavat migraatiot ennen jatkamista. Älä luo tai tyhjennä D1:tä.

4. Vasta hyväksytyssä julkaisuvaiheessa aja:

   ```sh
   npx --yes wrangler@4.127.1 d1 migrations apply skyscope --remote
   ```

5. Muuta Wranglerissa vain reittiasetus arvoon `"true"`. Julkaise nykyinen Worker
   projektin aiemmalla menettelyllä. Älä muuta ingest-secretia, Pi:n asetuksia,
   domainia tai palvelutasoa. Tarkista status-, live- ja päiväkohtainen passes-API.
6. Julkaise frontend tavallisella GitHub Pages -menettelyllä vasta Worker-tarkistuksen
   jälkeen. Uusi frontend toimii myös reittien ollessa vielä puuttuvia.
7. Cron Triggerin aktivoituminen voi viivästyä. Tarkista muutaman ajon jälkeen
   reitti, hakuaika, `route_budget.requests`, Worker CPU ja D1 Metrics. Node-testit
   eivät mittaa Cloudflaren 10 ms CPU-budjettia. Pidä ominaisuus pois käytöstä,
   jos oikea Worker ylittää rajansa.
8. Varmista mobiilissa ja tietokoneella, että reitti näkyy livekortissa ja päivän
   ohituksessa. Tarkista saman muuttumattoman ohituksen tietokantarivi kahdesti:
   `route_json` ja aiemmat `updated_at`-arvot eivät saa muuttua turhaan.

## Palautus ja testauksen rajat

Palauta `ROUTE_ENRICHMENT_ENABLED` arvoon `"false"` ja julkaise Worker tai palauta
edellinen Worker-versio. Taulut voi jättää paikoilleen; älä aja DROP-komentoja.
Pois kytketty Cron ei tee reittihakuja tai tietokantakyselyitä.

Testit käyttävät oikeaa SQLite-moottoria ja julkaisijan generaattorin rakennetta
vastaavia testivastauksia. Ne kattavat 1 440 muuttumatonta ajokertaa, rinnakkaiset
ajot, aikakatkaisun, kiintiön, kokorajat, puuttuvan migraation ja historiakopiot.
Frontendin tuotantokoodia suoritetaan lisäksi pienellä DOM-testikaksoisella:
10 ja 101 ohitusta näkyvät kaikki, reitin yksityiskohdat pysyvät auki päivityksissä
ja livekortissa näkyvät samat reitit sekä metrit ja km/h. Nämä eivät korvaa
oikean selaimen ulkoasutarkistusta.
Tuotannon HTTP-lähde, Cloudflare CPU, D1 Metrics ja mobiilinäkymä todennetaan
erikseen käyttöönotossa.

Viralliset käyttörajat:
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
