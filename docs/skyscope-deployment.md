# SkyScope-käyttöönotto

SkyScope koostuu kolmesta erillisestä osasta:

1. `skyscope/` on nykyiseen GitHub Pages -sivustoon kuuluva staattinen näkymä.
2. `backend/skyscope-worker/` on Cloudflare Worker ja D1-migraatio.
3. `tools/skyscope-pi/` lukee Raspberry Pi:n paikalliset lähteet ja lähettää aggregoidun snapshotin Workerille.

Selain ei ota yhteyttä Raspberry Pi:hin. Workerille tai D1:een ei lähetetä vastaanottimen tai antennin koordinaatteja. Koordinaatteja käytetään vain Pi:llä lentokoneiden etäisyyksien laskemiseen.

Alla olevat vaiheet tehdään täsmälleen tässä järjestyksessä. Repositorion juurella ei ole pakettienhallintaa tai build-vaihetta, joten ohje käyttää kiinnitettyä Wrangler-versiota kertaluonteisesti eikä muuta sivuston riippuvuuksia.

## 0. Esitarkastus

Tarvitset Cloudflare-tilin, Node.js:n ja npm:n sillä tietokoneella, jolta Worker otetaan käyttöön. Siirry Worker-hakemistoon ja kirjaudu Cloudflareen:

```sh
cd backend/skyscope-worker
npx --yes wrangler@4.127.1 login
```

Älä jatka, ellei kirjautuminen pääty oikealle Cloudflare-tilille.

## 1. Luo Cloudflare D1 -tietokanta

```sh
npx --yes wrangler@4.127.1 d1 create skyscope
```

Komento tulostaa tietokannan UUID-tunnuksen. Korvaa `wrangler.toml`-tiedoston arvo
`REPLACE_WITH_D1_DATABASE_ID` tällä UUID:lla. Älä muuta binding-nimeä `DB` tai tietokannan nimeä `skyscope`.

Tietokannan UUID ei ole salasana, mutta sitä ei pidä keksiä tai kopioida toisesta ympäristöstä.

## 2. Aja D1-migraatio

Tarkista ensin odottava migraatio ja aja se sitten etätietokantaan:

```sh
npx --yes wrangler@4.127.1 d1 migrations list skyscope --remote
npx --yes wrangler@4.127.1 d1 migrations apply skyscope --remote
```

Varmista, että `0001_initial.sql` näkyy onnistuneesti ajettuna. Migraatio luo vain vastaanottimen uusimman snapshotin, päivätilastojen ja aggregoitujen ohitusten taulut. Se ei luo havaintorivien historiataulua.

## 3. Lisää Worker-secret

Luo pitkä satunnainen token paikallisesti:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Tallenna token heti turvalliseen salaisuuksien hallintaan. Lisää se Workerille interaktiivisesti:

```sh
npx --yes wrangler@4.127.1 secret put INGEST_TOKEN
```

Liitä token kehotteeseen. Älä kirjoita tokenia `wrangler.toml`-tiedostoon, komentohistoriaan, Git-repositorioon tai selaimen `config.js`-tiedostoon. Cloudflaren `secret put` voi luoda Workerista version; varsinainen vahvistettu deploy tehdään seuraavassa vaiheessa.

## 4. Deployaa Worker

Tarkista ensin `wrangler.toml`:

- `PRODUCTION_ORIGIN` on täsmälleen `https://noeljeromaa.com`.
- `LOCAL_DEV_ORIGIN` on vain käyttämäsi paikallinen origin, oletuksena `http://localhost:8000`.
- D1:n `database_id` ei enää sisällä paikkamerkkiä.
- `INGEST_TOKEN` ei näy tiedostossa.

Deployaa sitten:

```sh
npx --yes wrangler@4.127.1 deploy
```

Ota talteen komennon tulostama HTTPS-osoite, esimerkiksi
`https://skyscope-api.YOUR_WORKERS_SUBDOMAIN.workers.dev`. Älä luo Cloudflareen reittiä, joka muuttaa `noeljeromaa.com`-domainin DNS- tai Pages-asetuksia.

## 5. Määritä GitHub Pages -näkymän API-osoite

Muokkaa tiedostoa `skyscope/config.js` ja aseta Worker-origin ilman lopun kauttaviivaa:

```js
window.SKYSCOPE_CONFIG = Object.freeze({
  apiBaseUrl: "https://skyscope-api.YOUR_WORKERS_SUBDOMAIN.workers.dev"
});
```

