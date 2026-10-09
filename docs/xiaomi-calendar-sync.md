# 小米日历同步专项说明

本文说明「如何通过 API（URL）把课表导出并同步到小米手机日历」，包含调用方式、返回格式、兼容性要求与排障手册。

---

## 1. 调用方式

### 1.1 订阅型接口（推荐，自动同步）

```http
GET /ics/{token}.ics
Host: <运行本服务的主机>
```

- **无需任何鉴权**：URL 中的 `{token}` 即为凭据。这是刻意为之——小米日历等多数手机日历客户端无法完成 Header 携带密钥或 Digest 认证，任何带 `401 + WWW-Authenticate` 的地址都会订阅失败。
- **地址获取 / 刷新**：

```http
GET /api/subscription?termId=term_xxx
X-API-Key: <API_KEY>
```

返回：

```json
{
  "ok": true,
  "termId": "term_xxx",
  "termName": "2026-2027学年 秋季学期",
  "token": "EViYjuC8iqlSCDMa",
  "urls": {
    "subscribe":  "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics",
    "flat":       "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics?mode=flat",
    "download":   "http://172.16.0.76:3000/api/export?format=ics&termId=term_xxx&api_key=<API_KEY>"
  },
  "compatibility": {
    "contentType": "text/calendar; charset=utf-8; component=vevent; method=PUBLISH",
    "auth": "无需认证，URL 中的 token 即为凭据",
    "refreshHintSeconds": 3600
  }
}
```

### 1.2 可用参数（直接拼在订阅 URL 后）

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `recurrence` / `flat` | `recurrence` | 重复事件 / 逐条展开 |
| `tz` | `floating` / `tzid` | `floating` | 浮动本地时间 / 标准 TZID+VTIMEZONE |
| `remind` | 整数分钟 | `15` | `0` 表示关闭提醒 |
| `title` | 模板串 | `{name}` | 支持 `{name}` `{teacher}` `{location}` `{class}` `{note}` |
| `download` | `1` | — | 带下载头，而非订阅 |

示例：

```
http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics?mode=flat&remind=30&title={name}（{teacher}）
```

### 1.3 下载型接口（一次性导入，需鉴权）

```bash
curl -H "X-API-Key: sk_xxx" \
  "http://127.0.0.1:3000/api/export?format=ics&termId=term_xxx" -o 课表.ics
```

把得到的 `.ics` 文件通过任意方式传到手机，用「日历」App 或文件管理器打开即可一次性导入（此后不会自动更新）。

---

## 2. 返回格式

```http
HTTP/1.1 200 OK
Content-Type: text/calendar; charset=utf-8; component=vevent; method=PUBLISH
Cache-Control: no-cache, no-store, must-revalidate
Content-Language: zh-CN
Transfer-Encoding: chunked
```

消息体为 RFC 5545 文本：

- 行尾一律 `\r\n`
- 每个内容行按 **75 字节**折叠，续行以单个空格开头，折叠点不会切断 UTF-8 中文字符
- 编码 UTF-8 **无 BOM**
- 时间采用浮动本地格式：`DTSTART:20260907T080000`（默认不带 `TZID`、不带 `Z`，由手机本地时区解释）

### 2.1 字段映射

| 课表数据 | ICS 属性 |
|---|---|
| 课程名 | `SUMMARY`（可由 `title` 模板改写） |
| 上课地点 | `LOCATION` |
| 教师/班级/周次/节次/学分/备注 | `DESCRIPTION`（`\n` 换行） |
| 每周重复 | `RRULE:FREQ=WEEKLY;INTERVAL=n;BYDAY=xx;UNTIL=…` |
| 单周/双周 | `INTERVAL=2`，起始实例落在对应周 |
| 离散周次 | `INTERVAL=1` + `EXDATE` 剔除 |
| 放假 | `EXDATE` |
| 调休补课 | 独立单次 `VEVENT`，`UID` 加 `-mk-YYYYMMDD` 后缀 |
| 提前提醒 | `VALARM` + `TRIGGER:-PTnM` + `ACTION:DISPLAY` |
| 事件唯一性 | `UID:{courseId}@{domain}`，稳定不变 |

### 2.2 recurrence 与 flat 对比

|  | `recurrence`（默认） | `flat` |
|---|---|---|
| VEVENT 数量 | 每门课 1 个（示例学期 11 门课 → 13 个事件） | 每次课 1 个（示例学期 143 次课 → 143 个事件） |
| 文件体积 | ≈7.6 KB | ≈35 KB |
| 依赖 RRULE/EXDATE | 是 | 否 |
| 兼容性 | 良好 | **最强** |

