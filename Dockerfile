# syntax=docker/dockerfile:1
# ============================================================================
# KuveytTürk – Yapay Zeka Laboratuvarı dikey kiosk · PRODUCTION imajı
# ----------------------------------------------------------------------------
# AppSec container-scan hedefi: repo KÖKÜNDEKİ tek, sertleştirilmiş Dockerfile.
# Pipeline bunu `docker build -f Dockerfile -t local/app:scan .` ile derleyip
# Trivy ile tarar → TARANAN = DAĞITILAN imaj.
#
# Sertleştirme kararları:
#   - alpine tabanı  → debian base'in düzeltilemeyen CVE kuyruğu yok.
#   - apk upgrade    → base tag tazelenene kadar OS paketleri yamalı kalır.
#   - npm/npx SİLİNİR→ prod runtime'da paket yöneticisi gerekmez; npm'in kendi
#                      bağımlılık CVE'leri imajdan tamamen elenir.
#   - USER node      → ayrıcalıksız (uid 1000); container-escape yüzeyi daralır.
#   - HEALTHCHECK    → orchestrator-agnostik readiness probe'u (Node yerleşik fetch).
#   - Build adımı YOK: uygulama saf Node.js standart kütüphanesi, npm bağımlılığı
#     SIFIR → tedarik zinciri saldırı yüzeyi de sıfır (app_security §11).
# ============================================================================
FROM node:22-alpine AS runtime

# Base OS paketlerini yamalı sürümlere yükselt (openssl/busybox CVE kuyruğu).
# tzdata: TZ env'inin (randevu/saat gösterimi) alpine'de çalışması için gerekir.
RUN apk upgrade --no-cache && apk add --no-cache tzdata

# Prod runtime'da paket yöneticisi gerekmez — saldırı yüzeyini düşür.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5353 \
    HOST=0.0.0.0 \
    TZ=Europe/Istanbul \
    LOG_LEVEL=info \
    STATE_FILE=/data/state.json

# Yalnız çalışma-zamanı dosyaları (testler, scriptler, dokümanlar imaja GİRMEZ).
COPY --chown=node:node package.json server.js kiosk.html control.html state.json ./

# Ayarların yazıldığı dizin — ayrıcalıksız kullanıcıya ait olmalı, yoksa
# read-only kök dosya sistemiyle çalışırken state kaydedilemez.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 5353

# npm imajdan kaldırıldığı için Node 22'nin yerleşik fetch'i kullanılır.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:5353/api/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Shell YOK (exec form) → PID 1 doğrudan node; SIGTERM uygulamaya ulaşır ve
# server.js graceful shutdown yapar.
CMD ["node", "server.js"]
