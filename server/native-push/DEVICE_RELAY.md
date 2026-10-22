# Bot-free native device relay

**Research environment:** The dedicated AWS relay infrastructure is removed at the owner's request on 21 October 2026; staging native relay enrollment is disabled. See the [setup and workflow guide](../../docs/PWA_TO_APK_NOTIFICATIONS_GUIDE.md) and [cleanup record](../../docs/NATIVELY_AWS_RESEARCH_CLEANUP.md) for infrastructure status. The runtime/API descriptions below document the retained source implementation.

The relay receives encrypted Telegram type-10 Web Push and sends an ordinary Firebase notification to the paired Natively installation. It accepts legacy `aesgcm` with `Encryption` and `Crypto-Key` headers and modern `aes128gcm` with its binary body header. Both formats require valid recipient keys, an authentication tag, a single record, and valid padding. Each installation has its own receiver keys, endpoint, management secret, native token, and Telegram account metadata. An Android APK and an iPhone PWA keep independent registrations.

The relay does not verify Telegram account ownership and does not need an account-wide identity service. It routes each private endpoint to its fixed, confirmed native destination. The app's existing authenticated Telegram session registers that exact endpoint. A supplied Telegram ID is consistency metadata, never permission to select another record or fetch messages. No Telegram session keys or verification bot tokens are sent to this server.

Staging verification confirms Android background text-message delivery from Telegram through the relay to a visible APK notification. Other payloads and app states require device verification. A successful Firebase response alone does not prove display. This service does not guarantee missing captions, thumbnails, tray removal, or delivery after an Android force-stop.

## Pairing and activation

1. After Telegram login, the APK reads native notification permission and its Firebase token. It creates and persists a random device ID and management secret locally.
2. The app prompts the user to press Home and waits until the page is hidden before requesting a setup notification, since Firebase does not display foreground notifications by default. `POST /native-push/pairings` stores a pending record and sends a fixed, localized Firebase confirmation notification to that native token. The pairing expires after ten minutes. Disabling notifications or signing out cancels the background wait.
3. The user taps that notification. A non-secret `nativePushSetup` query parameter gives each setup a distinct page URL so Natively navigates from an already open app. Its `#nativePushPair=id.challenge` fragment is accepted only when it matches a locally initiated pairing, its management secret, the current account, and the current native token. A browser opened from an unsolicited notification cannot enroll a device.
4. The app confirms using its management secret. Only then can it obtain the receiver subscription, register it with Telegram using token type `10`, and require a successful acknowledgement.
5. The app activates the record. The relay accepts Telegram deliveries only for an active, unexpired record.

This is one native delivery confirmation, not an additional Telegram login. CORS restricts browser management calls to the configured app origin; the random management secret authorizes access to that one device. Neither CORS nor knowledge of the Telegram ID is authentication.

## Runtime configuration

Use Node.js 24. The relay uses existing project code and Node.js built-ins; installing a Firebase SDK is unnecessary.

| Variable | Meaning |
| --- | --- |
| `ENABLE_NATIVE_PUSH_RELAY=1` | Explicitly enable the relay |
| `NATIVE_PUSH_APP_URL=https://monoverse.biz/` | App URL used to validate the management origin and notification destinations |
| `NATIVE_PUSH_RELAY_URL=https://monoverse.biz` | Public HTTPS relay origin; defaults to the app origin |
| `NATIVE_PUSH_STATE_DIR=/absolute/private/state` | Persistent directory, mode `0700`, writable by the relay user |
| `FIREBASE_SERVICE_ACCOUNT_FILE=/absolute/private/firebase.json` | Private service-account JSON, mode `0600`, for the APK's Firebase project |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Alternative runtime-injected secret; omit the file variable when using this |
| `NATIVE_PUSH_HOST` | Bind address; default is loopback, set `0.0.0.0` inside a container |
| `NATIVE_PUSH_PORT` | Listener port, default `8787` |

Keep service-account credentials, state files, native tokens, and management secrets outside Git, web roots, browser bundles, and Docker build arguments. `google-services.json` configures the APK and cannot authorize server sends. Inject `FIREBASE_SERVICE_ACCOUNT_JSON` through a secret manager, not a shell command containing the JSON.

From the repository root, using existing private paths:

