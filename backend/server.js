const express    = require('express');
const { exec, execSync } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');

const app          = express();
const PORT         = 3000;
const CACHE_FILE   = path.join(__dirname, 'cache.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const CACHE_TTL_MS = 30 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── PowerShell detection ──────────────────────────────────────────────────────
function detectPS() {
  try { execSync('pwsh -NoProfile -Command "exit"', { timeout: 5000 }); return 'pwsh'; } catch {}
  try { execSync('powershell -NoProfile -Command "exit"', { timeout: 5000 }); return 'powershell'; } catch {}
  throw new Error('No PowerShell found.');
}
const PS_EXE = detectPS();
console.log(`  Using PowerShell: ${PS_EXE}`);
try { execSync('cmd /c if not exist C:\\Temp mkdir C:\\Temp'); } catch {}

// ── Run PS script via temp file ───────────────────────────────────────────────
function runPS(script) {
  return new Promise((resolve, reject) => {
    const tmpScript = `C:\\Temp\\cloudops_script_${Date.now()}.ps1`;
    const tmpOutput = `C:\\Temp\\cloudops_out_${Date.now()}.json`;
    const wrapped   = script + `\n$result | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path '${tmpOutput}' -Encoding UTF8`;
    fs.writeFileSync(tmpScript, wrapped, 'utf8');
    const cmd = `${PS_EXE} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`;
    exec(cmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      try {
        if (fs.existsSync(tmpOutput)) {
          const raw = fs.readFileSync(tmpOutput, 'utf8').trim();
          try { fs.unlinkSync(tmpOutput); } catch {}
          if (!raw) return reject('Empty output. STDERR: ' + (stderr||'').slice(0,300));
          try { return resolve(JSON.parse(raw)); }
          catch(e) { return reject('JSON parse failed: ' + e.message + '\n' + raw.slice(0,300)); }
        }
      } catch {}
      if (err && !stdout) return reject((stderr || err.message).slice(0,500));
      const out = stdout.trim();
      if (!out) return reject('Empty stdout. STDERR: ' + (stderr||'none').slice(0,300));
      try { resolve(JSON.parse(out)); }
      catch { reject('stdout parse failed:\n' + out.slice(0,500)); }
    });
  });
}

