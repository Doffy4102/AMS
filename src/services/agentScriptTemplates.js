// Generates the downloadable endpoint-agent scripts with the server URL and
// enrollment key baked in. Native scripts only (no runtime install required):
//   - Windows: PowerShell (.ps1), self-installs a 15-min Scheduled Task.
//   - macOS:   POSIX shell (.sh), self-installs a launchd agent (StartInterval 900).
// Both collect system details on first run (enroll), persist the returned token,
// then send a heartbeat on every subsequent run.

const AGENT_VERSION = '1.0.0';

function windowsScript(serverUrl, enrollmentKey) {
  return `# IT-HAMS Endpoint Agent for Windows (v${AGENT_VERSION})
# Usage:
#   Install (registers a scheduled task, runs every 15 min):  .\\hams-agent.ps1 -Install
#   Run one cycle manually:                                   .\\hams-agent.ps1
#   Uninstall:                                                .\\hams-agent.ps1 -Uninstall
param([switch]$Install, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ServerUrl      = '${serverUrl}'
$EnrollmentKey  = '${enrollmentKey}'
$AgentVersion   = '${AGENT_VERSION}'
$StateDir       = Join-Path $env:ProgramData 'HAMSAgent'
$TokenFile      = Join-Path $StateDir 'token.txt'
$ScriptTarget   = Join-Path $StateDir 'hams-agent.ps1'
$TaskName       = 'HAMS Endpoint Agent'

function Ensure-StateDir { if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null } }

function Get-SystemInfo {
    $os   = Get-CimInstance Win32_OperatingSystem
    $cs   = Get-CimInstance Win32_ComputerSystem
    $cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
    $bios = Get-CimInstance Win32_BIOS
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $ip   = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
             Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
             Select-Object -First 1).IPAddress
    $mac  = (Get-NetAdapter -ErrorAction SilentlyContinue |
             Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1).MacAddress
    $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
    return @{
        platform       = 'windows'
        hostname       = $env:COMPUTERNAME
        os             = $os.Caption
        os_version     = $os.Version
        cpu_model      = $cpu.Name
        cpu_cores      = $cpu.NumberOfLogicalProcessors
        ram_mb         = [int]($cs.TotalPhysicalMemory / 1MB)
        disk_total_gb  = [math]::Round($disk.Size / 1GB, 1)
        disk_free_gb   = [math]::Round($disk.FreeSpace / 1GB, 1)
        mac_address    = $mac
        ip_address     = $ip
        logged_in_user = $cs.UserName
        serial_number  = $bios.SerialNumber
        manufacturer   = $cs.Manufacturer
        model          = $cs.Model
        asset_type     = if ($cs.PCSystemType -eq 2) { 'Laptop' } else { 'Desktop' }
        agent_version  = $AgentVersion
        uptime_sec     = $uptime
    }
}

function Invoke-Enroll {
    $info = Get-SystemInfo
    $body = $info | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Uri "$ServerUrl/api/v1/agent/enroll" -Method Post -Body $body \`
        -ContentType 'application/json' -Headers @{ 'X-Enrollment-Key' = $EnrollmentKey }
    Ensure-StateDir
    Set-Content -Path $TokenFile -Value $resp.token -Encoding ASCII
    Write-Host "Enrolled. Asset #$($resp.asset_id) linked."
    return $resp.token
}

function Invoke-Heartbeat($token) {
    $os   = Get-CimInstance Win32_OperatingSystem
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $ip   = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
             Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
             Select-Object -First 1).IPAddress
    $body = @{
        cpu_percent    = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 2)
        ram_used_mb    = [int](($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1KB)
        disk_free_gb   = [math]::Round($disk.FreeSpace / 1GB, 1)
        uptime_sec     = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
        ip_address     = $ip
        logged_in_user = (Get-CimInstance Win32_ComputerSystem).UserName
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$ServerUrl/api/v1/agent/heartbeat" -Method Post -Body $body \`
        -ContentType 'application/json' -Headers @{ 'X-Agent-Token' = $token } | Out-Null
    Write-Host "Heartbeat sent $(Get-Date -Format o)"
}

function Run-Cycle {
    $token = $null
    if (Test-Path $TokenFile) { $token = (Get-Content $TokenFile -Raw).Trim() }
    if ([string]::IsNullOrWhiteSpace($token)) { $token = Invoke-Enroll }
    try { Invoke-Heartbeat $token }
    catch {
        # Token may have been revoked / server reset -> re-enroll once.
        Write-Host "Heartbeat failed ($($_.Exception.Message)); re-enrolling."
        $token = Invoke-Enroll
        Invoke-Heartbeat $token
    }
}

if ($Uninstall) {
    schtasks /Delete /TN "$TaskName" /F 2>$null
    Write-Host "Uninstalled scheduled task."
    return
}

if ($Install) {
    Ensure-StateDir
    Copy-Item -Path $MyInvocation.MyCommand.Path -Destination $ScriptTarget -Force
    $action  = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \`"$ScriptTarget\`""
    schtasks /Create /TN "$TaskName" /TR $action /SC MINUTE /MO 15 /RL HIGHEST /F | Out-Null
    Write-Host "Installed. The agent will report every 15 minutes."
    Run-Cycle
    return
}

Run-Cycle
`;
}

