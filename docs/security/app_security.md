# Uygulama Güvenliği — Dikey Kiosk

Bu belge, kiosk servisinin üretimde hangi kontrollerle çalıştığını ve bu
kontrollerin **neden** böyle seçildiğini anlatır. Yapı, RESERVATION-SYSTEM
reposundaki `docs/security/app_security.md` ile hizalıdır; farklar servisin
mimarisinden gelir (kimlik doğrulama, veritabanı ve dış API bağımlılığı yoktur).

## 0. Tehdit modeli — bu servis nedir, ne değildir

Kiosk, **iç ağdaki bir ekranı** besleyen tek container'lık bir HTTP sunucusudur:
dönen 3B maketi gösteren bir sayfa, aynı ağdaki bir telefondan açılan bir
kontrol paneli ve altı sayısal ayarı tutan küçük bir JSON API'si.

- **Kişisel veri işlemez.** Depolanan tek şey görüntüleme ayarlarıdır
  (dönüş hızı, kamera açısı, zoom...). KVKK kapsamında veri yoktur.
- **Kimlik doğrulama YOKTUR** ve bu bilinçlidir: paneli açan herkes ayarları
  değiştirebilir. Koruma sınırı **ağdır** — servis yalnız iç ağa/VPN'e açılır.
  Bkz. `accepted-risks.md` → AR-001.
- Bu nedenle asıl tehditler: (a) ayarları bozarak ekranı kullanılamaz hale
  getirme, (b) sayfaya kod enjekte edip ekranı başka içerik göstermeye zorlama,
  (c) servisi kaynak tüketimiyle düşürme, (d) container'dan host'a sıçrama.

## 1. Girdi doğrulama (§3)

Tüm ayar girdileri `sanitize()` içinde **allowlist** ile işlenir:

- Şemada olmayan hiçbir alan taşınmaz (`adminPassword`, `__proto__` gibi
  anahtarlar sessizce düşer → prototype pollution yüzeyi yok).
- Her sayısal alan güvenli aralığa `clamp` edilir (ör. `secPerTurn` 3–600 sn).
  Aralık dışı değer **reddedilmez, sıkıştırılır** — panelde slider'ı sonuna
  kadar çeken kullanıcı hata görmez, ekran da kullanılamaz hale gelmez.
- `direction` yalnız `-1`/`1`, `paused` yalnız `boolean` kabul eder.
- Diskteki `state.json` elle bozulmuşsa da aynı doğrulamadan geçirilir
  (dosyaya güvenilmez).

İstek gövdesi `MAX_BODY_BYTES` (varsayılan 16 KB) ile sınırlıdır; aşan istek
gövdesi **okunmadan** kesilir ve 413 döner — sınırsız tamponlama bellek
tüketimi (DoS) demektir.

## 2. Kimlik doğrulama ve yetkilendirme (§4, §5)

Yoktur — yukarıdaki tehdit modeline bakınız. Servis internete açılacaksa bu
karar geçersizdir: önüne kimlik doğrulama yapan bir reverse proxy (ör. OAuth2
proxy, temel kimlik doğrulama) konulmalıdır.

## 3. Oturum ve HTTP güvenliği (§6)

Her yanıt (HTML, JSON, 404 ve 429 dahil) şu başlıkları taşır:

| Başlık | Değer | Amaç |
|---|---|---|
| `Content-Security-Policy` | nonce'lu, `unsafe-inline` YOK | XSS |
| `X-Frame-Options` | `DENY` | clickjacking |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | referrer sızıntısı |
| `Permissions-Policy` | kamera/mikrofon/konum... kapalı | tarayıcı API kötüye kullanımı |
| `Cross-Origin-Opener-Policy` | `same-origin` | Spectre sınıfı izolasyon |
| `Cross-Origin-Resource-Policy` | `same-origin` | kaynak çalma |
| `Strict-Transport-Security` | yalnız https isteğinde | protokol düşürme |