// ── Azure scan script (single process, all subscriptions) ─────────────────────
const AZURE_SCRIPT = `
$ErrorActionPreference = 'Continue'
Import-Module Az.Accounts -ErrorAction Stop | Out-Null
Import-Module Az.Compute  -ErrorAction Stop | Out-Null
Import-Module Az.Network  -ErrorAction Stop | Out-Null

$result = @{
  subscriptions = [System.Collections.ArrayList]@()
  resources = @{
    stoppedVMs      = [System.Collections.ArrayList]@()
    unattachedDisks = [System.Collections.ArrayList]@()
    unattachedPIPs  = [System.Collections.ArrayList]@()
    unattachedNICs  = [System.Collections.ArrayList]@()
    unusedNSGs      = [System.Collections.ArrayList]@()
    emptyLBs        = [System.Collections.ArrayList]@()
    stoppedAKS      = [System.Collections.ArrayList]@()
    stoppedAppSvc   = [System.Collections.ArrayList]@()
    stoppedContainerApps = [System.Collections.ArrayList]@()
  }
  summary = @{}
}

$subs = Get-AzSubscription -ErrorAction Stop
foreach ($sub in $subs) { $null = $result.subscriptions.Add(@{ id=$sub.Id; name=$sub.Name }) }

foreach ($sub in $subs) {
  $subName = $sub.Name; $subId = $sub.Id
  Write-Host "Scanning: $subName"
  $null = Set-AzContext -SubscriptionId $subId -ErrorAction Stop

  # VMs — use PowerState property (works in all Az versions)
  try {
    $vms = @(Get-AzVM -Status -ErrorAction SilentlyContinue)
    Write-Host "  VMs: $($vms.Count)"
    foreach ($vm in $vms) {
      # Try PowerState property first (Az 11+), fall back to Statuses array
      $ps = $null
      if ($vm.PowerState) {
        $ps = $vm.PowerState
      } else {
        $psObj = $vm.Statuses | Where-Object { $_.Code -like 'PowerState/*' }
        $ps = if ($psObj) { $psObj.DisplayStatus } else { 'Unknown' }
      }
      Write-Host "  VM: $($vm.Name) — $ps"
      if ($ps -match 'deallocated|stopped|Stopped|Deallocated') {
        Write-Host "  STOPPED: $($vm.Name) [$ps]"
        $sz = $vm.HardwareProfile.VmSize
        $cost = switch -Wildcard ($sz) {
          '*_B1*'{8} '*_B2*'{15} '*_B4*'{30} '*_B8*'{60}
          '*_D2s*'{70} '*_D4s*'{140} '*_D8s*'{280}
          '*_D2as*'{70} '*_D4as*'{140} '*_D2ads*'{75} '*_D4ads*'{150}
          '*DS1*'{55} '*DS2*'{110} '*DS3*'{220}
          '*_E2*'{100} '*_E4*'{200} '*_F4*'{120} '*_FX4*'{180}
          default{50}
        }
        $null = $result.resources.stoppedVMs.Add(@{
          subscription=$subName; subscriptionId=$subId
          name=$vm.Name; resourceGroup=$vm.ResourceGroupName
          location=$vm.Location; size=$sz; powerState=$ps
          stillBilled=[bool]($ps -match 'stopped' -and $ps -notmatch 'deallocated')
          diskCost=$cost; estMonthlyCost=$cost
          tags=if($vm.Tags -and $vm.Tags.Count){$vm.Tags}else{@{}}
        })
      }
    }
  } catch { Write-Host "  VM ERROR: $($_.Exception.Message)" }

  # Disks
  try {
    foreach ($d in @(Get-AzDisk -ErrorAction SilentlyContinue) | Where-Object { $_ -and $_.DiskState -eq 'Unattached' }) {
      $rate = if ($d.Sku.Name -like '*Premium*') { 0.135 } else { 0.04 }
      $null = $result.resources.unattachedDisks.Add(@{
        subscription=$subName; subscriptionId=$subId
        name=$d.Name; resourceGroup=$d.ResourceGroupName
        location=$d.Location; sizeGB=$d.DiskSizeGB; sku=$d.Sku.Name
        estMonthlyCost=[math]::Round($d.DiskSizeGB*$rate,2)
        tags=if($d.Tags -and $d.Tags.Count){$d.Tags}else{@{}}
      })
    }
  } catch { Write-Host "  Disk ERROR: $($_.Exception.Message)" }

  # PIPs
  try {
    foreach ($p in @(Get-AzPublicIpAddress -ErrorAction SilentlyContinue) | Where-Object { $_ }) {
      if ((-not $p.IpConfiguration) -and (-not $p.NatGateway)) {
        $null = $result.resources.unattachedPIPs.Add(@{
          subscription=$subName; subscriptionId=$subId
          name=$p.Name; resourceGroup=$p.ResourceGroupName
          location=$p.Location; sku=if($p.Sku.Name){$p.Sku.Name}else{'Basic'}
          estMonthlyCost=if($p.Sku.Name -eq 'Standard'){3.65}else{1.46}
          tags=if($p.Tags -and $p.Tags.Count){$p.Tags}else{@{}}
        })
      }
    }
  } catch { Write-Host "  PIP ERROR: $($_.Exception.Message)" }

  # NICs
  try {
    foreach ($n in @(Get-AzNetworkInterface -ErrorAction SilentlyContinue) | Where-Object { $_ -and (-not $_.VirtualMachine) }) {
      $null = $result.resources.unattachedNICs.Add(@{
        subscription=$subName; subscriptionId=$subId
        name=$n.Name; resourceGroup=$n.ResourceGroupName
        location=$n.Location; estMonthlyCost=0
        tags=if($n.Tags -and $n.Tags.Count){$n.Tags}else{@{}}
      })
    }
  } catch { Write-Host "  NIC ERROR: $($_.Exception.Message)" }

  # NSGs
  try {
    foreach ($g in @(Get-AzNetworkSecurityGroup -ErrorAction SilentlyContinue) | Where-Object { $_ }) {
      $sc = if($g.Subnets){@($g.Subnets).Count}else{0}
      $nc = if($g.NetworkInterfaces){@($g.NetworkInterfaces).Count}else{0}
      if ($sc -eq 0 -and $nc -eq 0) {
        $null = $result.resources.unusedNSGs.Add(@{
          subscription=$subName; subscriptionId=$subId
          name=$g.Name; resourceGroup=$g.ResourceGroupName
          location=$g.Location; estMonthlyCost=0
          tags=if($g.Tags -and $g.Tags.Count){$g.Tags}else{@{}}
        })
      }
    }
  } catch { Write-Host "  NSG ERROR: $($_.Exception.Message)" }

  # Load Balancers
  try {
    foreach ($lb in @(Get-AzLoadBalancer -ErrorAction SilentlyContinue) | Where-Object { $_ }) {
      $bc = 0
      if ($lb.BackendAddressPools) {
        foreach ($pool in $lb.BackendAddressPools) {
          $bc += if($pool.BackendIpConfigurations){@($pool.BackendIpConfigurations).Count}else{0}
        }
      }
      if ($bc -eq 0) {
        $null = $result.resources.emptyLBs.Add(@{
          subscription=$subName; subscriptionId=$subId
          name=$lb.Name; resourceGroup=$lb.ResourceGroupName
          location=$lb.Location; sku=if($lb.Sku){$lb.Sku.Name}else{'Basic'}
          estMonthlyCost=if($lb.Sku -and $lb.Sku.Name -eq 'Standard'){18}else{0}
          tags=if($lb.Tags -and $lb.Tags.Count){$lb.Tags}else{@{}}
        })
      }
    }
  } catch { Write-Host "  LB ERROR: $($_.Exception.Message)" }

  # AKS Clusters — use Az.Aks module or Az REST API
  try {
    # Try Az.Aks module first
    $aksModule = Get-Module Az.Aks -ListAvailable -ErrorAction SilentlyContinue
    if ($aksModule) {
      Import-Module Az.Aks -ErrorAction SilentlyContinue | Out-Null
      $clusters = Get-AzAksCluster -ErrorAction SilentlyContinue
    } else {
      # Fallback: use Az REST API
      $token = (Get-AzAccessToken).Token
      $uri = "https://management.azure.com/subscriptions/$subId/providers/Microsoft.ContainerService/managedClusters?api-version=2023-01-01"
      $response = Invoke-RestMethod -Uri $uri -Headers @{Authorization="Bearer $token"} -Method Get -ErrorAction SilentlyContinue
      $clusters = $response.value
    }
    if ($clusters) {
      foreach ($aks in @($clusters)) {
        # Handle both Az.Aks object and REST API response
        $aksName  = if ($aks.Name) { $aks.Name } else { $aks.name }
        $aksRg    = if ($aks.ResourceGroupName) { $aks.ResourceGroupName } else { $aks.id -replace '.*resourceGroups/([^/]+)/.*','$1' }
        $aksLoc   = if ($aks.Location) { $aks.Location } else { $aks.location }
        $aksVer   = if ($aks.KubernetesVersion) { $aks.KubernetesVersion } else { $aks.properties.kubernetesVersion }
        $pState   = if ($aks.PowerState) { $aks.PowerState.Code } elseif ($aks.properties.powerState) { $aks.properties.powerState.code } else { 'Unknown' }
        $nodePools = if ($aks.AgentPoolProfiles) { $aks.AgentPoolProfiles } else { $aks.properties.agentPoolProfiles }
        $nodeCount = if ($nodePools) { ($nodePools | ForEach-Object { if ($_.Count) { $_.Count } else { $_.count } } | Measure-Object -Sum).Sum } else { 0 }
        Write-Host "  AKS: $aksName — $pState"
        if ($pState -eq 'Stopped') {
          $null = $result.resources.stoppedAKS.Add(@{
            subscription=$subName; subscriptionId=$subId
            name=$aksName; resourceGroup=$aksRg
            location=$aksLoc; kubernetesVersion=$aksVer
            nodeCount=$nodeCount; powerState=$pState
            estMonthlyCost=150
            tags=@{}
          })
        }
      }
    } else { Write-Host "  AKS: No clusters found in $subName" }
  } catch { Write-Host "  AKS ERROR: $($_.Exception.Message)" }

  # App Services (Web Apps + Function Apps) — stopped apps still bill for App Service Plan
  try {
    Import-Module Az.Websites -ErrorAction SilentlyContinue | Out-Null
    $apps = Get-AzWebApp -ErrorAction SilentlyContinue
    if ($apps) {
      foreach ($app in @($apps)) {
        if ($app.State -eq 'Stopped') {
          $kind = if ($app.Kind -like '*functionapp*') { 'Function App' } else { 'Web App' }
          $null = $result.resources.stoppedAppSvc.Add(@{
            subscription=$subName; subscriptionId=$subId
            name=$app.Name; resourceGroup=$app.ResourceGroup
            location=$app.Location; kind=$kind
            appServicePlan=$app.ServerFarmId.Split('/')[-1]
            state=$app.State
            estMonthlyCost=50
            tags=if($app.Tags -and $app.Tags.Count){$app.Tags}else{@{}}
          })
        }
      }
    }
  } catch { Write-Host "  AppSvc ERROR: $($_.Exception.Message)" }

  # Container Apps — check revision runningState which maps to portal "Stopped"
  try {
    $token   = (Get-AzAccessToken -ResourceUrl "https://management.azure.com").Token
    $headers = @{Authorization="Bearer $token"}
    $caUri   = "https://management.azure.com/subscriptions/$subId/providers/Microsoft.App/containerApps?api-version=2024-03-01"
    $caList  = Invoke-RestMethod -Uri $caUri -Headers $headers -Method Get -ErrorAction SilentlyContinue
    if ($caList -and $caList.value) {
      Write-Host "  ContainerApps: $($caList.value.Count) in $subName"
      foreach ($ca in @($caList.value)) {
        $caName = $ca.name
        $caRg   = $ca.id -replace '.*resourceGroups/([^/]+)/.*','$1'
        $caLoc  = $ca.location
        $props  = $ca.properties
        $prov   = $props.provisioningState
        $minRep = $props.template.scale.minReplicas
        $maxRep = $props.template.scale.maxReplicas
        $isStopped = $false
        # Check latest revision runningState — this is the definitive stopped indicator
        $latestRev = $props.latestRevisionName
        if ($latestRev) {
          try {
            $revUri = "https://management.azure.com$($ca.id)/revisions/$($latestRev)?api-version=2024-03-01"
            $rev    = Invoke-RestMethod -Uri $revUri -Headers $headers -Method Get -ErrorAction Stop
            $revState  = $rev.properties.runningState
            $revActive = $rev.properties.active
            Write-Host "  CA: $caName | rev=$latestRev | runningState=$revState | active=$revActive | prov=$prov"
            # Stopped = latest revision is Stopped or Degraded
            if ($revState -in @('Stopped','Degraded','Failed','Deactivated')) { $isStopped = $true }
            if ($revActive -eq $false -and $revState -ne 'Running') { $isStopped = $true }
          } catch { Write-Host "  CA: $caName | rev fetch failed | prov=$prov" }
        }
        if ($prov -match 'Stopped|Failed') { $isStopped = $true }
        Write-Host "    isStopped=$isStopped"
        if ($isStopped) {
          $null = $result.resources.stoppedContainerApps.Add(@{
            subscription=$subName; subscriptionId=$subId
            name=$caName; resourceGroup=$caRg
            location=$caLoc; minReplicas=$minRep
            provisioningState=$prov
            estMonthlyCost=0
            tags=if($ca.tags){$ca.tags}else{@{}}
          })
        }
      }
    } else { Write-Host "  ContainerApps: None in $subName" }
  } catch { Write-Host "  ContainerApps ERROR: $($_.Exception.Message)" }

  Write-Host "Done: $subName"
}

$allCosts = foreach ($key in $result.resources.Keys) { foreach ($item in $result.resources[$key]) { $item.estMonthlyCost } }
$totalWaste = if ($allCosts) { ($allCosts | Measure-Object -Sum).Sum } else { 0 }
$result.summary = @{
  totalUnused          = ($result.resources.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
  totalStoppedVMs      = $result.resources.stoppedVMs.Count
  billedVMs            = @($result.resources.stoppedVMs | Where-Object { $_.stillBilled }).Count
  unattachedDisks      = $result.resources.unattachedDisks.Count
  unattachedPIPs       = $result.resources.unattachedPIPs.Count
  unattachedNICs       = $result.resources.unattachedNICs.Count
  unusedNSGs           = $result.resources.unusedNSGs.Count
  emptyLBs             = $result.resources.emptyLBs.Count
  stoppedAKS           = $result.resources.stoppedAKS.Count
  stoppedAppSvc        = $result.resources.stoppedAppSvc.Count
  stoppedContainerApps = $result.resources.stoppedContainerApps.Count
  totalMonthlyWaste    = [math]::Round($totalWaste, 2)
  scannedAt            = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
}
`.trim();

