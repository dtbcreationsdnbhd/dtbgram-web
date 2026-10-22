# Native push relay and protocol probe

The bot-free, per-installation relay is documented in [DEVICE_RELAY.md](DEVICE_RELAY.md). Its Firebase confirmation pairs a native installation with its private relay endpoint. The app's existing Telegram session registers that endpoint; users do not need a verification bot or another login.

The instructions below describe the separate, short-lived protocol probe. Its deployment template serves that diagnostic receiver only; it does not deploy the device relay.

## Operator protocol probe

This is Phase 0 of `docs/NATIVELY_FULL_PREVIEW_PUSH_PLAN.md`: a short-lived, operator-controlled experiment for one Android installation and one Telegram account. It is **not a production notification relay**. It has no public enrollment, configuration, or arbitrary-send API and does not establish user identity for a multi-user service.

The probe receives Telegram type-10 Web Push, decrypts one RFC 8291 `aes128gcm` record, and sends a standard Firebase notification to one fixed native token. Node.js 24 runs the TypeScript directly; no new dependencies are required.

## Required inputs

- A staging Natively APK loading a beta build with `window.nativePushProbe` available after opening the Natively console.
- Native notification permission and an FCM token from that APK.
- A Firebase service-account JSON authorized to send messages in the APK's Firebase project. `google-services.json` is Android configuration and cannot authorize server sends.
- An operator-controlled HTTPS origin forwarding `/telegram-push/*` to this receiver without rewriting the path. Configure its access logs to omit the capability path and request headers. Nothing here provisions a hostname, load balancer, or AWS resources.

Keep all generated JSON outside Git, web roots, Docker images, and client build arguments. These files contain sensitive tokens or receiver secrets; the commands require regular files without group/other permissions (`chmod 600`). The enrollment file is sensitive even though it has no private receiver key.

## Prepare the controlled installation

Open notification settings and enable the app's notifications. In the Natively console, run:

```js
await window.nativePushProbe.exportSetup();
```

Copy the downloaded `native-push-probe-setup.json` to a private operator directory. It contains the current account, native token, localized labels, preview settings, and excluded internal/hidden chat IDs. Do not paste the setup or token into shared logs or issue reports.

The following shell commands run from the repository root. Replace the setup, service-account, and HTTPS-origin placeholders with local paths and the staging receiver origin. The origin has no trailing slash.

```bash
NATIVE_PUSH_DIR="$(mktemp -d /private/tmp/native-push.XXXXXX)"
cp /absolute/path/native-push-probe-setup.json "$NATIVE_PUSH_DIR/setup.json"
cp /absolute/path/firebase-service-account.json "$NATIVE_PUSH_DIR/firebase.json"
chmod 600 "$NATIVE_PUSH_DIR/setup.json" "$NATIVE_PUSH_DIR/firebase.json"

node server/native-push/main.ts prepare \
  "$NATIVE_PUSH_DIR/setup.json" \
  "$NATIVE_PUSH_DIR/probe.json" \
  "$NATIVE_PUSH_DIR/enrollment.json" \
  https://relay-staging.example.com
```

`prepare` creates files exclusively and never overwrites them. A partial failure can leave the probe file behind; use new output paths for another attempt. The registration expires one hour after preparation. The private probe file remains on the receiver; only the enrollment file goes to the APK console.

First confirm native Firebase delivery independently of Telegram:

```bash
node server/native-push/main.ts send \
  "$NATIVE_PUSH_DIR/probe.json" \
  "$NATIVE_PUSH_DIR/firebase.json"
```

This explicitly sends one card using the exported app name and localized generic message label. `smokeAcceptedByFirebase` confirms Firebase acceptance; check the device for actual display and tap behavior. A wrong Firebase project, missing permission, or invalid token must be resolved before continuing.

Start the temporary receiver behind the HTTPS route:

```bash
ENABLE_NATIVE_PUSH_PROBE=1 node server/native-push/main.ts serve \
  "$NATIVE_PUSH_DIR/probe.json" \
  "$NATIVE_PUSH_DIR/firebase.json"
```

It listens on `127.0.0.1:8787`; override with `NATIVE_PUSH_HOST=0.0.0.0` and `NATIVE_PUSH_PORT` only when the deployment requires them. Restrict direct network access to the reverse proxy. `GET /health` returns 200 only while the configuration remains enabled and valid. The process stops accepting connections when its configuration expires.

In the APK console, pass the complete enrollment JSON object as the argument, using the contents of the private enrollment file:

```js
await window.nativePushProbe.register(/* enrollment JSON object */);
```

The helper checks the current account, native-token hash, expiry, and endpoint before registering the exact Telegram type-10 subscription. Do not use the private probe JSON here. Registration success does not prove that Telegram can reach or encrypt for this endpoint; the next real delivery establishes that.

## What this probe sends

- Recognized message pushes with the expected account and a valid peer/message identity.
- Available text and supplied captions/descriptions; otherwise, existing localized media labels from the exported context. A missing caption or thumbnail is not fetched or reconstructed.
- Group/channel titles using Telegram's explicit argument positions.
- A generic localized card when previews are disabled, passcode is enabled, the screen-lock snapshot is active, or the peer has no cached preview policy.

