FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.mjs mqtt-normalizer.mjs ./

ENV HTTP_PORT=80 \
    MQTT_PORT=1883 \
    PIXOOPAL_HOST_IP=10.42.0.1

EXPOSE 80 1883

CMD ["node", "server.mjs"]
