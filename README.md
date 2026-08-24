# KuveytTürk · Yapay Zeka Laboratuvarı — Dikey Kiosk

Dikey (9:16) bir TV/ekranda sürekli dönen 3B maketi gösteren, aynı ağdaki bir
telefon/bilgisayardan **yeniden başlatmadan** uzaktan ayarlanabilen kiosk.

> **Üretime hazır:** Servis; sertleştirilmiş container imajı, prod compose
> stack'i, Helm chart'ı, AppSec/CI pipeline'ı ve 49 testlik bir güvenlik test
> paketiyle gelir. Ayrıntı: [`docs/security/app_security.md`](docs/security/app_security.md).

## İçindekiler

| Yol | Ne işe yarar |
|---|---|
| `kiosk.html` | TV'de açılacak sayfa (dönen 3B maket) |
| `control.html` | Kontrol paneli (telefon/bilgisayarda açılır) |
| `server.js` | Node.js sunucusu — **sıfır npm bağımlılığı** |
| `state.json` | Varsayılan ayarlar (şablon) |
| `tests/` | `node:test` ile güvenlik + API test paketi |
| `Dockerfile` | Sertleştirilmiş production imajı (AppSec tarama hedefi) |
| `docker-compose.yml` | Geliştirme stack'i |
| `docker-compose.prod.yml` | Production stack (read-only fs, cap_drop, limitler) |
| `helm/kiosk/` | Kubernetes Helm chart'ı |
| `.appsec.yml` | AppSec pipeline manifesti (SAST/DAST/container-scan) |
| `.github/workflows/` | CI (test + container smoke + helm) ve Security |
| `docs/security/` | Uygulama güvenliği ve kabul edilen riskler |

## Hızlı başlangıç (geliştirme)

```bash
# Docker ile
docker compose up -d --build

# ya da doğrudan Node ile (bağımlılık kurulumu YOK)
node server.js
```

- **TV'de açın:** `http://<SUNUCU-IP>:5353/`
- **Kontrol paneli:** `http://<SUNUCU-IP>:5353/control`

`<SUNUCU-IP>` = servisin çalıştığı makinenin yerel ağ IP'si
(Linux: `hostname -I`, macOS: `ipconfig getifaddr en0`).

## Testler

```bash
npm test          # 49 test — birim, entegrasyon ve güvenlik regresyonları
npm run lint      # söz dizimi kontrolü (harici linter kurulumu gerekmez)
```

Testler bağımlılık kurulumu gerektirmez; Node 22+ yeterlidir.

## Production kurulumu

### A) Docker Compose

```bash
cp .env.prod.example .env.prod       # değerleri doldurun
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Dev stack'ten farkları: salt-okunur kök dosya sistemi + tmpfs, tüm Linux
capability'lerinin düşürülmesi, `no-new-privileges`, bellek/CPU limitleri, log
rotasyonu ve ayrı proje adı (dev stack'i sökmez).

### B) Kubernetes (Helm)

```bash
helm upgrade --install kiosk ./helm/kiosk -n kiosk --create-namespace \
  --set image.repository=<registry>/kuveyt-kiosk \
  --set image.tag=1.0.0 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=kiosk.klab.example
```

Chart varsayılan olarak: ayrıcalıksız çalışma (`runAsNonRoot`, uid 1000),
salt-okunur kök dosya sistemi, tüm capability'lerin düşürülmesi,
`seccompProfile: RuntimeDefault`, ServiceAccount token'ının mount edilmemesi,
kaynak limitleri ve `/api/health` + `/api/readiness` probe'ları uygular.

> `replicaCount` 1'den büyük verilemez: ayarlar tek dosyada tutulduğundan çoklu
> replika durum tutarsızlığı yaratır ve chart kurulumu bilerek durdurur.

### Yapılandırma (ortam değişkenleri)

Tam liste ve gerekçeler: [`.env.prod.example`](.env.prod.example).

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` / `HOST` | `5353` / `0.0.0.0` | Dinlenen adres |
| `STATE_FILE` | `/data/state.json` | Ayarların yazıldığı dosya |
| `TRUST_PROXY_HOPS` | `0` | Önündeki proxy sayısı (rate limit + HSTS kararı) |
| `ALLOWED_ORIGINS` | *(boş)* | CORS beyaz listesi; boş = yalnız same-origin |
| `HSTS_ENABLED` | `true` | https isteklerinde HSTS gönder |
| `RATE_LIMIT_MAX` | `600` | IP başına dakikalık istek sınırı |
| `MUTATION_RATE_LIMIT_MAX` | `60` | IP başına dakikalık POST sınırı |
| `MAX_BODY_BYTES` | `16384` | İstek gövdesi üst sınırı |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

## Uzaktan kontrol

Paneli açın, slider'ları oynatın. Değişiklik ekrana **~2 saniye** içinde yansır;
container'ı yeniden başlatmaya gerek yoktur.

| Ayar | Açıklama |
|---|---|
| Dönüş hızı | Bir tam turun süresi (küçük = hızlı) |
| Döndür/Duraklat | Dönüşü durdurup başlatır |
| Yön | Saat yönü ↔ ters yön |
| Model boyutu | Maketin çerçeveyi doldurma oranı |
| Kamera açısı | Kuşbakışı ↔ daha yandan görünüm |
| Dikey konum | Maketi çerçevede yukarı/aşağı kaydırır |

Ayarlar `STATE_FILE` yolunda (Docker volume / Kubernetes PVC) tutulur, bu yüzden
servis yeniden başlasa bile son ayarlar korunur. "Varsayılana döndür" sıfırlar.

## API

```bash
# mevcut ayarlar
curl http://<IP>:5353/api/state

# hızı değiştir (yalnızca değiştirmek istediğiniz alanı gönderin)
curl -X POST http://<IP>:5353/api/state \
  -H "Content-Type: application/json" \
  -d '{"secPerTurn": 30}'

# varsayılana döndür
curl -X POST http://<IP>:5353/api/reset

# sağlık uçları (orchestrator probe'ları)
curl http://<IP>:5353/api/health      # liveness
curl http://<IP>:5353/api/readiness   # readiness (ayar diski yazılabilir mi)
```

Gönderilen değerler güvenli aralığa sıkıştırılır; şemada olmayan alanlar yok
sayılır. Tarayıcıdan gelen `POST` istekleri Origin doğrulamasından geçer —
`Origin` başlığı olmayan istemciler (curl, otomasyon) etkilenmez.

## Notlar

- 3B görünüm ve yazı tipleri CDN'den yüklenir → **ekranın internet erişimi**
  olmalıdır. Gerekçe ve alternatifi: `docs/security/accepted-risks.md` → AR-002.
- Portu değiştirmek için compose'daki `"5353:5353"` satırını düzenleyin
  (prod'da `HTTP_PORT`).
- Sunucusuz hızlı deneme: `kiosk.html`'i tarayıcıda açabilirsiniz; ayarları
  URL'den de verebilirsiniz, ör. `kiosk.html?secPerTurn=30&zoom=1.2&phi=0.8`.
- Kimlik doğrulama bilinçli olarak yoktur; servis **iç ağa** açılmalıdır.
  Ayrıntı: `docs/security/accepted-risks.md` → AR-001.
