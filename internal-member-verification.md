# JustChat internal member verification — web integration plan

The **admin dashboard work is done in this repo**. JustChat web (and the iOS web2native wrap of the same app) must fetch the verified-ID list and show an orange check on internal members.

Use this file as the spec. At the bottom is a **copy-paste Cursor prompt** for `dtbgram-web`.

This is **not** access restriction (`GET /api/users/access` → Google). Verification never kicks anyone out and never wipes a session.

---

## 0. What “done” looks like

| Actor | Behavior |
|---|---|
| Admin | Connects the listing account, then **Update verified** (or waits for cron). Members of the internal Telegram group get `User.isVerified = true`. People who left become `false`. |
| JustChat web / PWA / iOS wrap | On launch and at roster hours, call the verified API. If a chat peer’s Telegram user id is in `ids`, show an orange check after their name. |
| After someone leaves the group | Next successful fetch drops their id. Orange check disappears. Session stays. |

```
Admin Update verified / cron
  → User.isVerified written
  → GET /api/users/verified { ids }
  → web cache
  → orange check on those peers
```

**Do not** set GramJS / Teact `isVerified` from this list. Telegram’s official blue check stays independent. Both marks may show.

---

## 1. Admin backend — already implemented (this repo)

You do **not** re-implement roster logic or `isVerified` writes in JustChat. The dashboard already:

- Stores `User.isVerified` (default `false`)
- Syncs the internal group (`-5038837492`) via Amplify Lambda as listing account `1115436993`
- Sets members `true` and anyone missing from the latest full roster `false`
- Exposes `GET /api/users/verified` → `{ "ids": ["…"] }` only (no names, phones, OTP)
- Shows a read-only **Verified** column and an **Update verified** button on `/users`
- Does **not** let `POST /api/users/create` or `/api/users/update` change `isVerified`

**You still need:** Amplify + Next.js **deploy** of this admin app so production has `listVerifiedUserIds` and `/api/users/verified`. Until that deploy, the route will 500.

Cron (UTC+8): **10:00, 11:00, 12:00, 13:00, 15:00, 16:00**. Clients should refresh at the same clock times (plus once on launch).

---

## 2. Integration spec for JustChat web

Web, PWA, and iOS web2native share **one codebase** (`dtbgram-web`). Implement once.

### 2.1 Config you already have

Reuse the same admin host and website key as create-user:

| Setting | Use |
|---|---|
| Admin origin | `TG_PLATFORM_API_ORIGIN` / `PLATFORM_API_ORIGIN` (same base as `POST /api/users/create`, no trailing slash) |
| API key | `TG_PLATFORM_API_KEY_WEBSITE` / `PLATFORM_API_KEY_WEBSITE` (same `x-api-key` as create) |
| Local Vite | Existing `/platform-api` proxy — same prefix as create |

Do **not** put a new secret in git. Do not call AppSync. Do not call `POST /api/users/sync-verified` (admin-only).

### 2.2 Endpoint

```
GET {ADMIN_ORIGIN}/api/users/verified
```

**Headers**

```
x-api-key: <website key already used for create>
Accept: application/json
```

No query string. This returns the **full** current verified set, not a per-user check.

**CORS:** `Access-Control-Allow-Origin: *`, methods `GET, POST, OPTIONS`. Browser `fetch` is allowed.

### 2.3 Response contract (branch on HTTP status, then JSON)

A successful empty roster is HTTP **200** `{ "ids": [] }`. That means “nobody is verified now” and **should** clear badges.

A failed check may also include `ids: []`. Treat **non-OK HTTP** as failure and **keep the last cache**.

| HTTP | JSON | Meaning | Client must |
|---|---|---|---|
| 200 | `{ "ids": ["123", "456"] }` | Current verified set | Replace cache; show orange checks for those ids |
| 200 | `{ "ids": [] }` | Nobody verified right now | Replace cache with empty; hide all orange checks |
| 401 | `{ "message": "Unauthorized" }` | Bad API key | Log; **keep last cache**; do not clear badges |
| 500 | `{ "ids": [], "message": "List failed" }` | Server/schema/deploy issue | **Keep last cache**; retry next slot |
| network / parse error | — | Offline | **Keep last cache**; do not clear badges |

**Rule:** Replace the cached set **only** when `response.ok` and `ids` is an array. Never treat 401/500/timeout as “empty roster.”

Compare ids as **strings**. GramJS peer ids in this app are already decimal strings (`buildApiPeerId`). Do not invent a new id.

### 2.4 When to call

1. **Cold start / app ready**, after existing platform-user sync starts (same area as `platformUsersApi` / `App.tsx` / `src/global/actions/api/initial.ts`).
2. **On first paint of a session**, load the **disk cache first** so badges show before the network returns.
3. **Clock slots (UTC+8):** 10:00, 11:00, 12:00, 13:00, 15:00, 16:00. Same hours as the admin Lambda. Schedule the next slot; do **not** poll every 15–30 seconds.

