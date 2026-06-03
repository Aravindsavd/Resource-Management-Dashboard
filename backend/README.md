# CloudOps — Azure Unused Resource Dashboard

A full-stack web application that scans your Azure subscriptions for unused and unattached resources, calculates estimated monthly waste, and displays everything in a live dashboard with charts and filters.

Built with **Node.js + Express** (backend) and **plain HTML/CSS/JS** (frontend). No build step required.

---

## What It Does

Scans all subscriptions your Azure account has access to and flags:

| Resource Type | Condition |
|---|---|
| Virtual Machines | Stopped or deallocated |
| Managed Disks | Unattached (no VM) |
| Public IP Addresses | Not attached to any NIC or NAT Gateway |
| Network Interfaces (NICs) | No VM attached |
| Network Security Groups (NSGs) | No subnet or NIC association |
| Load Balancers | Empty backend pool |
| AKS Clusters | Power state = Stopped |
| App Services / Function Apps | State = Stopped |
| Container Apps | Latest revision stopped or degraded |

---

## Dashboard

The dashboard shows 6 live charts in a 3×3 grid:

- **Waste by Subscription** — donut showing monthly cost per subscription
- **Breakdown by Resource Type** — all 9 types with cost or item count
- **Resources by Subscription** — bar chart of resource counts per subscription
- **Waste Trend** — line chart of total monthly waste across scans
- **Resource Count by Type** — bar chart of current scan counts
- **Resource Count Trend** — line chart of total unused resources over time

Each resource page (Stopped VMs, Unattached Disks, etc.) shows **dynamic stat cards** relevant to that resource type, plus **subscription and location filters**.

---

## Stack

```
Frontend   →  HTML + CSS + Vanilla JS + Chart.js
Backend    →  Node.js + Express
Azure      →  Az PowerShell module (called by backend)
Data       →  cache.json (30-min TTL) + history.json (90-day scan history)
```

---

## Project Structure

```
cloudops/
├── backend/
│   ├── server.js          ← Express API + PowerShell Azure scanner
│   ├── package.json
│   ├── cache.json         ← auto-created after first scan
│   └── history.json       ← scan history for trend charts
└── frontend/
    └── index.html         ← full dashboard UI (single file)
```

---

## Prerequisites

### 1. Node.js
Download from https://nodejs.org (v18+)

### 2. PowerShell 7 (pwsh)
```powershell
winget install Microsoft.PowerShell
```

### 3. Az PowerShell Module
```powershell
Install-Module Az -Scope CurrentUser -Force -AllowClobber
```

> **OneDrive conflict:** If your Documents folder is on OneDrive, pause syncing before installing modules, or install to a local path:
> ```powershell
> Install-Module Az -Scope CurrentUser -Force -AllowClobber -InstallLocation "C:\PSModules"
> $p = [Environment]::GetEnvironmentVariable("PSModulePath","User")
> [Environment]::SetEnvironmentVariable("PSModulePath","C:\PSModules;$p","User")
> ```

---

## Setup

```bash
# Install Node dependencies
cd cloudops/backend
npm install
```

---

## Running

```powershell
# 1. Log in to Azure
Connect-AzAccount

# 2. Start the server
cd cloudops/backend
node server.js
```

Open your browser at:
```
http://localhost:3000
```

Click **Run Scan Now** on the dashboard — the first scan takes **~1 minute** across 3 subscriptions (runs in parallel).

---

## How It Works

```
Browser (index.html)
    │
    │  GET /api/scan
    ▼
Express (server.js)
    │
    │  Writes PS script to C:\Temp, executes via pwsh
    ▼
PowerShell → Az module → Azure APIs
    │
    │  Writes JSON to C:\Temp\cloudops_out.json
    ▼
Node reads file → caches → serves to browser
```

