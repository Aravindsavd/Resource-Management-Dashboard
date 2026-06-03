# CloudOps — Azure Resource Audit Dashboard

Full-stack web app that fetches live Azure resource data and displays it in a dashboard. No external cloud services — runs entirely on your machine.

---

## Stack

```
Frontend  →  Plain HTML + CSS + JS         (index.html, no build step)
Backend   →  Node.js + Express             (server.js)
Azure     →  Az PowerShell module          (called by the backend)
```

---

## Folder Structure

```
cloudops/
├── backend/
│   ├── server.js          ← Express API + Azure PowerShell runner
│   ├── package.json
│   └── cache.json         ← auto-created after first scan (5 min TTL)
└── frontend/
    └── index.html         ← Full dashboard UI
```

---

## Setup

### 1. Install Node dependencies

```bash
cd backend
npm install
```

### 2. Install Az PowerShell module (once)

```powershell
Install-Module Az -Scope CurrentUser -Force
```

### 3. Log in to Azure

```powershell
Connect-AzAccount
```

---

## Running

```bash
cd backend
node server.js
```

Then open your browser at:

```
http://localhost:3000
```

The dashboard loads and immediately triggers a scan. Results appear as they come in from Azure.

---

## How It Works

```
Browser (index.html)
     │
     │  GET /api/scan
     ▼
Express (server.js)
     │
     │  Runs PowerShell: Az module queries Azure
     ▼
Azure APIs
  ├── Get-AzVM -Status          → stopped / deallocated VMs
  ├── Get-AzDisk                → unattached managed disks
  ├── Get-AzPublicIpAddress     → unattached public IPs
  ├── Get-AzNetworkInterface    → NICs with no VM
  ├── Get-AzNetworkSecurityGroup→ unused NSGs
  └── Get-AzLoadBalancer        → empty load balancers
     │
     │  Returns JSON
     ▼
Dashboard renders tables, stat cards, charts
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/status` | Health check + cache status |
| GET | `/api/scan` | Full scan (cached for 5 min) |
| GET | `/api/scan?force=true` | Force fresh scan, bypass cache |
| GET | `/api/summary` | Stat card numbers only |
| GET | `/api/resources/stoppedVMs` | Stopped/deallocated VMs |
| GET | `/api/resources/unattachedDisks` | Unattached managed disks |
| GET | `/api/resources/unattachedPIPs` | Unattached public IPs |
| GET | `/api/resources/unattachedNICs` | Unattached NICs |
| GET | `/api/resources/unusedNSGs` | Unused NSGs |
| GET | `/api/resources/emptyLBs` | Empty load balancers |

All resource endpoints support optional query filters:
```
?subscription=a-dev-001
?resourceGroup=rg-eastus-dev
?location=eastus
```

---

## Dashboard Features

- Live data from your real Azure subscriptions
- All/Deallocated/Still Billed filter tabs on VM view
- Search by name, resource group, subscription, or location
- Click Details on any row for full resource info + tags
- Export CSV for any filtered view
- 5-minute cache — refreshes automatically on next scan
- Sidebar navigation between all resource types
- Stat cards: total stopped VMs, still billed, monthly waste, total unused

---

## Caching

The backend caches scan results in `cache.json` for 5 minutes. This means:
- Opening the dashboard shows results instantly if a recent scan exists
- Use "Run Scan Now" or `/api/scan?force=true` to force a fresh scan
- Change `CACHE_TTL_MS` in `server.js` to adjust the cache duration

---

## Required Azure Permissions

The logged-in account needs at least **Reader** role at subscription scope to scan all resources.

---

## Notes

- **First scan takes 1–3 minutes** depending on how many subscriptions and resources you have
- The backend runs PowerShell via `pwsh` — make sure PowerShell 7+ is installed
- CORS is enabled so the frontend can call the API from any origin during development