If there is no website API key, skip the fetch (keep cache).

### 2.5 What to draw

Orange company check **`#FE5F03`** immediately after the display name, as a **sibling** of the existing Telegram `VerifiedIcon` (same SVG shape, orange fill, white checkmark).

Surfaces that already go through `FullNameTitle` (one change covers them):

- Chat list
- Open-chat header
- Profile title
- Group member list / in-group sender name
- Search / pickers that use `FullNameTitle`

Flag: `isEmployeeVerified(peer.id)` from the cached set.

| Case | UI |
|---|---|
| Id in cached `ids` | Orange check |
| Same display name, id **not** in `ids` | No orange check |
| Telegram `isVerified` **and** employee | Blue check **and** orange check |
| `noVerified` on `FullNameTitle` | Hide both official and employee marks (same as today) |
| `CustomPeer` with no real Telegram user id | No orange check |

### 2.6 Forbidden

- Setting GramJS / Teact `user.isVerified` from this list
- Overwriting or hiding Telegram’s official blue check
- Calling AppSync or `POST /api/users/sync-verified`
- Redirecting to Google, logging out, or wiping session because someone is unverified
- Name-match warnings or chat blocks
- A second native iOS implementation (iOS is this web app)

### 2.7 Suggested TypeScript (web)

Add fetch next to the existing helper in `src/util/platformUsersApi.ts`. Keep parse/cache in a small `src/util/employeeVerified.ts` so you do not create an import cycle.

```ts
// employeeVerified.ts
const STORAGE_KEY = 'dtbgram_employee_verified_ids';

let cached = new Set<string>();

export function parseVerifiedIds(json: unknown): string[] {
  if (!json || typeof json !== 'object' || !('ids' in json)) return [];
  const ids = (json as { ids: unknown }).ids;
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id).trim()).filter(Boolean);
}

export function saveCachedIds(ids: string[]) {
  cached = new Set(ids);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore quota
  }
}

export function loadCachedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const ids = parseVerifiedIds({ ids: JSON.parse(raw) });
      cached = new Set(ids);
      return ids;
    }
  } catch {
    // keep memory
  }
  return [...cached];
}

export function replaceVerifiedIds(ids: string[]) {
  saveCachedIds(ids);
}

export function isEmployeeVerified(peerId?: string): boolean {
  if (!peerId) return false;
  return cached.has(peerId);
}
```

```ts
// platformUsersApi.ts — same PLATFORM_API_PREFIX + x-api-key as create
export async function fetchVerifiedUserIds(): Promise<string[] | undefined> {
  if (!PLATFORM_API_KEY_WEBSITE) return undefined;
  const url = `${PLATFORM_API_PREFIX}/api/users/verified`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!response.ok) return undefined;
    return parseVerifiedIds(await response.json());
  } catch {
    return undefined;
  }
}
```

```ts
export async function refreshEmployeeVerified() {
  loadCachedIds();
  const ids = await fetchVerifiedUserIds();
  if (ids) replaceVerifiedIds(ids); // undefined = failure → keep cache
}
```

Wire-up:

```ts
loadCachedIds();
void refreshEmployeeVerified();

// Schedule the next 10/11/12/13/15/16 Asia/Singapore (UTC+8) slot.
// On that tick: refreshEmployeeVerified(), then schedule the following slot.
```

`FullNameTitle` (after the official `VerifiedIcon`):

```tsx
{!noVerified && peer && 'id' in peer && isEmployeeVerified(peer.id) && <EmployeeVerifiedIcon />}
```

Copy `VerifiedIcon` → `EmployeeVerifiedIcon` and set `--color-fill: #FE5F03`.

### 2.8 Limits

- **Old builds** that never fetch show no orange check. Do not “fix” that by writing Telegram `verifyUser`.
- Badge freshness is the next roster hour (or launch), not seconds.
- If admin is not deployed, GET 500 → last cache (or no badges on a first install).
- This list is every verified id. Cache it; do not fetch per chat open.

---

## 3. QA (web after the client change)

Prereq: admin Amplify + Next.js deployed; at least one real internal member with `isVerified: true` (Update verified or cron).

1. Launch web logged in. Network: `GET /api/users/verified` with the website `x-api-key`. Chat list / header / profile for a verified peer shows the **orange** check.
2. Another account with the **same display name** but id **not** in `ids` has **no** orange check.
3. A Telegram-official-verified employee shows **blue + orange**.
4. Airplane mode / 500: last orange checks stay. Do not flash-empty.
5. After Admin **Update verified** removes someone, wait until the next launch or UTC+8 slot — orange check gone.
6. Confirm the iOS web2native build picks up the same UI (no extra iOS code).
7. Confirm unverified users are **not** redirected and sessions are **not** wiped.

