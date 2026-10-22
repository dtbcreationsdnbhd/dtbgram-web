FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node server/native-push/*.ts ./server/native-push/
COPY --chown=node:node src/assets/localization/fallback.strings ./src/assets/localization/fallback.strings
RUN mkdir /app/state && chown node:node /app/state && chmod 700 /app/state

USER node
ENV NATIVE_PUSH_HOST=0.0.0.0
ENV NATIVE_PUSH_PORT=8787
ENV NATIVE_PUSH_STATE_DIR=/app/state
EXPOSE 8787

CMD ["node", "server/native-push/relay.ts"]
