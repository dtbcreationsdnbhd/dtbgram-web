#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

set -a
source ./.env
set +a

for variable in \
  TELEGRAM_API_ID \
  TELEGRAM_API_HASH \
  PLATFORM_API_KEY_WEBSITE \
  SENDER_ID \
  PROJECT_ID \
  FCM_API_KEY \
  FCM_APP_ID \
  WEB_PUSH_CERTIFICATES_KEY_PAIR_PUBLIC
do
  if [[ -z "${!variable:-}" ]]; then
    printf 'Missing required variable: %s\n' "$variable" >&2
    exit 1
  fi
done

REGION="ap-southeast-1"
REGISTRY="277715911124.dkr.ecr.ap-southeast-1.amazonaws.com"
IMAGE="${REGISTRY}/dtbgram-web:staging"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "$REGISTRY"

docker build \
  --platform "$DOCKER_PLATFORM" \
  -t dtbgram-web:staging \
  --build-arg TELEGRAM_API_ID \
  --build-arg TELEGRAM_API_HASH \
  --build-arg BASE_URL=https://monoverse.biz/ \
  --build-arg APP_ENV=staging \
  --build-arg HEAD=staging \
  --build-arg PLATFORM_API_KEY_WEBSITE \
  --build-arg NATIVE_PUSH_RELAY_URL \
  --build-arg PLATFORM_API_ORIGIN=https://staging.dhfko7aevmlgq.amplifyapp.com \
  --build-arg ROSTER_SESSION_USER_ID=1115436993 \
  --build-arg TG_MANAGER_BOT_USER_ID=8849753612 \
  --build-arg TG_MANAGER_BOT_ACCESS_HASH \
  --build-arg TG_MANAGER_BOT_TOKEN \
  --build-arg SENDER_ID \
  --build-arg PROJECT_ID \
  --build-arg FCM_API_KEY \
  --build-arg FCM_APP_ID \
  --build-arg WEB_PUSH_CERTIFICATES_KEY_PAIR_PUBLIC \
  .

docker tag dtbgram-web:staging "$IMAGE"
docker push "$IMAGE"

aws ecs update-service \
  --cluster dtbgram \
  --service dtbgram-web-staging \
  --force-new-deployment \
  --region "$REGION" \
  --query 'service.{serviceName:serviceName,taskDefinition:taskDefinition}' \
  --output table

aws ecs wait services-stable \
  --cluster dtbgram \
  --services dtbgram-web-staging \
  --region "$REGION"

printf 'Staging service is stable. Verify https://monoverse.biz/ and Safari PWA notifications.\n'
