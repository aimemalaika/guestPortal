# Build Prompt — Omada External Captive Portal + Admin Dashboard

Paste the section below into Claude Code (or your coding agent of choice) to
scaffold the project. Adjust the **Environment** values first.

---

## Environment (fill these in before starting)

| Variable | Value |
|---|---|
| Omada Controller URL | `http://192.168.1.20:8088` |
| Controller site name | `Malaika-House` |
| Portal server host | `192.168.1.20` (Legion, Docker) |
| Portal server port | `8080` |
| Guest SSID | `home-guest` |
| Omada controller version | 5.15 |
| Timezone | `Africa/Kigali` |

---

## The Prompt

> Build a self-hosted external captive portal server for a TP-Link Omada
> Controller (v5.x), plus an admin dashboard for managing guest access.
> It runs in Docker on a home network.
>
> ### Context
>
> The Omada Controller at `http://192.168.1.20:8088` manages two EAP225 access
> points on site `Malaika-House`. An open SSID `home-guest` is configured with
> Authentication Type = External Portal Server. When a guest connects, the AP
> redirects them to my server. My server must render a login page, collect
> credentials, and then call the Omada API to authorize that client's MAC
> address for internet access.
>
> ### Stack
>
> - **Backend:** Node.js + TypeScript, Express (or Fastify)
> - **Database:** SQLite via Prisma — no external DB service
> - **Frontend:** React + Vite + Tailwind, or server-rendered templates —
>   your choice, but justify it
> - **Deploy:** single `docker-compose.yaml`, one service plus a named volume
>   for the SQLite file
> - **Config:** all settings via environment variables, `.env.example` committed
>
> ### Part 1 — Omada External Portal integration
>
> Implement the Omada v5 External Portal flow:
>
> 1. **Redirect handling.** The AP redirects the client to my portal with query
>    parameters. In Omada 5.x these include `clientMac`, `apMac`, `ssidName`,
>    `radioId`, `site`, and `redirectUrl`. Capture and validate all of them.
>    Handle both the v3/v4 and v5 parameter shapes if they differ.
>
> 2. **Controller authentication.** Before authorizing clients, the portal
>    server authenticates to the controller:
>    - `POST /{controllerId}/api/v2/hotspot/login` with operator credentials,
>      or the newer `/openapi/authorize/token` flow if v5.15 requires it
>    - Store the returned token/CSRF header and reuse it; refresh on 401
>    - Determine `controllerId` at startup via `GET /api/info`
>
> 3. **Client authorization.** On successful guest login:
>    - `POST /{controllerId}/api/v2/hotspot/extPortal/auth`
>    - Body includes `clientMac`, `apMac`, `ssidName`, `radioId`, `time`
>      (duration in milliseconds), `authType`
>    - Handle the response and surface errors clearly
>
> 4. **Redirect the guest** to their original URL after authorization succeeds.
>
> Consult the official Omada External Portal API documentation — do not guess
> at endpoint shapes. If any endpoint is uncertain, say so explicitly rather
> than inventing it, and leave a clearly marked TODO.
>
> ### Part 2 — Guest login page
>
> - Mobile-first, works without JavaScript where possible
> - Configurable branding: logo upload, background image or colour, accent
>   colour, welcome heading, body text
> - Terms of service checkbox, text editable from the admin dashboard
> - Multiple auth methods, selectable per-voucher or globally:
>   - **Shared password** — one password for everyone
>   - **Voucher code** — single-use or multi-use codes
>   - **Click-through** — accept terms only, no credential
> - Clear error states: wrong password, expired voucher, quota exhausted
> - Success page with a countdown before redirect
>
> ### Part 3 — Admin dashboard
>
> Separate authenticated area at `/admin`.
>
> **Auth**
> - Local admin accounts, bcrypt-hashed passwords, session cookies
> - First-run setup wizard to create the initial admin
> - No default credentials in code or docs
>
> **Voucher management**
> - Generate batches of codes: quantity, duration, data cap, expiry, max
>   simultaneous devices
> - Printable voucher sheet (PDF or print-optimised HTML)
> - Revoke a voucher, which should also deauthorize any active sessions using it
> - Filter and search by status: unused, active, expired, revoked
>
> **Session management**
> - Live list of authorized clients: MAC, connected AP, SSID, start time,
>   remaining time, data used if the controller exposes it
> - Manually disconnect a client
> - Extend an active session
>
> **Branding editor**
> - Edit everything in Part 2 from the UI, persisted to the database
> - Live preview of the login page
>
> **Audit log**
> - Every login attempt (success and failure), voucher creation and revocation,
>   admin login, settings change
> - Filterable, exportable as CSV
>
> ### Part 4 — Non-functional requirements
>
> **Security**
> - Rate-limit login attempts per MAC and per IP
> - CSRF protection on all state-changing routes
> - Validate and sanitise every input, especially the MAC addresses from
>   redirect parameters — these come from the network and must not be trusted
> - Never log credentials or the controller token
> - Set secure headers (helmet or equivalent)
> - Session cookies: httpOnly, sameSite, secure when behind TLS
>
> **Reliability**
> - Health check endpoint at `/healthz`
> - Graceful handling when the Omada controller is unreachable — show the guest
>   a clear message rather than a stack trace
> - Structured logging (pino or similar), level configurable
> - Retry with backoff on transient controller errors
>
> **Code quality**
> - No duplicated logic — extract shared behaviour into modules
> - Typed throughout, no `any` without a comment justifying it
> - Omada API client isolated behind a single interface so it can be mocked
> - Unit tests for the auth flow, voucher lifecycle, and MAC validation
> - Integration test with a mocked controller
>
> ### Deliverables
>
> 1. `docker-compose.yaml` — runs with a single `docker compose up -d`
> 2. `.env.example` with every variable documented
> 3. `README.md` covering:
>    - What to configure in the Omada controller (exact path and field values)
>    - How to run, back up the SQLite volume, and upgrade
>    - Troubleshooting: portal not appearing, auth failing, controller
>      unreachable
> 4. Database migrations, not a hand-rolled schema
> 5. A short architecture note explaining the request flow end to end
>
> ### Constraints
>
> - Must run on Docker Desktop for Windows with WSL 2 — do not use
>   `network_mode: host`, it does not expose ports there
> - The controller and portal are on the same LAN; no internet dependency at
>   runtime
> - Keep the image small; multi-stage build
>
> Start by confirming the Omada v5.15 External Portal API contract from the
> official documentation, then propose the architecture and data model before
> writing implementation code. Ask me about anything ambiguous rather than
> assuming.

