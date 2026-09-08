# HoodCheck — yayin paketi

Bu klasor SADECE siteyi calistirir. Icinde bot kodu YOKTUR:
alim-satim yurutucusu, private key ucu, pozisyon dosyalari, islem gecmisi — hicbiri burada degil.
Otomatik uretildi (`node hoodcheck-paket.mjs`); elle duzenleme, ana projede duzenle ve
yeniden uret.

## Calistirma

    npm install
    SITE_URL=https://alanadi.com HOODCHECK_HOST=0.0.0.0 TRUST_PROXY=1 npm start

## Ortam degiskenleri

| Degisken | Ne ise yarar |
|---|---|
| `SITE_URL` | Paylasim kartinin mutlak adresi. Verilmezse X onizlemesi gorunmez. |
| `HOODCHECK_HOST` | `0.0.0.0` verilmezse sadece yerelden erisilir. |
| `HOODCHECK_PORT` | Varsayilan 8080. |
| `HOODCHECK_RPC` | Ozel RPC adresi. Verilmezse genel RPC kullanilir (daha yavas, 429 riski). |
| `TRUST_PROXY` | CDN/ters vekil arkasindaysan `1` ver, yoksa hiz siniri herkesi tek IP sanar. |

## Fly.io'ya cikis

    fly launch --no-deploy          # app adini sorar, fly.toml'u gunceller
    fly secrets set HOODCHECK_RPC="https://robinhood-mainnet.g.alchemy.com/v2/ANAHTAR"
    fly deploy

Sonra `fly.toml` icindeki `SITE_URL` degerini gercek adrese cevir ve tekrar `fly deploy`.
Kontrol: `fly logs` ve `https://<app>.fly.dev/saglik`

## Onemli

- Bu servis **cuzdan anahtari okumaz**, zincire cuzdansiz baglanir.
- `.env` dosyasi bu pakete DAHIL DEGILDIR ve olmamalidir. Anahtar gerekiyorsa
  `HOODCHECK_RPC` ortam degiskeniyle verilir.
- Bot paneli (port 3777) bu pakette yok ve internete asla acilmamalidir.