// ── Cache helpers ─────────────────────────────────────────────────────────────
function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const { ts, data } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}
function writeCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data }));
}

// ── History helpers ───────────────────────────────────────────────────────────
function readHistory() {
  try { if (!fs.existsSync(HISTORY_FILE)) return []; return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}
function appendHistory(summary) {
  const history = readHistory();
  const today   = new Date().toISOString().slice(0, 10);
  const idx     = history.findIndex(h => h.date === today);
  const entry   = { date:today, totalUnused:summary.totalUnused, totalWaste:summary.totalMonthlyWaste,
    stoppedVMs:summary.totalStoppedVMs, unattachedDisks:summary.unattachedDisks,
    unattachedPIPs:summary.unattachedPIPs, unattachedNICs:summary.unattachedNICs,
    unusedNSGs:summary.unusedNSGs, emptyLBs:summary.emptyLBs };
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-90), null, 2));
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scanAllSubscriptions() {
  console.log('  Starting Azure scan (single script, all subscriptions)...');
  const start = Date.now();
  const data  = await runPS(AZURE_SCRIPT);
  console.log(`  Scan complete in ${Math.round((Date.now()-start)/1000)}s`);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  const cached = readCache();
  res.json({ status:'ok', cacheAvailable:!!cached, scannedAt:cached?.summary?.scannedAt||null, cacheTTLMinutes:CACHE_TTL_MS/60000, psExe:PS_EXE });
});