---

## Before You Start — Prerequisites in the Omada Controller

1. **Create a Hotspot Operator account**
   `Settings → Authentication → Portal → Hotspot Manager → Operator`
   The portal server authenticates to the controller with these credentials.

2. **Set the SSID to External Portal Server**
   `Settings → Authentication → Portal → Guest-Portal`
   - Authentication Type: `External Portal Server`
   - Custom Portal Server: IP `192.168.1.20`, port `8080`

3. **Note the controller ID**
   `GET http://192.168.1.20:8088/api/info` returns `omadacId` — the portal
   server needs it for every API path.

---

## Known Constraints

| Constraint | Impact |
|---|---|
| **"Controller Online Required"** | The portal only works while the Omada controller is running. Both must be up. |
| Portal server must also be always-on | Currently the Legion — a laptop. Move both to the Proxmox server when built. |
| Open SSID means unencrypted traffic | The portal controls *access*, not *privacy*. Consider WPA-Personal + portal for both. |

---

## Suggested Build Order

1. Scaffold + Docker + health check
2. Omada API client — authenticate to the controller, confirm it works
3. Redirect parameter capture — log what the AP actually sends
4. Minimal login page → authorize a real device end to end
5. Admin auth + voucher CRUD
6. Session management
7. Branding editor
8. Audit log + polish

Get step 4 working with a hardcoded password before building anything else.
That proves the integration; everything after is application code.