Excluded internal/hidden chats, muted pushes, unknown event types, and control events do not produce cards. Deletion, read, configuration, badge, and session events are logged by classification only. The probe does not remove or update their existing cards.

The notification destination uses the current app's `#chatId` route. Verify that Natively preserves `data.url` and that a cold start opens the correct account before treating deep links as supported. Android notification tags remain stable for a message; whether Natively preserves them in foreground/background requires device evidence.

The setup is a **policy snapshot**. It cannot see a changed mute/preview/passcode setting or logout while the page is closed. Disable the probe before changing settings, switching accounts, or logging out; export and prepare a fresh snapshot afterward. This restriction makes the experiment unsuitable for ordinary users.

## Disable and clean up

Set `disabled` to `true` in the private probe JSON and save it with private permissions. The service re-reads this file before each send, including after obtaining its OAuth token. A changed configuration or unreadable file also blocks sends; restart only after reviewing a new configuration. An already-issued Firebase request cannot be recalled.

Remove the exact Telegram registration in the APK console:

```js
await window.nativePushProbe.unregister();
```

Stop the receiver and remove the private setup/enrollment/probe copies when finished. Remove the downloaded setup copy too. Do not remove the organization's retained Firebase credentials; handle those through its normal secret-storage process. Unregister before replacing or discarding the enrollment so temporary Telegram subscriptions do not accumulate. Browser/PWA subscriptions are separate.

## Verification and limits

Run the existing project TypeScript check and the separate backend type check after changes:

```bash
npm run check:ts
npx tsc -p server/native-push/tsconfig.json --noEmit
```

Follow repository instructions: do not create test files. Manually confirm private/group/bot/channel text and media, supplied versus missing captions, native foreground/background/normal closure, notification taps, preview privacy, and independent iPhone PWA delivery. Record only outcome IDs, classifications, and screenshots appropriate for the controlled session.

Ingress is restricted to POST with one `aes128gcm` record and a body of at most 4096 bytes. Unsupported methods or encodings are rejected and reported without exposing headers or message content. Decryption validates key sizes, record bounds, the GCM tag, UTF-8, JSON, and final padding. A valid ciphertext authenticates knowledge of the receiver auth secret; it does **not** independently authenticate Telegram. VAPID is observed only as the presence of an authorization header, not verified. Endpoint/auth secrets must remain private during this controlled proof.

The receiver processes one delivery at a time, rejects concurrent work for upstream retry, and keeps at most 1024 dedup identities for ten minutes in memory. It marks an event before sending and does not automatically retry Firebase requests. Consequently, an uncertain send can be suppressed on retry, and a restart loses dedup state. There is no durable queue, production retry guarantee, cross-device read cleanup, deletion handling, or exactly-once claim. A tag cannot guarantee tray replacement until native behavior is verified. Silent-message sound behavior is also subject to the APK's notification-channel configuration.

The implementation logs no payload text, tokens, key material, or capability URLs. HTTPS ingress infrastructure must apply the same restrictions. Firebase authorization and responses are bounded and time-limited; service-account keys stay on the server. A visible native card is required evidence beyond a successful Firebase response.

**Stop before public rollout.** Remaining gates include real Telegram endpoint/encoding evidence, caption availability, supported native tray behavior, lifecycle/policy synchronization, delivery reliability, and staging infrastructure. Public enrollment uses the separate device-confirmation protocol in [DEVICE_RELAY.md](DEVICE_RELAY.md); this probe has no enrollment API. A supplied Telegram ID or the website API key is not proof of account ownership.

## Container

Build from the repository root:

```bash
docker build -f server/native-push/Dockerfile -t native-push-probe .
```

The image contains source only, runs as the `node` user, and expects read-only mounted private JSON files at `/run/secrets/native-push-probe.json` and `/run/secrets/firebase-service-account.json`. Ensure that user can read the mounts without granting group/other access. Set `ENABLE_NATIVE_PUSH_PROBE=1` and route HTTPS externally. Mount the probe file so an operator can set its kill switch; do not bake configuration into the image.

For the isolated ECS deployment, follow [DEPLOY_STAGING.md](DEPLOY_STAGING.md). Its `serve-env` command materializes ECS-injected secret values as private runtime files. Updating the source secret does not update a running task; use the deployment's explicit stop command for its kill switch.

## Protocol references

- [Telegram push formats and token type 10](https://core.telegram.org/api/push-updates)
- [RFC 8291 Web Push encryption](https://www.rfc-editor.org/rfc/rfc8291)
- [RFC 8188 encrypted content encoding](https://www.rfc-editor.org/rfc/rfc8188)
- [Firebase server authorization](https://firebase.google.com/docs/cloud-messaging/auth-server)
- [Firebase Android notification fields](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidNotification)
- [Natively Firebase integration](https://docs.buildnatively.com/natively-platform/features/notifications/firebase-push-notifications-advanced)