Tämä osoite ei ole salaisuus. Älä lisää tokenia samaan tiedostoon. Kun muutos on myöhemmin erikseen hyväksytysti viety GitHub Pagesiin, SkyScope löytyy osoitteesta:

```text
https://noeljeromaa.com/skyscope/
```

Nykyiseen navigaatioon ei tarvitse lisätä linkkiä, eikä `CNAME`-tiedostoa muuteta.

## 6. Asenna Pi-ohjelma

Kopioi repository Raspberry Pi:lle tai siirrä seuraavat tiedostot turvallisesti. Aja Pi:llä repositoryn juuresta:

```sh
sudo install -d -m 0755 /opt/skyscope /etc/skyscope
sudo install -m 0755 tools/skyscope-pi/exporter.py /opt/skyscope/exporter.py
sudo install -m 0644 tools/skyscope-pi/systemd/skyscope-exporter.service /etc/systemd/system/skyscope-exporter.service
sudo install -m 0644 tools/skyscope-pi/systemd/skyscope-exporter.timer /etc/systemd/system/skyscope-exporter.timer
sudo install -m 0600 tools/skyscope-pi/systemd/exporter.env.example /etc/skyscope/exporter.env
```

Service käyttää käyttäjää ja ryhmää `noel`, koska annetut lähdetiedot ovat `/run/readsb/aircraft.json` ja `/home/noel/skyscope/skyscope.db`. Jos Pi:n oikea käyttäjä on muu, muuta vain service-tiedoston `User`- ja `Group`-arvot ennen asennusta.

## 7. Täytä EnvironmentFile

Muokkaa Pi:llä root-oikeuksin:

```sh
sudoedit /etc/skyscope/exporter.env
```

Korvaa vähintään nämä arvot:

- `SKYSCOPE_API_URL`: Worker-osoite ja polku `/api/ingest`.
- `SKYSCOPE_INGEST_TOKEN`: täsmälleen sama token, joka lisättiin Worker-secretiin.
- `SKYSCOPE_RECEIVER_LATITUDE`: vastaanottimen tarkka leveysaste vain Pi:llä.
- `SKYSCOPE_RECEIVER_LONGITUDE`: vastaanottimen tarkka pituusaste vain Pi:llä.

Tarkista lisäksi lähdepolut ja aikavyöhyke. Säilytä tiedoston oikeudet:

```sh
sudo chown root:root /etc/skyscope/exporter.env
sudo chmod 0600 /etc/skyscope/exporter.env
```

EnvironmentFileä ei kopioida repositoryyn. Exporter muodostaa lentokoneiden etäisyydet Pi:llä ja lähettää vain lasketun etäisyyden sekä lentokoneen oman julkisen ADS-B-sijainnin.

## 8. Ota systemd-timer käyttöön

```sh
sudo systemctl daemon-reload
sudo systemctl start skyscope-exporter.service
sudo systemctl status skyscope-exporter.service --no-pager
sudo systemctl enable --now skyscope-exporter.timer
systemctl list-timers skyscope-exporter.timer --no-pager
```

Service suorittaa yhden lähetyksen. Timer käynnistää sen 30 sekunnin välein, joten päällekkäisiä jatkuvia Python-prosesseja ei synny.

## 9. Testipyynnöt

Korvaa alla `WORKER_ORIGIN` käyttöönotetulla Worker-originilla.

Julkiset read-only-reitit:

```sh
curl --fail --show-error 'WORKER_ORIGIN/api/status'
curl --fail --show-error 'WORKER_ORIGIN/api/live'
curl --fail --show-error 'WORKER_ORIGIN/api/passes?limit=10'
curl --fail --show-error 'WORKER_ORIGIN/api/stats'
```

Väärän ingest-tokenin pitää palauttaa HTTP 401:

```sh
curl --include --request POST 'WORKER_ORIGIN/api/ingest' \
  --header 'Authorization: Bearer definitely-wrong' \
  --header 'Content-Type: application/json' \
  --data '{}'
```

CORS-tarkistus tuotanto-originille:

```sh
curl --include 'WORKER_ORIGIN/api/status' \
  --header 'Origin: https://noeljeromaa.com'
```

Vastauksessa pitää näkyä `Access-Control-Allow-Origin: https://noeljeromaa.com`. Muun originin pitää saada HTTP 403. Lopuksi tarkista Pi:n lähetys ja loki:

```sh
sudo systemctl start skyscope-exporter.service
journalctl -u skyscope-exporter.service -n 50 --no-pager
```

Onnistunut loki kertoo lähetettyjen koneiden ja ohitusten määrät, mutta ei tulosta tokenia eikä vastaanottimen koordinaatteja.

## 10. Vianmääritys

### SkyScope ei ole vielä yhdistetty

`skyscope/config.js` sisältää tyhjän `apiBaseUrl`-arvon. Lisää vaiheessa 5 saatu Worker-origin ja varmista, ettei osoitteessa ole `/api`-polkua tai lopun kauttaviivaa.

### Selain näyttää CORS-virheen

Tarkista, että sivu avataan täsmälleen originista `https://noeljeromaa.com`. Paikallisessa testissä käynnistä sivusto repositoryn juuresta komennolla `python3 -m http.server 8000` ja käytä osoitetta `http://localhost:8000/skyscope/`. Jos paikallinen portti tai host muuttuu, päivitä vain `LOCAL_DEV_ORIGIN` ja deployaa Worker uudelleen.

### Ingest palauttaa 401

Pi:n `SKYSCOPE_INGEST_TOKEN` ei vastaa Worker-secretin arvoa. Älä tulosta tokenia lokiin. Aseta sama arvo uudelleen vaiheen 3 menetelmällä ja Pi:n root-only EnvironmentFileen.

### Ingest palauttaa 400 tai 413

HTTP 400 tarkoittaa virheellistä JSON-rakennetta tai kenttäarvoa. HTTP 413 tarkoittaa yli 512 KiB:n snapshotia. Tarkista exporterin loki ja pienennä tarvittaessa `SKYSCOPE_PASS_LIMIT`-arvoa. Älä kasvata julkisen API:n rajoja ilman erillistä turvallisuusarviota.

### Vastaanotin näkyy stale- tai offline-tilassa

`stale` tarkoittaa, että viimeisin Workerille saapunut snapshot on yli 90 sekuntia vanha tai viimeisin selainhaku epäonnistui. `offline` tarkoittaa yli viiden minuutin katkoa. Tarkista järjestyksessä timer, service-loki, internet-yhteys, readsb-tiedosto ja SQLite-tiedosto:

```sh
systemctl status skyscope-exporter.timer --no-pager
systemctl status skyscope-exporter.service --no-pager
journalctl -u skyscope-exporter.service -n 100 --no-pager
sudo -u noel test -r /run/readsb/aircraft.json
sudo -u noel test -r /home/noel/skyscope/skyscope.db
```

### Kone näkyy ilman sijaintia

Tämä on sallittu tila. readsb voi kuulla ICAO-tunnuksen, vaikka koordinaatteja ei ole vielä saatu. Kone näytetään erillisessä listassa eikä sille lasketa etäisyyttä.

## 11. Tokenin turvallinen vaihtaminen

1. Luo uusi token samalla `secrets.token_urlsafe(48)`-komennolla.
2. Pysäytä Pi:n timer lyhyesti: `sudo systemctl stop skyscope-exporter.timer`.
3. Päivitä uusi token Pi:n `/etc/skyscope/exporter.env`-tiedostoon ja säilytä oikeudet `0600`.
4. Aja Worker-hakemistossa `npx --yes wrangler@4.127.1 secret put INGEST_TOKEN` ja syötä uusi token interaktiivisesti.
5. Käynnistä ja testaa yksi lähetys: `sudo systemctl start skyscope-exporter.service`.
6. Tarkista service-loki ja `/api/status`.
7. Käynnistä timer uudelleen: `sudo systemctl enable --now skyscope-exporter.timer`.
8. Poista vanha token salaisuuksien hallinnasta. Älä säilytä sitä repositoryssä tai komentohistoriassa.

## Paikalliset testit ennen julkaisua

Aja repositoryn juuresta:

```sh
python3 -m unittest discover -s tools/skyscope-pi/tests -p 'test_*.py'
node --test backend/skyscope-worker/tests/*.test.mjs tests/*.test.mjs
```

Staattinen sivusto ei tarvitse build-komentoa. Paikallinen HTTP-tarkistus voidaan tehdä repositoryn juuresta komennolla `python3 -m http.server 8000` ja osoitteesta `http://localhost:8000/skyscope/`.
