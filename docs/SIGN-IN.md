# Signing in with a name and a password

How a member gets into the office from a browser with a name and a password, who gives passwords, what ends a session, and what slows a guesser down. Read this before touching `apps/server/src/logins.ts`, the `/login` route, or the sign-in at the door (`useSignIn` in `apps/desktop/src/Knock.tsx`, drawn by `apps/desktop/src/entrance/Door.tsx`; the page around it is `ENTRANCE-PAGE.md`).

_Built on 2026-11-11 on the owner's request: "let me log in at office.sparkcan.com as owner too, say with a username and a password". Why it is built this way: `DECISIONS.md`, "Signing in with a name and a password". What protects what: `SECURITY.md`, the section of the same name._

## The idea in one paragraph

A password belongs to a **member** (`guests.ts`) — there are no separate accounts. The name is the member's name, the role is the member's role. Signing in proves who is asking and gives back a credential of that member that is valid for 30 days: the same kind of thing an invitation gives, made another way. An owner who signs in is a member whose role is owner; the office's own owner token is never accepted from the network, and this feature did not change that.

## Using it

| Who | Where | What |
| --- | --- | --- |
| An owner | **Access → the member's row → Password…** | gives a member a password, or a new one, or takes it away |
| Whoever has a shell on the server | `printf '%s' 'the password' \| office-admin password "Name"` (`--remove` takes it away) | the same; the password is read from standard input, never an argument (`OPERATIONS.md`) |
| A member | `https://<the office's address>` → the door → **Member** | name (any spelling of capitals) and password; the browser stays signed in for 30 days |
| A member, once in | **Settings → Sign-in** | sets a first password or changes it (knowing the current one); **Sign out** in a browser that was signed in this way |

A password has 8 to 200 characters and is not the member's name. There is no "forgot my password": an owner sets a new one.

## What happens at the door

```
browser ── POST /login {username, password} ──▶ door (4610, TLS) ──▶ office
                                                   │  sets x-forwarded-for itself (the peer, or what a proxy on the same machine reports)
                                                   ▼
        Logins.signIn → check:  too many attempts by everybody?  → 429
                                 this address tried too often?    → 429
                                 this name closed?                → 429
                                 scrypt(password, salt) off the main thread, whether or not the name exists
                                 wrong → counted (name, address), audit `login.failed`, 401 with the one common text
                                 right → a credential of the member: label "login<TAB>name", 30 days → {token, name, role, …}
```

- **Stored:** per member a random salt and a scrypt hash (N 16384, r 8, p 1; NFKC first) in the office's store under `logins` — apart from the member records, which are sent to windows. Nothing else. The Access list carries only `hasPassword`.
- **A session is a credential** like any other of the member, told apart by its label (`login` + a tab — a member's name cannot contain a tab). That is how *Sign out* and a new password end browser sessions without touching the desktop app's own credential.
- **Limits** (`LOGIN_LIMITS`): 5 wrong passwords in a row close a name for 15 minutes, then 30, … up to a day, with a security notification to the owners; 20 wrong attempts in 10 minutes close an address; 120 attempts a minute from everybody together, and 8 checks computed at once. All in memory — a restart of the office clears them.
- **What ends a session:** *Sign out* (that one), a changed or removed password (all made with it), a new invitation for the member (which also **takes the password away** — a new invitation is how an owner takes back everything a member came in with), removing the member, and the 30 days running out. Ending a session closes the live connections opened with it (`ClientHub.dropLogins`); the page falls back to the sign-in form.

## Where things are

| | |
| --- | --- |
| Hashing, limits, sessions | `apps/server/src/logins.ts` — `Logins` (`set`, `clear`, `signIn`, `check`, `signOut`, `isSession`, `onEnded`, `keyOf`), `LOGIN_LIMITS`, `SESSION_DAYS` |
| Routes | `apps/server/src/server.ts` — `POST /login` (public, at the door), `POST`/`DELETE /api/guests/:id/password` (owners), `POST /api/me/password`, `POST /api/logout`, `GET /api/me` (`hasPassword`, `passwordSession`); rules for the last three in `access.ts`; `/login` in the door's `ALLOWED` |
| Ending sessions of a member by label | `revokeCredentialsWhere` in `packages/database/src/index.ts` and `postgres.ts` |
| Closing open windows | `ClientHub.dropLogins` and the `loginKey` of a connection in `apps/server/src/hubs.ts` |
| The form | what it does: `useSignIn` in `apps/desktop/src/Knock.tsx` (the request; the name is remembered in `localStorage` as `orch.login-name`, the session token as `orch.token`). How it looks: the **Member** side of the door, `apps/desktop/src/entrance/Door.tsx`, on the entrance page (`ENTRANCE-PAGE.md`) |
| One's own password, Sign out | `AccountSection` in `apps/desktop/src/hud/panels/settings.tsx`; `forgetToken` in `lib/api.ts` |
| An owner's button | the member row in `apps/desktop/src/hud/panels/people.tsx` |
| The server's shell | `password` in `scripts/office-admin.mjs` |

## Testing it

- `apps/server/test/logins.test.ts` — the module on a stand-in store with its own clock: hashes, the one answer for every refusal, the lock of a name and its doubling, the address limit, the flood limits, a password changed mid-check, which sessions end when.
- `tests/e2e/36-password-sign-in.test.ts` — a real office with its door open: who the session is and what it may do per role, who may set whose password, changing one's own, sign-out, open windows closed when a session ends, the locks, a restart, nothing but hashes on disk or in the audit log, the root token still refused from outside, a phone still turned away.
- `tests/ui/entrance.mjs` — the form itself in a browser window at the door of a made-up office: a wrong password refused where it was typed, the right one in as that member, the name and the session kept.
- By hand: `node scripts/entrance-office.ts` (a made-up office with its door open and two members with passwords; it prints the address and the passwords) and a browser window: the door's page, a wrong password, in, Settings → Sign-in, Sign out.

## Limits, plainly

- **No second factor.** For an owner the password is as strong a key as their invitation was.
- **A name can be kept closed by somebody who knows it** and guesses wrongly on purpose. The member's desktop app and invitation are not affected; an owner setting a new password opens the name at once.
- **Locks do not survive a restart** of the office (every deploy).
- **The session token is kept by the browser** (`localStorage`) for 30 days; anybody with that browser profile is that member until *Sign out*.
- The desktop app does not sign in with a password; it keeps coming in with its invitation.

## Not verified

- A password manager's behaviour on the form.
- What a person sees when a session runs out while the page is open (the page shows the entry page for any refused credential; not watched for this case).
- The office under a real flood of attempts.