```bash
ENABLE_NATIVE_PUSH_RELAY=1 \
NATIVE_PUSH_APP_URL=https://monoverse.biz/ \
NATIVE_PUSH_STATE_DIR=/absolute/private/native-push-state \
FIREBASE_SERVICE_ACCOUNT_FILE=/absolute/private/firebase-service-account.json \
npm run native-push:relay
```

Provision the state directory with the required permissions before starting. It contains receiver private keys and native destinations. Use encrypted persistent storage and restrict backups. The process acquires an exclusive `process.lock`; run one process and one replica for this state directory. After a crash, remove a stale lock only after verifying that no relay process still owns the directory. Do not share the directory between independent writers.

## HTTPS routing and client configuration

Route all of these paths to the relay, preserving the complete path:

- `/native-push/*` for device management
- `/telegram-push/*` for encrypted ingress
- `/health` for an internal health check

Keep the listener private behind HTTPS. Apply ingress body/time/rate limits and redact capability paths, authorization headers, query strings, and notification bodies from proxy access/error logs. The server's limits complement infrastructure limits; they do not replace them.

Build the website with `NATIVE_PUSH_RELAY_URL=https://monoverse.biz`. The value is the HTTPS origin hosting both management and ingress routes. The client enables native enrollment only when this value is configured and the Natively wrapper is detected. Keep the value empty until routing and the relay are ready.

The existing **Offline Notifications** setting starts or stops native enrollment inside the APK. Read the full-preview disclosure, allow native notification permission, put the app in the background when prompted, and tap the confirmation notification. The reconnect action retries an interrupted pairing or registration. Opening/resuming the app refreshes registration and privacy state. Browser/PWA registration continues through its existing transport.

Use a staging website build and a staging relay first. The existing probe deployment template and `deploy-native-push-probe.sh` deploy only the operator probe. They do not provision a persistent device relay or its management paths. The normal website deploy script builds the client; it does not deploy this separate service.

## Management API

Every device route requires `Authorization: Bearer <managementSecret>`. Mutating browser requests require the exact configured app origin; authenticated reads also accept an absent Origin header for same-origin browser fetches. The initial pairing carries the newly generated secret in its JSON body over HTTPS. All responses exclude the native token, private receiver key, and management secret.

| Method and path | Request or result |
| --- | --- |
| `POST /native-push/pairings` | `{ id, managementSecret, setup }`; creates a pending record and sends confirmation |
| `POST /native-push/devices/:id/confirm` | `{ challenge }`; confirms a matching unexpired native delivery |
| `GET /native-push/devices/:id` | `{ id, status, expiresAt, policyExpiresAt, subscription? }`; subscription becomes available after confirmation |
| `POST /native-push/devices/:id/activate` | Activates after the client obtains Telegram's type-10 acknowledgement |
| `PATCH /native-push/devices/:id` | `{ setup }`; refreshes policy for the fixed account and native token |
| `DELETE /native-push/devices/:id` | Revokes delivery for this record |
| `POST /telegram-push/:capability` | Encrypted Web Push for one active record |

`setup` uses the probe's existing account, native-token, app-name/URL, localized-context, and excluded-chat snapshot format. It is validated against server configuration. It cannot select another record through its account ID. Native token or account changes require fresh pairing; a policy update cannot redirect delivery.

The server validates native-token confirmation before revealing receiver keys. Telegram registration acknowledgement is a client lifecycle step, not server-side proof of Telegram identity. The capability endpoint and receiver auth secret remain private. Ciphertext authentication proves knowledge of receiver secrets; it does not independently identify Telegram as the sender. The service exposes no account lookup, message-history fetch, or arbitrary notification-send API.

## Privacy and lifecycle

Registrations have a thirty-day lease. Policy snapshots expire after twenty-four hours; after expiry, notifications hide preview content until the app refreshes policy. Expired registration leases stop delivery. Missing per-chat preview policy, passcode restrictions, and screen-lock snapshots also hide content. Muted/excluded chats and control or unknown event types do not produce ordinary message cards.

Policy updates invalidate pending dispatches immediately while their state is persisted. Dispatch rechecks the current policy after Firebase authorization. Deduplication updates merge into the latest record and cannot restore an earlier privacy snapshot.

The client refreshes policy while active and on resume, including relevant notification/privacy changes. An offline relay cannot observe a setting change instantly. Native-token rotation, account changes, and restored/reinstalled client state require reconciliation and, where necessary, a new confirmation.

On disable or logout, revoke the relay record before unregistering the exact Telegram subscription. Interrupted cleanup remains local for retry. Other installations retain their own registrations. A Firebase request already issued before revocation cannot be recalled.