### 3.1 CSP nonce — neden `unsafe-inline` yok

`kiosk.html` ve `control.html` tek dosyalık sayfalardır; stil ve script
**inline**'dır. En kolay yol `script-src 'unsafe-inline'` olurdu — ki bu CSP'nin
XSS'e karşı değerini büyük ölçüde sıfırlar.

Bunun yerine sunucu, HTML'i servis ederken **istek başına rastgele bir nonce**
üretir, `<script>` ve `<style>` etiketlerine yazar ve aynı nonce'u CSP
başlığına koyar. Enjekte edilen bir script nonce'u bilemeyeceği için çalışmaz.
Nonce'un tekrar kullanılmaması gerektiğinden HTML `Cache-Control: no-store` ile
servis edilir.

`style-src-attr 'unsafe-inline'` bilinçli bir istisnadır: three.js ve DOM
kodu eleman `style` attribute'u yazar; bunu kapatmak 3B görünümü bozardı ve
stil attribute'u üzerinden kod çalıştırma yolu yoktur.

### 3.2 Dış kaynaklar (CDN)

`kiosk.html` three.js'i `cdnjs.cloudflare.com`'dan, yazı tiplerini Google
Fonts'tan yükler. CSP bu iki host'a **yalnız ilgili direktifte** izin verir
(script / style+font). Tam çevrimdışı kurulum için bu varlıklar repoya alınıp
CSP'deki host'lar kaldırılabilir — `server.js` içindeki `CDN_*` sabitleri.

### 3.3 CORS ve durum değiştiren istekler

Eski sürüm her yanıta `Access-Control-Allow-Origin: *` koyuyordu: internetteki
herhangi bir sayfa, ziyaretçinin tarayıcısı üzerinden kiosk API'sini okuyup
**yazabiliyordu**. Kaldırıldı.

- CORS başlığı yalnız `ALLOWED_ORIGINS` listesindeki origin'lere döner; joker
  (`*`) desteklenmez. Varsayılan liste boştur (yalnız same-origin).
- `POST` istekleri ayrıca **Origin doğrulaması**ndan geçer: yabancı origin 403
  alır (CSRF sınıfı koruma). `Origin` başlığı olmayan istemciler (curl,
  otomasyon) çalışmaya devam eder — README'deki API örnekleri bozulmaz.

## 4. Dosya ve kaynak yönetimi (§9)

Statik servis bir **allowlist**tir (`STATIC_ROUTES`): yalnız `/`, `/index.html`,
`/kiosk.html`, `/control`, `/control.html` yolları bir dosyaya eşlenir. Bu
haritada olmayan hiçbir yol dosya sistemine dokunmaz.

