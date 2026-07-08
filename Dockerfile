# KuveytTürk – Yapay Zeka Laboratuvarı dikey kiosk
# Harici npm paketi yok; sadece Node.js standart kütüphanesi kullanılıyor.
FROM node:20-alpine

WORKDIR /app

# Uygulama dosyaları
COPY server.js kiosk.html control.html state.json ./

ENV PORT=5353
# Ayarlar bu yola yazılır; kalıcılık için /data'ya bir volume bağlayın.
ENV STATE_FILE=/data/state.json

EXPOSE 5353

# /data yoksa oluştur ve ilk kez varsayılan ayarı tohumla, sonra sunucuyu başlat.
CMD ["sh","-c","mkdir -p /data; [ -f \"$STATE_FILE\" ] || cp /app/state.json \"$STATE_FILE\"; exec node server.js"]