Delete/read/edit events do not imply reliable native tray cleanup. This version suppresses control alerts; supported replacement/removal behavior needs separate native evidence. The Safari visible-per-push fallback remains in the PWA and is not used for native control events.

## Notification cards and icons

Message cards use a stable account-and-chat tag. Private chats share one card per sender; groups and channels share one card per conversation. Each delivered notification replaces that conversation's card with only its latest received message preview, including the sender name for group messages. The body is limited to 400 Unicode characters. The relay keeps no preview history in memory, persistent device records, or logs. Firebase delivery order determines which replacement Android displays; the relay does not fetch Telegram history or reconstruct unread messages.

When a per-chat count is available, the title appends the number, for example `Kev (3)`. The APK sends its current unread counts and read/message watermarks for up to 64 recent loaded chats when it opens or its read state changes. The relay tracks later message IDs, ignores duplicate/edit increments and outgoing scheduled-message increments, handles read watermarks and deletion IDs, and persists numeric metadata without message text. Counts appear only when message previews are allowed. Stale snapshots cannot undo a newer read watermark. Missing baselines, ambiguous partial reads/deletions, albums without complete message identities, or more than 128 retained IDs per chat hide the number until a fresh snapshot establishes it. Delayed or missing updates can leave a count stale until the app synchronizes with Telegram again.

