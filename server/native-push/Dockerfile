FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node server/native-push/*.ts ./

USER node
ENV NATIVE_PUSH_HOST=0.0.0.0
ENV NATIVE_PUSH_PORT=8787
EXPOSE 8787

CMD ["node", "main.ts", "serve", "/run/secrets/native-push-probe.json", "/run/secrets/firebase-service-account.json"]