app.get('/api/scan', async (req, res) => {
  const force = req.query.force === 'true';
  if (!force) { const cached = readCache(); if (cached) return res.json({ ...cached, fromCache:true }); }
  try {
    const data = await scanAllSubscriptions();
    writeCache(data);
    appendHistory(data.summary);
    res.json({ ...data, fromCache:false });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.toString() });
  }
});

app.get('/api/resources/:type', (req, res) => {
  const cached = readCache();
  if (!cached) return res.status(404).json({ error:'No scan data.' });
  const data = cached.resources?.[req.params.type];
  if (!data) return res.status(400).json({ error:`Unknown type: ${req.params.type}` });
  let filtered = data;
  if (req.query.subscription) filtered = filtered.filter(r => r.subscription === req.query.subscription);
  if (req.query.resourceGroup) filtered = filtered.filter(r => r.resourceGroup === req.query.resourceGroup);
  if (req.query.location)      filtered = filtered.filter(r => r.location === req.query.location);
  res.json({ count:filtered.length, data:filtered });
});

app.get('/api/summary', (req, res) => {
  const cached = readCache();
  if (!cached) return res.status(404).json({ error:'No scan data.' });
  res.json(cached.summary);
});

app.get('/api/history', (req, res) => { res.json(readHistory()); });