---

## 3. 兼容性要求清单

本实现针对国产 ROM（尤其是 MIUI/澎湃 OS 自带日历）做了如下处理：

| # | 要求 | 实现方式 |
|---|---|---|
| 1 | 不得要求认证 | 独立白名单路由 `/ics/:token.ics`，永不返回 401 挑战 |
| 2 | MIME 正确 | `text/calendar; charset=utf-8; component=vevent; method=PUBLISH` |
| 3 | UTF-8 无 BOM | 直接写 UTF-8 字节，不带 EF BB BF |
| 4 | CRLF + 75 字节折叠 | `src/ics.js#foldLine`，中文按字节安全切分 |
| 5 | UID 幂等稳定 | 基于课程 id，多次刷新不重建事件/提醒 |
| 6 | 避免 TZID 解析失败 | 默认浮动本地时间；`?tz=tzid` 提供标准 VTIMEZONE 版本 |
| 7 | 规则简单 | 仅 `FREQ=WEEKLY` + `INTERVAL` + `BYDAY` + `UNTIL`，不用 `BYSETPOS` |
| 8 | 不出现无限重复 | 一律带 `UNTIL`；离散周次用 `EXDATE` 收敛 |
| 9 | `DTSTAMP` 合理 | 取 `course.updatedAt`，内容未变则保持不变 |
| 10 | 刷新提示 | `REFRESH-INTERVAL:PT1H`、`X-PUBLISHED-TTL:PT1H`、`Cache-Control: no-cache` |
| 11 | URL 易手输 | 16 位 base64url 令牌，无特殊字符 |
| 12 | 令牌可轮换 | `POST /api/terms/:id/token` |
| 13 | 网络可达 | 需局域网互通或公网域名/内网穿透 |

> **关于 HTTPS**：小米日历对局域网 `http://` 订阅地址可直接订阅；若走公网，建议 Nginx 反代并配置 HTTPS 证书，同时设置环境变量 `TIMETABLE_PUBLIC_BASE_URL` 为对外地址，保证界面里生成的地址正确。

---

## 4. 手机端操作步骤

1. 确认电脑与手机处于同一 Wi-Fi，且电脑防火墙放行服务端口（Windows 首次运行 Node 会提示「允许访问」，请选择**允许**）。
2. 管理端右上角「**日历订阅**」→ 复制订阅地址（界面同时给出带参数的版本）。
3. 手机「**日历**」App → 右上角 `⋮` → **设置** → **日历订阅 / 添加订阅日历** → 粘贴地址 → 确定。
4. 回到日历主界面 → 右上角 `⋮` → 勾选新出现的日历名称。
5. 下拉可立即触发刷新；否则等待约 1 小时自动同步。

---

## 5. 排障手册

| 现象 | 原因 | 处理 |
|---|---|---|
| 添加订阅提示「无法连接」/「同步失败」 | ① 地址写的是 `localhost`/`127.0.0.1`（手机视角就是手机自己）；② 电脑未放行端口；③ 不在同一网络 | 用**局域网 IP**；关闭/放行防火墙；或改用内网穿透/公网域名 |
| 课程时间整体偏移 8 小时 | 客户端未能解析时区 | 默认已是 `floating`；若你自己加了 `?tz=tzid`，去掉该参数即可 |
| 节假日/放假日期仍显示课程 | 该机型不支持 `EXDATE` | 订阅地址改为 `?mode=flat` |
| 出现两份重复课表 | 之前用其他方式也添加过同一份数据 | 删除旧订阅/旧导入；订阅型与文件导入型不要混用 |
| 修改课程后手机不变 | 客户端缓存 | 下拉手动刷新；或删除订阅后重新添加 |
| 没有提醒 | ① `remind=0`；② 手机把该日历的提醒开关关了 | 订阅地址加 `&remind=20`；手机日历设置里开启该日历通知 |
| 事件标题想带教师名 | — | 订阅地址加 `&title={name}（{teacher}）` |
| 令牌泄露 | — | `POST /api/terms/:id/token` 轮换，旧地址立即失效 |
| 电脑 IP 变动 | DHCP 重新分配 | 给电脑设置静态 IP，或配置 `TIMETABLE_PUBLIC_BASE_URL` 指向固定域名 |