function macScript(serverUrl, enrollmentKey) {
  return `#!/bin/bash
# IT-HAMS Endpoint Agent for macOS (v${AGENT_VERSION})
# Usage:
#   Install (launchd agent, runs every 15 min):  ./hams-agent.sh install
#   Run one cycle manually:                       ./hams-agent.sh
#   Uninstall:                                    ./hams-agent.sh uninstall
set -euo pipefail

SERVER_URL="${serverUrl}"
ENROLLMENT_KEY="${enrollmentKey}"
AGENT_VERSION="${AGENT_VERSION}"
STATE_DIR="$HOME/.hams-agent"
TOKEN_FILE="$STATE_DIR/token"
SCRIPT_TARGET="$STATE_DIR/hams-agent.sh"
PLIST="$HOME/Library/LaunchAgents/inc.hams.agent.plist"

mkdir -p "$STATE_DIR"

json_get() { # extract a top-level string field from JSON: json_get <field>
  sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p"
}

collect_static() {
  HOSTNAME_V="$(scutil --get ComputerName 2>/dev/null || hostname)"
  OS_V="macOS"
  OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo '')"
  CPU_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '')"
  CPU_CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 0)"
  RAM_MB="$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))"
  DISK_TOTAL_GB="$(df -g / | awk 'NR==2{print $2}')"
  DISK_FREE_GB="$(df -g / | awk 'NR==2{print $4}')"
  IP_V="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
  MAC_V="$(ifconfig en0 2>/dev/null | awk '/ether/{print $2; exit}')"
  USER_V="$(stat -f%Su /dev/console 2>/dev/null || whoami)"
  SERIAL_V="$(ioreg -l | awk -F'\"' '/IOPlatformSerialNumber/{print $4; exit}')"
  MANUF_V="Apple Inc."
  MODEL_V="$(sysctl -n hw.model 2>/dev/null || echo '')"
  UPTIME_SEC="$(( $(date +%s) - $(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \\([0-9]*\\).*/\\1/p') ))"
}

enroll() {
  collect_static
  BODY=$(printf '{"platform":"mac","hostname":"%s","os":"%s","os_version":"%s","cpu_model":"%s","cpu_cores":%s,"ram_mb":%s,"disk_total_gb":%s,"disk_free_gb":%s,"mac_address":"%s","ip_address":"%s","logged_in_user":"%s","serial_number":"%s","manufacturer":"%s","model":"%s","asset_type":"Laptop","agent_version":"%s","uptime_sec":%s}' \\
    "$HOSTNAME_V" "$OS_V" "$OS_VERSION" "$CPU_MODEL" "$CPU_CORES" "$RAM_MB" "$DISK_TOTAL_GB" "$DISK_FREE_GB" "$MAC_V" "$IP_V" "$USER_V" "$SERIAL_V" "$MANUF_V" "$MODEL_V" "$AGENT_VERSION" "$UPTIME_SEC")
  RESP=$(curl -fsS -X POST "$SERVER_URL/api/v1/agent/enroll" \\
    -H "Content-Type: application/json" -H "X-Enrollment-Key: $ENROLLMENT_KEY" -d "$BODY")
  TOKEN=$(printf '%s' "$RESP" | json_get token)
  [ -n "$TOKEN" ] && printf '%s' "$TOKEN" > "$TOKEN_FILE" && echo "Enrolled with IT-HAMS."
}

heartbeat() {
  local token="$1"
  IP_V="$(ipconfig getifaddr en0 2>/dev/null || echo '')"
  USER_V="$(stat -f%Su /dev/console 2>/dev/null || whoami)"
  DISK_FREE_GB="$(df -g / | awk 'NR==2{print $4}')"
  UPTIME_SEC="$(( $(date +%s) - $(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \\([0-9]*\\).*/\\1/p') ))"
  BODY=$(printf '{"disk_free_gb":%s,"uptime_sec":%s,"ip_address":"%s","logged_in_user":"%s"}' \\
    "$DISK_FREE_GB" "$UPTIME_SEC" "$IP_V" "$USER_V")
  curl -fsS -X POST "$SERVER_URL/api/v1/agent/heartbeat" \\
    -H "Content-Type: application/json" -H "X-Agent-Token: $token" -d "$BODY" >/dev/null
  echo "Heartbeat sent $(date -u +%FT%TZ)"
}

run_cycle() {
  local token=""
  [ -f "$TOKEN_FILE" ] && token="$(cat "$TOKEN_FILE")"
  if [ -z "$token" ]; then enroll; token="$(cat "$TOKEN_FILE")"; fi
  if ! heartbeat "$token"; then
    echo "Heartbeat failed; re-enrolling."
    enroll; heartbeat "$(cat "$TOKEN_FILE")"
  fi
}

case "\${1:-run}" in
  install)
    cp "$0" "$SCRIPT_TARGET"; chmod +x "$SCRIPT_TARGET"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>inc.hams.agent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT_TARGET</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLISTEOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed. The agent will report every 15 minutes."
    run_cycle
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"; echo "Uninstalled."
    ;;
  *)
    run_cycle
    ;;
esac
`;
}

module.exports = { windowsScript, macScript, AGENT_VERSION };