Önceki sürüm `path.normalize` + prefix kontrolüyle ROOT altındaki her dosyayı
servis ediyordu; bu hem `server.js`/`state.json` gibi dosyaları açığa çıkarıyor
hem de prefix kontrolünün klasik zayıflığına (`/app` ile `/app-yedek` aynı
prefix'i taşır) dayanıyordu. Allowlist ile traversal **yapısal olarak**
imkânsızdır — `tests/static-allowlist.test.js` bunu 9 farklı kodlama denemesiyle
doğrular.

## 5. Erişim sınırlama (rate limit)

IP başına iki ayrı sayaç: genel istekler (varsayılan 600/dk) ve durum değiştiren
istekler (60/dk). Aşımda `429` + `Retry-After`. Kovalar süresi dolunca
temizlenir (sayaç tablosunun kendisi bir bellek DoS yüzeyi olmasın).

`TRUST_PROXY_HOPS` doğru ayarlanmalıdır: fazla verilirse istemcinin uydurduğu
`X-Forwarded-For` girdisine güvenilir (limit atlatılır), eksik verilirse tüm
istemciler proxy IP'siyle tek kovada sayılır.

## 6. Hata yönetimi ve loglama (§8)

Yanıtlar yığın izi (stack trace) içermez; hata gövdeleri kısa ve sabittir.
Loglar JSON satırlarıdır (`ts`, `level`, `msg`) ve `LOG_LEVEL` ile filtrelenir.
Loglanan tek istek verisi IP, yol ve origin'dir — ayar değerleri kişisel veri
değildir, gövde loglanmaz.

`X-Powered-By` / `Server` başlıkları gönderilmez (sürüm sızıntısı, ZAP 10036).

## 7. Tedarik zinciri (§11)

**Bu serviste npm bağımlılığı sıfırdır** — `dependencies` ve `devDependencies`
boştur, `node_modules` yoktur. Test koşucusu (`node:test`) ve lint Node'un
kendi standart kütüphanesindendir. Böylece:

- Bağımlılık CVE'si, typosquatting ve postinstall script'i saldırı yüzeyi yok.
- `npm ci` adımı olmadığından CI hızlı ve deterministik.

CI bu durumu **test eder**: `package.json`'a bağımlılık eklenirse `test` job'ı
kırmızıya döner. Bu bilinçli bir kapıdır — bağımlılık gerekiyorsa karar
bilerek verilmelidir.

GitHub Actions'ta üçüncü-taraf reusable workflow **commit SHA'sına** sabitlenir
(`@main` mutable'dır ve tedarik zinciri riskidir).

## 8. Container ve dağıtım sertleştirmesi (§12)

| Kontrol | Nerede | Neden |
|---|---|---|
| `node:22-alpine` tabanı | `Dockerfile` | debian base'in kapanmayan CVE kuyruğu yok |
| `apk upgrade` | `Dockerfile` | base tag tazelenene kadar OS yamaları |
| npm/npx silinir | `Dockerfile` | prod'da paket yöneticisi gereksiz; npm'in kendi CVE'leri elenir |
| `USER node` (uid 1000) | `Dockerfile` | ayrıcalıksız çalışma |
| `HEALTHCHECK` | `Dockerfile` | orchestrator-agnostik readiness |
| `read_only: true` + tmpfs | compose / Helm | kod ve binary değiştirilemez |
| `cap_drop: ALL` | compose / Helm | hiçbir Linux capability gerekmez |
| `no-new-privileges` | compose / Helm | setuid ile yükselme yok |
| bellek/CPU limitleri | compose / Helm | tek servis host'u tüketemez |
| `automountServiceAccountToken: false` | Helm | container ele geçse de API sunucusuna yol yok |
| NetworkPolicy (egress yok) | Helm | pod dışarı bağlantı açmaz |

Taranan imaj = dağıtılan imaj: AppSec container-scan kökteki tek `Dockerfile`'ı
derler, prod compose ve Helm de aynı imajı kullanır.

## 9. Doğrulama — hangi kontrolün testi var

| Kontrol | Test |
|---|---|
| Güvenlik başlıkları (HTML/JSON/404) | `tests/security-headers.test.js` |
| CSP nonce üretimi, tekrarsızlık, `unsafe-inline` yokluğu | `tests/security-headers.test.js` |
| Path traversal (9 kodlama) + hassas dosyalar | `tests/static-allowlist.test.js` |
| CORS beyaz listesi, joker yokluğu, Origin doğrulama | `tests/cors-origin.test.js` |
| Rate limit + `Retry-After` | `tests/rate-limit.test.js` |
| Girdi doğrulama sınırları, prototype pollution | `tests/sanitize.test.js`, `tests/api.test.js` |
| Gövde boyutu sınırı | `tests/api.test.js` |
| Readiness (taze volume) | `tests/readiness.test.js` |
| Container ayrıcalıksız + npm yok + healthcheck | `.github/workflows/ci.yml` → `container` |
| Helm sertleştirme değerleri | `.github/workflows/ci.yml` → `helm` |

Çalıştırma: `npm test` (49 test) — CI'da bloklayıcıdır.
