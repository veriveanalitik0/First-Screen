# KuveytTürk · Yapay Zeka Laboratuvarı — Dikey Kiosk

Dikey (9:16) bir TV/ekranda sürekli dönen 3B maketi gösteren, aynı ağdaki bir
telefon/bilgisayardan **yeniden başlatmadan** uzaktan ayarlanabilen kiosk.

## İçindekiler
- `kiosk.html` — TV'de açılacak sayfa (dönen 3B maket).
- `control.html` — kontrol paneli (telefon/bilgisayarda açılır).
- `server.js` — küçük Node.js sunucusu (harici bağımlılık yok).
- `state.json` — varsayılan ayarlar.
- `Dockerfile`, `docker-compose.yml` — container.

## Çalıştırma (Docker Compose — önerilen)
Klasörü sunucuya kopyalayın ve:
```bash
docker compose up -d --build
```
- **TV'de açın:**  `http://<SUNUCU-IP>:8080/`
- **Kontrol paneli:**  `http://<SUNUCU-IP>:8080/control`

`<SUNUCU-IP>` = docker'ın çalıştığı makinenin yerel ağ IP'si
(ör. Linux: `hostname -I`, macOS: `ipconfig getifaddr en0`).

### Düz Docker ile (compose olmadan)
```bash
docker build -t kuveyt-kiosk .
docker run -d --name kuveyt-kiosk -p 8080:8080 -v kiosk-data:/data --restart unless-stopped kuveyt-kiosk
```

## Uzaktan kontrol
Paneli açın, slider'ları oynatın. Değişiklik ekrana **~2 saniye** içinde yansır.
Container'ı yeniden başlatmaya / yeniden derlemeye gerek yoktur.

Ayarlanabilenler:
| Ayar          | Açıklama                                        |
|---------------|-------------------------------------------------|
| Dönüş hızı    | Bir tam turun süresi (küçük = hızlı)            |
| Döndür/Duraklat | Dönüşü durdurup başlatır                       |
| Yön           | Saat yönü ↔ ters yön                             |
| Model boyutu  | Maketin çerçeveyi doldurma oranı                |
| Kamera açısı  | Kuşbakışı ↔ daha yandan görünüm                 |
| Dikey konum   | Maketi çerçevede yukarı/aşağı kaydırır          |

Ayarlar `/data/state.json` içinde (Docker volume) tutulur, bu yüzden container
yeniden başlasa bile son ayarlar korunur. "Varsayılana döndür" butonu sıfırlar.

## Notlar
- 3B görünüm ve yazı tipleri CDN'den yüklenir → ekranın **internet erişimi**
  olmalı (aynı ağda olması yeterli değilse, çıkış interneti de gerekir).
- Portu değiştirmek için compose'daki `"8080:8080"` satırını
  (ör. `"9000:8080"`) düzenleyin.
- Sunucusuz hızlı deneme: `kiosk.html`'i tarayıcıda açabilirsiniz; ayarları
  URL'den de verebilirsiniz, ör.
  `kiosk.html?secPerTurn=30&zoom=1.2&phi=0.8`.

## API (isteğe bağlı, otomasyon için)
```bash
# mevcut ayarlar
curl http://<IP>:8080/api/state

# hızı değiştir (yalnızca değiştirmek istediğiniz alanı gönderin)
curl -X POST http://<IP>:8080/api/state \
  -H "Content-Type: application/json" \
  -d '{"secPerTurn": 30}'

# varsayılana döndür
curl -X POST http://<IP>:8080/api/reset
```
