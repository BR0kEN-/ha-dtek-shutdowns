ARG BUILD_FROM
FROM $BUILD_FROM

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

RUN \
  apk add --no-cache \
    nodejs \
    npm \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates

COPY dtek-check-shutdown.js package*.json ./
RUN npm install --production
COPY --chmod=755 ./run.sh /

CMD ["/run.sh"]
