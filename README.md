# Omada Guest Portal

A self-hosted external captive portal for TP-Link Omada Controller (v5.x) with an admin dashboard for managing guest WiFi access.

## Features

- **Guest Portal**: Mobile-first login page with password, voucher, or click-through authentication
- **Admin Dashboard**: Manage vouchers, view active sessions, configure branding
- **Voucher System**: Generate, print, and revoke access codes
- **Session Management**: Monitor and control active guest connections
- **Audit Logging**: Track all authentication events and admin actions
- **Docker Ready**: Single `docker compose up` deployment

## Prerequisites

### Omada Controller Configuration

1. **Create a Hotspot Operator account**
   ```
   Settings → Authentication → Portal → Hotspot Manager → Operator
   ```
   Note the username and password - the portal uses these to authenticate with the controller.

2. **Configure the SSID for External Portal**
   ```
   Settings → Authentication → Portal → Guest-Portal
   ```
   - Authentication Type: `External Portal Server`
   - Custom Portal Server: IP `<your-portal-server-ip>`, port `8080`

3. **Get the Controller ID**
   ```bash
   curl http://<controller-ip>:8088/api/info
   ```
   Returns `omadacId` - needed for API calls (the portal fetches this automatically).

## Quick Start

1. **Clone and configure**
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

2. **Required environment variables**
   ```env
   SESSION_SECRET=<generate with: openssl rand -base64 32>
   OMADA_CONTROLLER_URL=http://192.168.1.20:8088
   OMADA_SITE_NAME=Malaika-House
   OMADA_OPERATOR_USERNAME=<your-operator-username>
   OMADA_OPERATOR_PASSWORD=<your-operator-password>
   GUEST_SSID=home-guest
   ```

3. **Run with Docker**
   ```bash
   docker compose up -d
   ```

4. **First-time setup**
   - Open `http://<portal-ip>:8080/admin`
   - Create your admin account
   - Configure portal settings

## Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:migrate:dev

# Start dev server
npm run dev
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Guest Device   │────▶│   Omada AP       │────▶│ Omada Controller│
│                 │     │  (EAP225)        │     │  (192.168.1.20) │
└────────┬────────┘     └──────────────────┘     └────────▲────────┘
         │                                                │
         │ HTTP Redirect                                  │ API
         ▼                                                │
┌─────────────────────────────────────────────────────────┴─────────┐
│                     Guest Portal Server                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │  Portal UI  │  │  Admin UI   │  │ Omada Client│               │
│  │  (EJS)      │  │  (EJS)      │  │  (API)      │               │
│  └─────────────┘  └─────────────┘  └─────────────┘               │
│  ┌───────────────────────────────────────────────┐               │
│  │              Express Server                   │               │
│  │  - Session management                         │               │
│  │  - Rate limiting                              │               │
│  │  - CSRF protection                            │               │
│  └───────────────────────────────────────────────┘               │
│  ┌───────────────────────────────────────────────┐               │
│  │           SQLite (Prisma)                     │               │
│  │  - Vouchers, Sessions, Settings, Audit Log   │               │
│  └───────────────────────────────────────────────┘               │
└───────────────────────────────────────────────────────────────────┘
```

### Request Flow

1. Guest connects to `home-guest` SSID
2. AP redirects to portal: `http://portal:8080/portal?clientMac=...&apMac=...`
3. Portal displays login page with configured auth methods
4. Guest authenticates (password/voucher/click-through)
5. Portal calls Omada API to authorize the client MAC
6. Guest is redirected to their original destination

## Backup & Restore

The SQLite database is stored in a Docker volume:

```bash
# Backup
docker run --rm -v omada-portal-data:/data -v $(pwd):/backup alpine \
  cp /data/portal.db /backup/portal-backup-$(date +%Y%m%d).db

# Restore
docker run --rm -v omada-portal-data:/data -v $(pwd):/backup alpine \
  cp /backup/portal-backup.db /data/portal.db
```

## Troubleshooting

### Portal not appearing when connecting to WiFi

1. Verify the SSID is configured for External Portal Server
2. Check the portal server IP is reachable from the AP
3. Ensure port 8080 is not blocked by firewall
4. Check controller logs for redirect errors

### Authentication failing

1. Verify Hotspot Operator credentials in `.env`
2. Check portal logs: `docker compose logs -f portal`
3. Test controller connectivity: `curl http://<controller>:8088/api/info`
4. Ensure the site name matches exactly

### Controller unreachable

1. Verify controller is running and accessible
2. Check network connectivity between portal and controller
3. The portal will show a "Service Unavailable" message to guests

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/portal` | GET | Guest login page |
| `/portal/login` | POST | Process guest authentication |
| `/healthz` | GET | Basic health check |
| `/readyz` | GET | Full readiness check (DB + controller) |
| `/admin/*` | * | Admin dashboard (requires auth) |

## Security Considerations

- All passwords are bcrypt-hashed (cost factor 12)
- Session cookies are httpOnly and sameSite
- Rate limiting on login endpoints (10 attempts per 15 minutes)
- CSRF protection on all POST routes
- MAC addresses are validated and normalized
- Credentials are never logged
- Helmet.js security headers enabled

## License

MIT