---

## 4. Cursor prompt (paste into `dtbgram-web`)

Paste as a **single user message** in Cursor Agent in `dtbgram-web`. Do **not** paste secrets. Reuse `TG_PLATFORM_API_ORIGIN` and `TG_PLATFORM_API_KEY_WEBSITE`.

```
Implement JustChat internal-member verification against the admin dashboard API. Admin work is already live; this repo only needs to fetch the verified-ID list and draw an orange check. This is not access restriction. Do not redirect to Google. Do not wipe Telegram sessions. Do not set GramJS/Teact isVerified from this list.

## Goal
Members of the internal Telegram group are marked User.isVerified on the admin side. Show an orange company check (#FE5F03) after those peers' display names. Telegram's official blue VerifiedIcon stays independent; both may show. Covers web, PWA, and iOS web2native (same codebase). No native iOS work.

## API (do not call AppSync)
GET {ADMIN_ORIGIN}/api/users/verified
Header: x-api-key: <the SAME website key this app already sends to POST /api/users/create>
Reuse PLATFORM_API_PREFIX / PLATFORM_API_KEY_WEBSITE from src/util/platformUsersApi.ts and src/config.ts (TG_PLATFORM_API_ORIGIN, TG_PLATFORM_API_KEY_WEBSITE). Do not hardcode secrets. Do not call POST /api/users/sync-verified.

Responses:
- HTTP 200 { "ids": string[] } → replace the cached set (empty array is valid and must clear orange checks)
- HTTP 401 / 500 / network / invalid JSON → keep the last cache; do not treat as empty roster
Replace cache ONLY when response.ok and body.ids is an array.

## Implementation notes
1. Create src/util/employeeVerified.ts + src/util/employeeVerified.test.ts:
   - parseVerifiedIds(json) → string[] (coerce numbers to strings; junk → [])
   - loadCachedIds / saveCachedIds / replaceVerifiedIds using localStorage key dtbgram_employee_verified_ids
   - isEmployeeVerified(peerId?: string)
   - Call loadCachedIds() on first import / app ready so badges render before the network returns
2. Add fetchVerifiedUserIds() in src/util/platformUsersApi.ts (same GET prefix + x-api-key as create). Return string[] | undefined (undefined = failure).
3. refreshEmployeeVerified(): load cache, fetch, replace only on success.
4. Run refresh on app ready (same place company OTP / platform user sync starts: src/components/App.tsx or src/global/actions/api/initial.ts). Then schedule the next refresh at 10:00, 11:00, 12:00, 13:00, 15:00, 16:00 Asia/Singapore (UTC+8). Do not poll every 15–30s.
5. Copy src/components/common/VerifiedIcon.tsx + VerifiedIcon.scss to EmployeeVerifiedIcon with --color-fill: #FE5F03 (keep white checkmark).
6. In src/components/common/FullNameTitle.tsx, after the official VerifiedIcon:
   {!noVerified && peer && 'id' in peer && isEmployeeVerified(peer.id) && <EmployeeVerifiedIcon />}
   Skip CustomPeer with no real Telegram user id. Do not patch GramJS user.isVerified.
7. Match existing Teact/code style. Add Vitest for parseVerifiedIds. Run npx vitest run src/util/employeeVerified.test.ts and npm run check:ts.

## Do not
- Touch access-restriction / Google redirect
- Call AppSync or admin sync-verified
- Add admin UI
- Add a separate iOS project change

## Verify
1. ID in the list → orange check on chat list, open-chat header, profile (FullNameTitle).
2. Same display name, ID not in the list → no orange check.
3. Telegram-verified + employee → blue and orange.
4. GET fails → last cached orange checks remain.
```

---

## 5. Suggested work order

1. Deploy this admin repo (Amplify schema + Next.js) so `/api/users/verified` works where web already points.
2. Run the prompt in `dtbgram-web`.
3. QA §3 on web (and the iOS wrap of the same build).

Desktop and Android have the same GET contract if you want the badge there later. This file is the **web** handoff only.

---

## 6. Admin file map (reference only)

| Path | Role |
|---|---|
| `amplify/data/resource.ts` | `User.isVerified`; `listVerifiedUserIds` query |
| `amplify/functions/list-group-members/` | Roster pull; writes `isVerified` |
| `amplify/functions/list-verified-ids/` | Returns verified telegram user ids |
| `src/app/api/users/verified/route.ts` | GET client API |
| `src/app/api/users/sync-verified/route.ts` | Admin-only Update verified |
| `src/app/(admin)/users/page.tsx` | Update verified button |
| `src/components/UsersTable.tsx` | Read-only Verified column |

Admin does not draw the orange check. After deploy, only the web prompt above finishes the product behavior on web / PWA / iOS.
