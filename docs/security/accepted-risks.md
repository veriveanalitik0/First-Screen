# Kabul Edilen Güvenlik Riskleri (Accepted Risks)

Bu belge, **bilerek kapatılmamış** riskleri kaydeder. Her kayıt; etkiyi,
gerekçeyi, telafi edici kontrolleri ve kararın yeniden değerlendirileceği
tetikleyiciyi içerir. Bir riski burada görmek "önemsiz" demek değildir —
"şu koşullar altında kabul edildi" demektir.

---

## AR-001 — Kimlik doğrulama yok: paneli açan herkes ayarları değiştirebilir

**Durum:** kabul edildi · **Sahip:** AI Lab · **Kayıt:** 2026-08-24

### Etki
Servise ağ üzerinden erişebilen herkes `/control` panelini açıp ekranın dönüş
hızını, kamera açısını ve zoom'unu değiştirebilir; `/api/reset` ile varsayılana
döndürebilir. Kalıcı zarar veya veri sızıntısı yoktur — etki, ekranın yanlış
görünmesidir.

### Gerekçe
Kiosk, laboratuvar içindeki bir TV'yi besler ve **iç ağa** açılır. Panelin
amacı, ekranın yanında duran kişinin telefonundan saniyeler içinde ayar
yapabilmesidir; araya kimlik doğrulama koymak bu akışı kullanılamaz hale
getirirdi. Depolanan veri kişisel veri değildir.

### Telafi edici kontroller
- Servis yalnız iç ağa/VPN'e yayımlanır (internete açılmaz).
- Tüm girdiler güvenli aralığa sıkıştırılır → "bozuk" bir ayar gönderilemez.
- Rate limit, otomatik/toplu değişiklik denemelerini sınırlar.
- `/api/reset` her zaman bilinen iyi duruma döndürür.

### Yeniden değerlendirme tetikleyicisi
Servis internete açılırsa, misafir ağından erişilebilir hale gelirse ya da
ekranda kurum dışına görünen içerik gösterilmeye başlanırsa: önüne kimlik
doğrulama yapan bir reverse proxy konmalıdır.

---

## AR-002 — Sayfa varlıkları CDN'den yüklenir (three.js, Google Fonts)

**Durum:** kabul edildi · **Sahip:** AI Lab · **Kayıt:** 2026-08-24

### Etki
`kiosk.html`, 3B motoru `cdnjs.cloudflare.com`'dan çeker. CDN ele geçirilirse
ya da DNS/ağ araya girerse ekranda saldırganın kodu çalışabilir. Ayrıca ekranın
**dış internet erişimi** olmadan çalışmaz (README "Notlar").

### Gerekçe
Varlıkları repoya almak dosya boyutunu ve bakım yükünü artırır; mevcut kurulumda
ekranın zaten dış erişimi vardır ve CDN sürümü sabittir (`three.js/r128`).

### Telafi edici kontroller
- CSP, script yüklemesini **yalnız** bu host'a ve nonce'lu inline bloğa açar;
  başka bir origin'den script yüklenemez.
- Sürüm sabittir (`r128`) — sessiz güncelleme olmaz.
- Uygulama (pod) dışarı bağlantı açmaz; dış istek yalnız tarayıcıdadır. Helm
  NetworkPolicy'sinde egress kapalıdır.

### Yeniden değerlendirme tetikleyicisi
Çevrimdışı kurulum gerekirse ya da SRI (`integrity`) eklenmesi kararlaştırılırsa:
varlıklar repoya alınır ve `server.js` içindeki `CDN_*` sabitleri boşaltılır.

---

## AR-003 — Ayarlar tek dosyada; yatay ölçekleme yok

**Durum:** kabul edildi · **Sahip:** AI Lab · **Kayıt:** 2026-08-24

### Etki
Durum tek bir JSON dosyasında ve süreç belleğinde tutulur. Servis yatay
ölçeklenemez; pod/container yeniden başlarken (Recreate) birkaç saniyelik
kesinti olur.

### Gerekçe
Tek bir ekranı besleyen, altı sayısal alanı olan bir servise veritabanı ya da
dağıtık durum eklemek karmaşıklığı (ve saldırı yüzeyini) veri değerinin çok
üstüne çıkarırdı.

### Telafi edici kontroller
- Helm chart'ı `replicaCount > 1` verilirse **kurulumu durdurur** — sessiz
  durum tutarsızlığı yerine açık hata.
- Ayarlar PVC/volume'de kalıcıdır; yeniden başlatma ayarları kaybetmez.
- `Recreate` stratejisi, RWO volume'ün iki pod'a bağlanmaya çalışmasını önler.

### Yeniden değerlendirme tetikleyicisi
Birden fazla ekranın **farklı** ayarlarla beslenmesi ya da yüksek erişilebilirlik
istenirse: ayarlar paylaşımlı bir depoya (Redis/Postgres) taşınmalıdır.