// GET /api/containerapps-debug — test container apps API directly
app.get('/api/containerapps-debug', async (req, res) => {
  const script = `
    $ErrorActionPreference = 'Continue'
    Import-Module Az.Accounts -ErrorAction Stop | Out-Null
    $token = (Get-AzAccessToken -ResourceUrl "https://management.azure.com").Token
    $headers = @{Authorization="Bearer $token"}
    $results = @()
    $subId = 'a31596c1-e218-48d6-ad65-c7beafeb2bfa'
    foreach ($apiVer in @("2024-10-02-preview","2024-03-01","2023-11-02-preview","2023-05-01")) {
      try {
        $uri = "https://management.azure.com/subscriptions/$subId/providers/Microsoft.App/containerApps?api-version=$apiVer"
        $r = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -ErrorAction Stop
        if ($r.value) {
          foreach ($ca in $r.value) {
            $results += @{
              apiVersion = $apiVer
              name = $ca.name
              allPropertyKeys = ($ca.properties | Get-Member -MemberType NoteProperty).Name
              provisioningState = $ca.properties.provisioningState
              runningStatus = if ($ca.properties.PSObject.Properties.Name -contains 'runningStatus') { $ca.properties.runningStatus } else { 'NOT_PRESENT' }
              minReplicas = $ca.properties.template.scale.minReplicas
              maxReplicas = $ca.properties.template.scale.maxReplicas
            }
          }
          break
        }
      } catch { }
    }
    $result = $results
  `;
  try { res.json(await runPS(script)); }
  catch(e) { res.status(500).json({ error: e.toString() }); }
});

