#requires -RunAsAdministrator
<#
.SYNOPSIS
  为学生课表系统放行 Windows 防火墙入站端口（公网开放必需）。

.DESCRIPTION
  服务绑定到 0.0.0.0 只是「监听所有网卡」，若防火墙阻挡，外部仍无法访问。
  本脚本创建/删除一条允许外部访问服务端口的入站规则。

.EXAMPLE
  .\scripts\open-firewall.ps1                    # 放行 3000
  .\scripts\open-firewall.ps1 -Port 8080         # 放行 8080
  .\scripts\open-firewall.ps1 -Remove            # 删除规则（关闭外网访问）
#>
param(
    [int]$Port = 3000,
    [ValidateSet('Any', 'Domain', 'Private', 'Public')]
    [string]$Profile = 'Any',
    [switch]$Remove
)

$ruleName = "StudentTimetable-$Port"

if ($Remove) {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host "已删除入站规则 $ruleName，外部将无法访问 TCP $Port" -ForegroundColor Yellow
    exit 0
}

# 幂等：先清掉同名旧规则
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description "学生课表系统 HTTP 服务端口" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile $Profile `
    -Enabled True | Out-Null

$filter = Get-NetFirewallRule -DisplayName $ruleName | Get-NetFirewallPortFilter
Write-Host "✅ 已放行入站 TCP $($filter.LocalPort)（Profile=$Profile）" -ForegroundColor Green
Write-Host ""
Write-Host "本机可访问地址："
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object { Write-Host "   http://$($_.IPAddress):$Port/" }
Write-Host ""
Write-Host "提示：若要从真正的公网访问，还需在路由器做端口映射，或使用内网穿透/公网主机。"