All subscriptions are scanned **in parallel** using separate PowerShell contexts.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/scan` | Full scan (uses cache if fresh) |
| `GET /api/scan?force=true` | Force fresh scan, bypass cache |
| `GET /api/status` | Cache status and PS info |
| `GET /api/summary` | Stat totals for current scan |
| `GET /api/history` | Scan history for trend charts |
| `GET /api/resources/:type` | Filtered resource list |
| `GET /api/debug` | PS version, Az module, login context |
| `GET /api/containerapps-debug` | Container Apps API debug |

**Resource types:** `stoppedVMs`, `unattachedDisks`, `unattachedPIPs`, `unattachedNICs`, `unusedNSGs`, `emptyLBs`, `stoppedAKS`, `stoppedAppSvc`, `stoppedContainerApps`

**Query filters on resource endpoints:**
```
?subscription=Aptean-Common-Tech
?location=eastus
?resourceGroup=rg-dev
```

---

## VS Code Setup

### Run with one click — add to `.vscode/tasks.json`:
```json
{
  "version": "2.0.0",
  "tasks": [{
    "label": "Start CloudOps",
    "type": "shell",
    "command": "node server.js",
    "options": { "cwd": "${workspaceFolder}/backend" },
    "presentation": { "reveal": "always", "panel": "new" }
  }]
}
```

### Suppress PSScriptAnalyzer warnings — `.vscode/settings.json`:
```json
{
  "powershell.scriptAnalysis.settingsPath": ".vscode/PSScriptAnalyzerSettings.psd1"
}
```

`.vscode/PSScriptAnalyzerSettings.psd1`:
```powershell
@{
  Rules = @{
    PSUseDeclaredVarsMoreThanAssignments = @{ Enable = $false }
  }
}
```

---

## Cost Estimates

Estimates are approximate based on East US pricing.

| Resource | Rate |
|---|---|
| Public IP — Standard Static | ~$3.65/mo |
| Public IP — Basic Static | ~$1.46/mo |
| Managed Disk — Standard LRS | ~$0.04/GB/mo |
| Managed Disk — Premium SSD | ~$0.135/GB/mo |
| Load Balancer — Standard | ~$18/mo |
| AKS Cluster (stopped) | ~$150/mo (node VMs still billed) |
| App Service (stopped) | ~$50/mo (plan still billed) |

---

## Required Azure Permissions

**Reader** role at subscription scope is sufficient to scan.

To create a read-only service principal for automated scans:
```powershell
az ad sp create-for-rbac `
  --name "cloudops-scanner" `
  --role Reader `
  --scopes /subscriptions/<subscription-id>
```

---

## Caching & History

- **Cache TTL:** 30 minutes — reload the page without re-scanning
- **Force refresh:** click *Run Scan Now* or open `http://localhost:3000/api/scan?force=true`
- **History:** every scan appends to `history.json` (last 90 days) — powers the trend line charts on the dashboard

---

## Known Limitations

- **Container Apps** — the `Stopped` status from the Azure portal maps to the revision `runningState` field, which requires an individual API call per app. Detection may miss some edge cases depending on API version.
- **Still Billed VMs** — only OS-level stopped VMs (not deallocated) are flagged; deallocated VMs do not incur compute charges but their disks still bill.
- **Cost estimates** — all figures are approximations. Actual costs depend on region, SKU tier, and reservation discounts.
- **Permissions** — resource groups the account cannot read are silently skipped.

---

## Troubleshooting

**`Connection failed` on dashboard**
```powershell
node server.js   # make sure backend is running
```

**Az module version conflicts**
```powershell
# Check what's loaded
Get-InstalledModule Az -AllVersions | Select-Object Version
# Remove old versions
Get-InstalledModule Az -AllVersions | Where-Object { [version]$_.Version -lt [version]"11.0.0" } | Uninstall-Module -Force
```

**Scan takes too long**
The script runs all subscriptions in parallel. If a subscription times out, check access with:
```powershell
Get-AzContext
Set-AzContext -SubscriptionId <id>
Get-AzVM -Status -ErrorAction Stop
```