app.get('/api/debug', (req, res) => {
  const info = { psExe:PS_EXE, psVersion:null, azModule:null, azContext:null, error:null };
  try {
    info.psVersion = execSync(`${PS_EXE} -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`, {timeout:8000}).toString().trim();
    info.azModule  = execSync(`${PS_EXE} -NoProfile -Command "(Get-Module Az.Accounts -ListAvailable | Select-Object -First 1).Version.ToString()"`, {timeout:10000}).toString().trim();
    info.azContext = execSync(`${PS_EXE} -NoProfile -Command "$c=Get-AzContext; if($c){''+$c.Account.Id+' / '+$c.Subscription.Name}else{'NOT LOGGED IN'}"`, {timeout:10000}).toString().trim();
  } catch(e) { info.error = e.message; }
  res.json(info);
});

app.get('/api/me', async (req, res) => {
  try {
    const script = `
      Import-Module Az.Accounts -ErrorAction Stop | Out-Null
      $ctx = Get-AzContext
      $result = if($ctx){@{name=$ctx.Account.Id;subscription=$ctx.Subscription.Name}}else{@{name='Not signed in';subscription=''}}
    `;
    res.json(await runPS(script));
  } catch (err) { res.json({ name:'Unknown', error:err.toString() }); }
});

app.listen(PORT, () => {
  console.log(`\n  CloudOps  →  http://localhost:${PORT}`);
  console.log(`  Scan      →  http://localhost:${PORT}/api/scan`);
  console.log(`  History   →  http://localhost:${PORT}/api/history`);
  console.log(`  Rescan    →  http://localhost:${PORT}/api/scan?force=true\n`);
});