The relay passes the same per-chat count as FCM's `android.notification.notification_count`. Supported Android launchers can use these active notification counts for badging; some launchers show a dot. This is not a guaranteed app-wide unread total: dismissed cards, chats without active notifications, and reads on other devices can make the launcher badge differ. Read/delete pushes update relay counters without posting an alert, so cards already in Android's tray retain their displayed count until replaced, dismissed, or updated by native code. [FCM notification count](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidNotification), [Android badges](https://developer.android.com/develop/ui/views/notifications/badges)

An exact app-icon total requires Natively to expose native badge-setting and notification update/removal methods, and a background handler for read/count updates. Its published Firebase SDK does not expose these methods. Add this to the native support request below: accept a total unread count from the web app, set or clear the launcher badge where supported, update/cancel existing cards by conversation tag, and consume background count/read updates without creating an extra notification card. Once the bridge contract exists, connect the app's current total unread counter and the relay's count/read updates to that handler. Rebuilding the website alone cannot add this native capability.

The installed staging APK assigns Firebase's default small notification icon to `drawable/ic_firebase_large_icon_default`, which contains the full-color circular Kingdom Ascend image. Android renders small notification icons as monochrome alpha masks; an opaque circular image can appear as a ring or disc. Its launcher resource also includes an unrelated hand image. Correct native branding requires a Natively APK rebuild with the correct launcher artwork and a dedicated white-on-transparent notification silhouette. The relay cannot install drawable resources or set a full-color small icon using a web URL. Natively's published settings do not document a dedicated Firebase small-icon upload; request that resource configuration from Natively support if the dashboard does not expose it. [Android notification anatomy](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications), [Firebase icon configuration](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [Natively appearance configuration](https://docs.buildnatively.com/natively-platform/appearance)

Existing per-message cards keep their old tags until dismissed. Clear those cards once before verifying the conversation cards. No APK rebuild or re-pairing is needed for the relay's card grouping. Full native conversation layouts, sender avatars, and reliable tray dismissal require additional native support.

## Android foreground system notifications

Firebase routes foreground messages to the APK's message callback instead of automatically posting a system notification. The website's `notifyAboutMessage` also returns immediately for native-push installations, keeping browser/service-worker display separate from native delivery. The published Natively Firebase JavaScript API exposes token, permission, and topic methods, but no foreground notification-display method. Changing the relay payload alone cannot enable foreground system cards. [Firebase message handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [Natively Firebase SDK](https://docs.buildnatively.com/natively-platform/features/notifications/firebase-push-notifications-advanced)

Request this native change from Natively for package `com.MUYoUwJjjMaM.natively`:

> Display Firebase notification messages as Android system notifications while the app is in the foreground. Use the received title and body, preserve `android.notification.tag`, and use the same notification ID as background Firebase display so one chat retains one card across foreground/background transitions. Preserve `data.url` as the tap destination. Also expose a documented JavaScript-to-native method to post a local Android notification with title, body, tag, and tap URL, plus a way to avoid duplicate display when the same message arrives through Firebase. This lets the website notify about live Telegram updates without relying on a separate foreground push. Create a chat notification channel with high importance if heads-up banners are required, and supply a dedicated white-on-transparent small icon. Confirm the bridge method and channel ID, and whether the channel ID must be specified in the FCM payload. Rebuild the APK after applying the change.

No Firebase service-account key or Telegram session is required for this native display handler. The relay already sends title, body, a conversation tag, and `data.url`. After Natively provides the bridge contract, the website's native foreground branch needs to call it for eligible incoming live messages while applying the existing mute, preview, hidden-chat, and active-chat rules; the JavaScript notification guard currently skips that path. Android's channel settings, user notification preferences, and Do Not Disturb determine whether a posted card also appears as a heads-up banner. An in-app JavaScript banner does not satisfy the foreground system-notification requirement.

## Container

```bash
docker build -f server/native-push/relay.Dockerfile -t native-push-relay .
```

The image runs as the `node` user and includes the shared fallback localization file. Mount persistent private storage at `/app/state`, retaining mode `0700` and ownership readable/writable by that user. Mount a private readable Firebase key at a path set by `FIREBASE_SERVICE_ACCOUNT_FILE`, or inject `FIREBASE_SERVICE_ACCOUNT_JSON` through the runtime secret manager. Set the enable flag and app URL at runtime.

Do not use ephemeral container storage for state. Losing state loses endpoint keys and pending cleanup information; app installations must pair again. Single-process file persistence is not a multi-replica database or a durable delivery queue. Public rollout needs reviewed hosting, backups, monitoring, abuse controls, and a deliberate migration plan before scaling beyond one replica.

## Verification and rollback

Run `npm run native-push:check` and the repository TypeScript check after relevant changes. Do not add test files. Manually verify confirmation delivery/taps, real Telegram ingress, previews, foreground/background/closed-app delivery, restart persistence, expired policy, invalid credentials, revocation, token rotation, and Android APK plus iPhone PWA independence.

A local exercise with simulated Firebase responses covers pairing, invalid confirmation/management secrets, separate destinations for two devices using one account, encrypted ingress, duplicate suppression, immutable token binding, privacy invalidation during authorization, hidden previews, and independent revocation. This verifies local request handling; it does not establish Telegram endpoint compatibility or actual APK delivery.

Android staging verification confirms native setup-card delivery and confirmation, Telegram registration acknowledgement, activation persistence across a relay restart, and background text-message delivery. Live `MESSAGE_TEXT` pushes use `aesgcm` and produce `pushReceived`, `previewReady`, and `acceptedByFirebase`; the user confirms the message notification appears. Both published draft-04 and RFC 8291 encryption examples decrypt successfully.

The completed research verification used website revision `3` and relay revision `8`; both ECS rollouts completed and the relay passed load-balancer health checks with the persisted registration loaded. The public website serves unread-snapshot code. Android background notification inspection confirms distinct conversation tags and titles; the user confirms that the two cards belong to different sender/chat names and only the latest preview remains. The user confirms a count appears after sending two new messages. Device inspection verifies title counts of `2` and `54`, matching Android notification numbers, with one preview line per card. The user confirms that the launcher shows a numeric badge and that reading the test chat on another device, followed by one new message, produces `(1)` on the next card. This verifies that read synchronization reaches subsequent notifications; it does not verify an exact all-chat launcher total or immediate native card removal. Foreground system notifications and exact app-wide badge/read cleanup require the native handler/bridge described above; remaining media/chat types and native icon corrections require separate verification.

Keep message text, captions, tokens, secrets, and capability URLs out of verification reports. Record classifications and outcome IDs, then confirm the visible card and tap destination on the device. Firebase acceptance is not delivery evidence.

For rollback, stop relay sending, revoke affected device records where possible, and remove the client relay URL from the next website build. Preserve state for exact-subscription cleanup. Browser PWA subscriptions remain independent. No relay deployment or device delivery is implied by the source implementation.

## References

- [Telegram push formats and type-10 registration](https://core.telegram.org/api/push-updates)
- [Legacy Web Push encryption, draft-04](https://datatracker.ietf.org/doc/html/draft-ietf-webpush-encryption-04)
- [Modern Web Push encryption, RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)
- [Firebase server authorization](https://firebase.google.com/docs/cloud-messaging/auth-server)
- [Natively Firebase bridge and notification sending](https://docs.buildnatively.com/natively-platform/features/notifications/firebase-push-notifications-advanced)
