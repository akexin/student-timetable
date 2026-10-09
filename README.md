# 学生课表系统（Student Timetable System）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![Tests](https://img.shields.io/badge/tests-78%20passed-success)

一套**零第三方依赖**、开箱即用的学生课表管理系统。覆盖「录入 → 存储 → 导入导出 → 日历同步」完整链路，内置 REST API，**支持通过 URL 订阅方式把课表实时同步到小米手机日历**。

- **源码栈**：Node.js（≥18）原生 `node:http` + 单文件 JSON 持久化，**不依赖任何 npm 包**（含 Excel 与 ZIP 打包均为自实现）
- **前端**：原生 HTML/CSS/JS 单页管理端，无构建步骤，响应式适配手机
- **状态**：78 项端到端冒烟测试全部通过（`npm test`）

---

## 一、快速开始

```bash
git clone https://github.com/akexin/student-timetable.git
cd student-timetable
node src/server.js          # 或 npm start（无需 npm install）
```

首次启动会生成 `data/config.json`（含 **API Key**）与示例学期数据（`npm run seed` 可重置示例）。控制台输出示例：

```
管理界面      : http://localhost:3000/
局域网地址    : http://172.16.0.76:3000/          ← 小米手机要访问的地址
API Key       : sk_XXXXXXXXXXXXXXXXXXXXXXXX
日历订阅地址  : http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics
```

浏览器打开管理界面后，点右上角「**连接**」填入 API Key 即可（也可直接用 `http://<host>:3000/#key=<API_KEY>` 自动填入）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `--port` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `TIMETABLE_API_KEY` | 首次启动随机生成 | API 密钥 |
| `TIMETABLE_PUBLIC_BASE_URL` | 按请求 Host 推断 | **强烈建议配置为局域网 IP 或域名**，否则生成的订阅地址可能是 `localhost`，手机无法访问 |
| `TIMETABLE_REMIND_MINUTES` | `15` | ICS 事件提前提醒分钟数，`0` 表示不提醒 |
| `TIMETABLE_DATA_DIR` | `./data` | 数据目录 |

### 1.1 绑定到 0.0.0.0（对所有网卡 / 公网开放）

默认值即为 `0.0.0.0`，即监听本机全部网卡，局域网与（具备公网条件时的）公网均可访问：

```json
// data/config.json
{ "host": "0.0.0.0", "port": 3000, "publicBaseUrl": "" }
```

或临时指定：

```bash
HOST=0.0.0.0 PORT=3000 node src/server.js
```

### 1.2 公网可达的三层条件（缺一不可）

| 层次 | 要求 | 操作 |
|---|---|---|
| ① 监听 | `host = 0.0.0.0` | 上表配置 |
| ② 主机防火墙 | 放行入站 TCP 端口 | 管理员 PowerShell：`.\scripts\open-firewall.ps1 -Port 3000`（关闭用 `-Remove`） |
| ③ 网络出口 | 拥有公网 IP 并做端口映射，或使用内网穿透 | 路由器「虚拟服务器/端口转发」；或用 frp / ngrok / 花生壳 等 |

> 注意：本机当前出口为私有地址（`172.16.x.x`），说明处于 NAT 之后。**仅绑定 0.0.0.0 并不能让外网直接访问**，必须完成第 ③ 步。

### 1.3 对外地址固定

订阅地址默认按请求 `Host` 头推断；若要固定（例如已配置域名或穿透地址），设置：

```bash
TIMETABLE_PUBLIC_BASE_URL=https://timetable.example.com node src/server.js
```

此后 `/api/subscription`、`/api/meta`、管理端界面生成的订阅地址一律使用该基址。

### 1.4 公网开放的安全建议

| 项目 | 建议 |
|---|---|
| HTTPS | 公网务必用 Nginx/Caddy 反代并配置证书，否则 API Key 与订阅令牌明文传输 |
| API Key | 泄露后删除 `data/config.json` 中的 `apiKey` 字段并重启，服务会自动重新生成 |
| 订阅令牌 | 泄露后调用 `POST /api/terms/:id/token` 轮换，旧地址立即失效 |
| 管理页面 | 页面本身免鉴权但**无 Key 无法读写任何数据**；如需彻底隐藏，可在反代层对 `/` 加 Basic Auth，但需放行 `/ics/` |
| 最小化暴露 | 若只在校园网使用，可用 `HOST=172.16.0.76` 绑定单网卡，而非 `0.0.0.0` |

---

## 二、主要功能模块

| 模块 | 说明 | 关键实现 |
|---|---|---|
| **学期管理** | 多学期并存；可配置学期名称、第一周周一（非周一自动对齐）、总周数（1–40）、自定义节次时间表 | `POST/GET/PUT/DELETE /api/terms` |
| **课程管理** | 课程增删改查、批量创建、批量删除、按星期/教师/关键字检索 | `/api/courses` |
| **周课表视图** | 按周渲染 7×N 节次矩阵，自动叠加节假日剔除与调休补课；点击空白格新增、点击卡片编辑 | `/api/timetable` |
| **节假日与调休** | `holiday`=当日课程取消（导出为 `EXDATE`）；`makeup`=指定日期执行星期 X 的课表（导出为额外单次事件） | `/api/holidays` |
| **导入中心** | 支持文件/文本/远程 URL；支持 JSON / CSV / ICS；三种冲突策略 | `POST /api/import` |
| **导出中心** | JSON / CSV / CSV 周视图 / Excel(xlsx) / ICS 五种输出 | `GET /api/export` |
| **日历订阅** | 每个学期一个只读令牌，生成可直接被手机日历订阅的地址，支持令牌轮换 | `/ics/:token.ics`、`/api/subscription` |
| **统计** | 课程数、总课次（已计入放假剔除）、学分、放假/调休天数、按星期分布 | `/api/stats` |
| **Schema 自描述** | 对外暴露完整字段字典与 JSON Schema，便于第三方系统对接 | `/api/schema` |

---

## 三、课表数据字段定义

统一由 `src/model.js` 的 `FIELD_DEFS` 定义，`/api/schema` 与本文档均由此生成，文档与实现永不脱节。

### 3.1 学期 `term`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | `term_xxxxxxxx`，服务端生成 |
| `name` | string | ✅ | 学期名称，如 `2026-2027学年 秋季学期` |
| `startDate` | date | ✅ | **第一周周一**（`YYYY-MM-DD`）；传入非周一时自动对齐到当周周一 |
| `weeks` | integer | ✅ | 总周数，1–40 |
| `periods[]` | array | ✅ | 节次时间表，见下方 `period` |
| `subscriptionToken` | string | — | 只读，日历订阅令牌 |
| `createdAt` / `updatedAt` | datetime | — | ISO 8601 |

### 3.2 节次 `period`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `index` | integer | ✅ | 第几节，从 1 开始 |
| `name` | string | — | 如 `第一节` |
| `startTime` / `endTime` | time | ✅ | `HH:mm`，结束必须晚于开始 |

默认内置 10 节（08:00–20:40），可在学期设置里任意增删改。

### 3.3 课程 `course`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string | — | 自动生成 | 课程唯一标识 |
| `termId` | string | ✅ | — | 所属学期 |
| `name` | string | ✅ | — | 课程名称 |
| `dayOfWeek` | integer 1–7 | ✅ | — | **1=周一 … 7=周日** |
| `startPeriod` | integer ≥1 | ✅ | — | 开始节次 |
| `endPeriod` | integer ≥1 | — | = startPeriod | 结束节次（连堂时 > startPeriod） |
| `teacher` | string | — | `''` | 任课教师 |
| `location` | string | — | `''` | 上课地点 |
| `weeks` | weeksRule | — | `{mode:'all'}` | 上课周次规则 |
| `startTime` / `endTime` | time | — | 由节次表推导 | 显式指定后**优先**于节次表 |
| `className` | string | — | `''` | 班级／行政班 |
| `credit` | number | — | `null` | 学分 |
| `note` | string | — | `''` | 备注 |
| `color` | string | — | `''` | 界面色值，如 `#4F7CF7` |

### 3.4 周次规则 `weeksRule`

对象形式：

```json
{ "mode": "all"  }                                    // 全学期
{ "mode": "range", "start": 1,  "end": 16 }           // 连续周
{ "mode": "odd",   "start": 1,  "end": 16 }           // 单周
{ "mode": "even",  "start": 2,  "end": 16 }           // 双周
{ "mode": "list",  "list": [1, 3, 5] }                // 离散周
```

**字符串简写**（CSV 录入、API 均可使用，解析器见 `parseWeeksRule`）：

| 写法 | 含义 |
|---|---|
| `1-16`、`1-16周` | 第 1–16 周 |
| `1-16单`、`单周` | 单周（起始缺省取 1，结束缺省取学期总周数） |
| `1-16双` | 双周 |
| `1,3,5-9` | 离散：1、3、5、6、7、8、9 |
| `all`、`*`、`全部`、留空 | 全学期 |
| `[1,2,3]`（数组） | 离散周次 |

### 3.5 节假日 / 调休 `holiday`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `termId` | string | ✅ | 所属学期 |
| `date` | date | ✅ | `YYYY-MM-DD` |
| `type` | enum | ✅ | `holiday` 放假（当日课程取消）／`makeup` 调休补课 |
| `targetDayOfWeek` | integer 1–7 | 条件必填 | `type=makeup` 时必填：当日执行星期几的课表 |
| `name` | string | — | 说明 |

> 语义示例： `{date:'2026-10-10', type:'makeup', targetDayOfWeek:5}` = 10 月 10 日（周六）按周五课表上课，若该周周五有课则会额外生成一天课程。

---

## 四、支持的导入方式

### 4.1 方式总览

| 维度 | 支持情况 |
|---|---|
| **数据格式** | JSON、CSV（含 Excel/WPS 另存）、ICS/iCalendar |
| **数据来源** | ① 直接正文字符串 ② 本地文件（管理端上传 / multipart）③ **远程 URL**（服务端主动拉取） |
| **冲突策略** | `upsert`（默认，按 id 或课程指纹去重更新）、`merge`（追加）、`replace`（清空该学期后导入） |
| **自动识别** | 不传 `format` 时按内容首字符自动判别：`{`/`[`→JSON；`BEGIN:VCALENDAR`→ICS；否则 CSV |

### 4.2 课程指纹去重规则

`upsert` 模式下，满足下列任一即视为同一门课（更新而非新增）：

1. `id` 相同；
2. **指纹相同** = `课程名 | 星期 | 开始节次 | 归一化开始时间 | 上课地点`。

> 归一化说明：若一处用「第 1–2 节」表示、另一处用「08:00」表示，系统会按该学期的节次表换算成同一时间，因此不会误判为两门课。

### 4.3 导入请求格式

```http
POST /api/import
Content-Type: application/json
X-API-Key: <API_KEY>
```

```json
{
  "format": "auto",                // auto | json | csv | ics
  "mode": "upsert",                // upsert | merge | replace
  "termId": "term_xxx",            // 留空时：按数据内嵌学期信息匹配或自动新建
  "data": "...",                   // 方式一：正文字符串；也可直接给 JSON 对象/数组
  "url": "https://...",            // 方式二：远程地址（与 data 二选一）
  "contentType": "text/calendar",  // 可选，辅助格式识别
  "applyDefaults": { "className": "计科2301" }   // 可选，统一补齐默认字段
}
```

> `multipart/form-data` 同样支持：字段 `file`（文件）、`termId`、`format`、`mode`。

**导入响应**：

```json
{
  "ok": true,
  "format": "csv",
  "termId": "term_xxx",
  "mode": "upsert",
  "source": "CSV 共 18 行",
  "total": 18,
  "created": 16,
  "updated": 2,
  "skipped": 0,
  "holidaysImported": 3,
  "errors": [],
  "details": [],
  "courseIds": ["c_xxx", "..."]
}
```

单项错误不会中断整批导入，会汇总到 `errors`（含行号/索引与原因），HTTP 状态码仍为 **201**；若存在行级错误则 `ok=false`，便于前端提示。

### 4.4 从远程 URL 导入

服务端会主动 `GET` 该地址并解码，因此可把**任意第三方系统提供的 ICS/JSON 地址**作为数据源，包括本系统另一个实例的导出接口：

```json
{
  "mode": "merge",
  "url": "http://192.168.1.20:3000/api/export?format=ics&termId=term_xxx&api_key=sk_yyy"
}
```

### 4.5 CSV 列定义

表头支持中文与英文别名，由 `headerToKey()` 做「忽略大小写 + 忽略空格」的归一化匹配：

| 表头 | key | 常用别名 |
|---|---|---|
| 课程名称 | `name` | 课程名 / courseName / title / subject |
| 教师 | `teacher` | teacherName / instructor |
| 上课地点 | `location` | 地点 / place / room / classroom |
| 星期 | `dayOfWeek` | day / weekday / dow（支持 `1`~`7`、`周一`…`周日`、`Mon`…`Sun`） |
| 开始节次 | `startPeriod` | period |
| 结束节次 | `endPeriod` | — |
| 开始时间 / 结束时间 | `startTime` / `endTime` | start / end |
| 周次规则 | `weeks` | 周次 / weeksRule / weekRule |
| 班级 | `className` | class / 班级名 |
| 学分 | `credit` | credits / score |
| 备注 | `note` | remark / comment / desc |
| 颜色 | `color` | colour |
| 课程ID | `id` | courseId |

模板下载：`GET /api/export/template?format=csv`（或 `xlsx`）。

### 4.6 教务系统直连导入（南京工业职业技术大学 `jwxt.njpi.edu.cn`）

已内置脚本 `scripts/import-njpi.js`，**直接从教务系统拉取课表并写入本系统**，无需手工抄录。

原理：教务「学生课表」页是 Vue 单页应用，数据来自
`https://jwxt.njpi.edu.cn/eams-micro-server/api/v1/**`，鉴权为请求头 `X-Id-Token`
（取页面 URL `?idToken=` 之后、`#/` 之前的部分）。

用到的接口：

| 接口 | 用途 |
|---|---|
| `/semester/current-semester` | 学期 id、起止日期、周数 |
| `/semester/current-week/{id}` | 当前第几周 |
| `/system/course-units?bizTypeId=&semesterId=` | 节次时间表 |
| `/lesson/student/course-table/{id}` | 课表本体（逐条 `schedules`，含具体日期） |

字段映射：

| 教务字段 | 本系统字段 |
|---|---|
| `course.nameZh` / `course.credits` | `name` / `credit` |
| `schedules[].weekday`（1=周一…7=周日，已用 2026-09-16 周三核对） | `dayOfWeek` |
| `schedules[].startUnit` / `endUnit` | `startPeriod` / `endPeriod` |
| `schedules[].startTime` / `endTime`（如 `1330`） | `startTime` / `endTime` |
| 同一「星期+节次+地点」归并后的 `weekIndex` 集合 | `weeks`（自动归纳为 range/odd/even/list） |
| `customPlace` 或 `room.nameZh` | `location` |
| `teacherAssignmentList` | `teacher` |

用法：

```bash
# 试运行（只解析不写入）
node scripts/import-njpi.js --token <idToken> --dry-run --out njpi.json

# 正式导入（幂等：同名学期复用，课程整体 replace；--drop-demo 会删除示例学期）
node scripts/import-njpi.js --token <idToken> --drop-demo
```

> **安全提示**：`idToken` 是访问教务系统的凭据（内含学号与姓名，有效期约 30 天），
> 请勿提交到代码仓库或分享；失效后重新从教务课表页面复制 URL 即可。
> 脚本默认不持久化 token（通过命令行或环境变量 `NJPI_TOKEN` 传入）。

---

## 五、支持的导出方式

统一入口 **`GET /api/export?format=<格式>`**（需 `X-API-Key` 或 `?api_key=`）。

| format | Content-Type | 说明 |
|---|---|---|
| `json`（默认） | `application/json; charset=utf-8` | 完整结构化数据：学期 + 节次表 + 课程 + 节假日；加 `&include=occurrences` 额外展开每门课的全部上课日期 |
| `csv` | `text/csv; charset=utf-8` | 扁平表，带 UTF-8 BOM，Excel/WPS 双击即开不乱码 |
| `csv-grid` | `text/csv; charset=utf-8` | 周视图矩阵（行=节次，列=星期），便于打印张贴 |
| `xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 真 OOXML 工作簿，含 3 张工作表：课表 / 节假调休 / 学期与节次 |
| `ics` | `text/calendar; charset=utf-8; component=vevent; method=PUBLISH` | iCalendar 日历，**可直接导入或订阅** |

### 5.1 导出公共查询参数

| 参数 | 适用格式 | 默认 | 说明 |
|---|---|---|---|
| `termId` | 全部 | 当前最新学期 | 目标学期 |
| `download` | 全部 | `1` | `1` 带 `Content-Disposition: attachment`，`0` 则内联返回 |
| `pretty` | json | `1` | `0` 时压缩 JSON |
| `include` | json | — | `occurrences` 时展开全部上课日期 |
| `mode` | ics | `recurrence` | `recurrence`（RRULE+EXDATE）／`flat`（逐条事件） |
| `tz` | ics | `floating` | `floating`（浮动本地时间）／`tzid`（输出 VTIMEZONE+`TZID=`） |
| `remind` | ics | `15` | 提前提醒分钟数，`0`=不生成 VALARM |
| `title` | ics | `{name}` | 事件标题模板，占位符 `{name}` `{teacher}` `{location}` `{class}` `{note}` |

### 5.2 JSON 导出数据结构

```json
{
  "version": 1,
  "exportedAt": "2026-10-09T02:50:00.000Z",
  "generator": "student-timetable-system/1.0",
  "term": {
    "id": "term_8e1d70dccb9dfd16",
    "name": "2026-2027学年 秋季学期",
    "startDate": "2026-09-07",
    "weeks": 20,
    "periods": [{ "index": 1, "name": "第一节", "startTime": "08:00", "endTime": "08:45" }],
    "subscriptionToken": "EViYjuC8iqlSCDMa"
  },
  "courses": [
    {
      "id": "c_feab6f640db3a02e",
      "termId": "term_8e1d70dccb9dfd16",
      "name": "高等数学A（上）",
      "teacher": "张伟",
      "location": "教三-301",
      "dayOfWeek": 1,
      "dayLabel": "周一",
      "startPeriod": 1,
      "endPeriod": 2,
      "startTime": "08:00",           // 由节次表推导
      "endTime": "09:40",
      "weeks": { "mode": "range", "start": 1, "end": 16 },
      "weeksText": "1-16周",
      "className": "计科2301",
      "credit": 5,
      "note": "",
      "color": "#4F7CF7",
      "createdAt": "2026-10-09T02:50:00.000Z",
      "updatedAt": "2026-10-09T02:50:00.000Z"
    }
  ],
  "holidays": [
    { "id": "h_xxx", "termId": "term_xxx", "date": "2026-10-05", "type": "holiday", "name": "国庆节假期", "targetDayOfWeek": null }
  ]
}
```

> 该结构可被 `POST /api/import` **原样回灌**（幂等），用于系统间迁移或备份还原。

---

## 六、REST API 一览

> 除 `GET /api/health` 与 `/ics/:token.ics` 外，**所有 `/api/**` 接口均需鉴权**：
> 请求头 `X-API-Key: <KEY>` 或 `Authorization: Bearer <KEY>` 或查询参数 `?api_key=<KEY>`。
> 全接口已开放 CORS 并处理 `OPTIONS` 预检。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（免鉴权） |
| GET | `/api/schema` | 字段字典 + JSON Schema + 枚举值 |
| GET | `/api/meta` | 服务元信息与全部订阅地址 |
| GET / POST | `/api/terms` | 学期列表 / 新建 |
| GET / PUT / DELETE | `/api/terms/:id` | 学期详情 / 更新 / 删除（级联清除课程与节假日） |
| POST | `/api/terms/:id/token` | 轮换日历订阅令牌 |
| GET | `/api/courses` | 课程列表，支持 `termId` `dayOfWeek` `teacher` `q` 过滤 |
| POST | `/api/courses` | 新建课程，**支持单条或数组批量** |
| GET / PUT / DELETE | `/api/courses/:id` | 课程详情 / 更新 / 删除 |
| POST | `/api/courses/bulk-delete` | 批量删除 `{"ids":[...]}` |
| GET / POST | `/api/holidays` | 节假日列表 / 新增（支持数组） |
| PUT / DELETE | `/api/holidays/:id` | 更新 / 删除 |
| GET | `/api/timetable` | 周视图，`?termId=&week=` |
| GET | `/api/stats` | 统计信息 |
| GET | `/api/export` | 导出（见第五节） |
| GET | `/api/export/template` | 下载导入模板 `?format=csv\|xlsx` |
| POST | `/api/import` | 导入（见第四节） |
| GET | `/api/subscription` | 查询当前学期的日历订阅地址 |
| **GET** | **`/ics/:token.ics`** | **公开日历订阅地址（免鉴权）** |
| GET | `/api/pub/calendar/:token.ics` | 同上，等价别名 |

**统一响应约定**：成功 `{ ok:true, ... }`；失败 `{ ok:false, error:"描述", errors?:[...] }`（HTTP 4xx/5xx）。常见状态码：`201` 创建成功、`400` 参数校验失败、`401` 未鉴权、`404` 资源不存在、`422` 导入存在行级错误。

<details>
<summary>示例：批量创建课程</summary>

```http
POST /api/courses
X-API-Key: sk_xxx
Content-Type: application/json

[
  { "termId": "term_xxx", "name": "高等数学A", "teacher": "张伟", "location": "教三-301",
    "dayOfWeek": 1, "startPeriod": 1, "endPeriod": 2, "weeks": "1-16周", "credit": 5 },
  { "termId": "term_xxx", "name": "数据结构", "dayOfWeek": 3,
    "startPeriod": 3, "endPeriod": 4, "weeks": { "mode": "even", "start": 2, "end": 16 } }
]
```

```json
{ "ok": true, "count": 2, "items": [{ "id": "c_xxx", "...": "..." }] }
```
</details>

---

## 七、导出到小米手机日历（重点）

### 7.1 调用方式

系统提供**两个等价的日历导出接口**，区别仅在于是否需要 API Key：

| 用途 | 地址 | 鉴权 |
|---|---|---|
| **① 订阅型（推荐，手机自动同步）** | `GET /ics/{token}.ics` | 无需鉴权，URL 中 token 即凭据 |
| ② 下载型（一次性导入） | `GET /api/export?format=ics&termId=xxx` | 需 `X-API-Key` |

获取 / 刷新地址：

```http
GET /api/subscription?termId=term_xxx
X-API-Key: sk_xxx
```

```json
{
  "ok": true,
  "termId": "term_xxx",
  "termName": "2026-2027学年 秋季学期",
  "token": "EViYjuC8iqlSCDMa",
  "urls": {
    "subscribe":    "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics",
    "subscribeApi": "http://172.16.0.76:3000/api/pub/calendar/EViYjuC8iqlSCDMa.ics",
    "download":     "http://172.16.0.76:3000/api/export?format=ics&termId=term_xxx&api_key=<API_KEY>",
    "recurrence":   "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics?mode=recurrence&tz=floating",
    "flat":         "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics?mode=flat"
  }
}
```

**订阅地址支持的参数**（拼在 URL 后即可，无需改造 App）：

| 参数 | 取值 | 用途 |
|---|---|---|
| `mode` | `recurrence`（默认）/ `flat` | 重复事件 vs 逐条事件（详见 7.4） |
| `tz` | `floating`（默认）/ `tzid` | 浮动本地时间 vs 带 VTIMEZONE 的标准时区 |
| `remind` | 分钟数 | 覆盖默认提醒时长，`0` 关闭 |
| `title` | 模板串 | 如 `title={name}（{teacher}）` |
| `download` | `1` | 加 `Content-Disposition` 触发下载而非订阅 |

示例调用：

```bash
curl -i "http://172.16.0.76:3000/ics/EViYjuC8iqlSCDMa.ics?mode=recurrence&remind=20"
```

### 7.2 返回格式

```
HTTP/1.1 200 OK
Content-Type: text/calendar; charset=utf-8; component=vevent; method=PUBLISH
Cache-Control: no-cache, no-store, must-revalidate
Content-Language: zh-CN
```

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WorkBuddy//StudentTimetable 1.0//CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:2026-2027学年 秋季学期 课表
X-WR-TIMEZONE:Asia/Shanghai
X-WR-CALDESC:2026-2027学年 秋季学期 自动同步课表，共 11 门课
 程
REFRESH-INTERVAL;VALUE=DURATION:PT1H
X-PUBLISHED-TTL:PT1H
BEGIN:VEVENT
UID:c_feab6f640db3a02e@timetable.local
DTSTAMP:20261008T194007Z
DTSTART:20260907T080000
DTEND:20260907T094000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20261221T094000
SUMMARY:高等数学A（上）
LOCATION:教三-301
DESCRIPTION:课程:高等数学A（上）\n教师:张伟\n班级:计科2301\n周次:1-1
 6周\n节次:第1-2节\n地点:教三-301\n学分:5
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
EXDATE:20261005T080000
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
DESCRIPTION:上课提醒:高等数学A（上）
END:VALARM
END:VEVENT
END:VCALENDAR
```

语义映射：

| 课表概念 | ICS 映射 |
|---|---|
| 课程 | `VEVENT`（`SUMMARY`=课程名，可用 `title` 模板自定义） |
| 教师 / 班级 / 周次 / 学分数 | `DESCRIPTION` 多行文本 |
| 上课地点 | `LOCATION` |
| 每周重复 | `RRULE:FREQ=WEEKLY;INTERVAL=n;BYDAY=xx;UNTIL=…` |
| 单周 / 双周 | `INTERVAL=2` 且起始日期落在对应周（`1-16周双` 起始周为偶数周） |
| 离散周次 | 由 `INTERVAL=1` + `EXDATE` 剔除不上课的周 |
| **放假** | **`EXDATE`**（日历端对应日期自动不显示） |
| **调休补课** | **独立的单次 `VEVENT`**，`UID` 带 `-mk-日期` 后缀 |
| 提前提醒 | `VALARM` / `TRIGGER:-PT15M` / `ACTION:DISPLAY` |

### 7.3 小米日历兼容性要求（已在实现中逐项落实）

| # | 要求 | 本系统实现 |
|---|---|---|
| 1 | **免鉴权可访问** | `/ics/:token.ics` 走独立白名单路由，不返回 `401 WWW-Authenticate`，避免小米日历无法完成挑战式认证 |
| 2 | **正确的 MIME** | `text/calendar; charset=utf-8; component=vevent; method=PUBLISH`，兼容较挑剔的解析器 |
| 3 | **UTF-8 无 BOM** | Response body 为纯 UTF-8，**不写 BOM**（BOM 会导致 `BEGIN:VCALENDAR` 无法识别） |
| 4 | **CRLF 行尾 + 75 字节折叠** | 严格 RFC 5545 §3.1；折叠按 UTF-8 字节切分且不切断中文字符，续行以单个空格开头（已由测试断言） |
| 5 | **UID 稳定幂等** | UID = `{课程id}@{域}`，不随内容变化；重复的增出不穷会导致小米日历每次刷新都重建事件与提醒 |
| 6 | **勿用 TZID（默认）** | 默认输出**浮动本地时间**（`DTSTART:20260907T080000`，无 `TZID`/`Z`），规避国产 ROM `TZID:Asia/Shanghai` 解析不全导致的 **±8 小时偏移**；需要标准写法时用 `?tz=tzid` 切换（会附带 `VTIMEZONE`） |
| 7 | **单一 RRULE、避免 RDATE 泛滥** | 默认 `recurrence` 模式仅输出一条 `RRULE` + 少量 `EXDATE`，体积约为逐条展开的 1/7；对本学期 143 次课仅生成 13 个 VEVENT |
| 8 | **不使用过于复杂的规则** | 不使用 `BYSETPOS`/多个 `BYDAY`/`RSCALE`；选修/实验等非规律课程自动降级为独立事件 |
| 9 | **必须含 DTSTAMP** | 使用 `course.updatedAt`，内容未变时保持不变，避免客户端误判为已修改而重刷 |
| 10 | **缓存控制** | `Cache-Control: no-cache` + `REFRESH-INTERVAL:PT1H` + `X-PUBLISHED-TTL:PT1H`，提示客户端按小时刷新 |
| 11 | **URL 稳定性** | 令牌 16 位 `base64url`，不含特殊字符，便于手动输入；泄露后可 `POST /api/terms/:id/token` 立即轮换 |
| 12 | **网络可达** | 手机必须能与运行服务的机器互通（同一局域网 / 内网穿透 / 公网域名）；建议配置 `TIMETABLE_PUBLIC_BASE_URL` 固定为你希望的地址 |
| 13 | **HTTPS 可选** | 局域网 `http://` 小米日历可直接订阅；公网场景建议 Nginx 反代 + HTTPS |

### 7.4 recurrence 与 flat 模式如何选择

| | `mode=recurrence`（默认） | `mode=flat` |
|---|---|---|
| 内容 | 每门课 1 个重复事件 + EXDATE | 每一次上课 1 个独立事件 |
| 体积（本示例学期 143 课次） | 13 个 VEVENT / ~7.6 KB | 143 个 VEVENT / ~35 KB |
| 修改后同步 | 立即生效 | 立即生效 |
| 兼容性 | 依赖 `RRULE`+`EXDATE` 支持 | **最强**，任何日历 App 都能正确显示 |
| 适用 | 日常使用 / 流量敏感 | 个别机型出现「放假日期仍显示」或重复事件时改用 |

> 排查建议：若小米日历出现**时间偏移 8 小时**→改用默认 `floating`（已是默认）；出现**放假日期仍显示课程**→改用 `?mode=flat`；出现**提醒重复/丢失**→调整 `remind` 参数并重新添加订阅。

### 7.5 小米手机操作步骤

1. 电脑与手机连到**同一 Wi-Fi**，关闭/放行电脑防火墙对应端口（或改用内网穿透 / 公网域名）。
2. 打开管理端 → 右上角「**日历订阅**」→ 复制订阅地址。
3. 手机「**日历**」App → 右上角 `⋮` → **设置** → **日历订阅**（或「添加订阅日历」）→ 粘贴地址 → 确定。
4. 返回日历 → 右上角 `⋮` → 勾选刚出现的日历名称。
5. 下拉刷新可立即拉取；否则约 1 小时自动同步。

> 备选方案：管理端点「下载 .ics 文件」，或把 `/api/export?format=ics` 的下载文件通过 QQ/微信传到手机后用「日历」App 打开导入（一次性导入，不会自动更新）。

---

## 八、目录结构

```
timetable/
├── package.json
├── README.md                        # 本文档
├── LICENSE                          # MIT
├── .gitignore
├── src/
│   ├── server.js        # HTTP 服务、路由、鉴权、CORS、静态资源
│   ├── store.js         # JSON 持久化（含配置与 API Key）
│   ├── model.js         # 字段定义、校验、周次规则、上课实例展开
│   ├── importers.js     # JSON / CSV / ICS / URL 导入
│   ├── exporters.js     # JSON / CSV / CSV周视图 / XLSX / ICS 导出
│   ├── ics.js           # RFC5545 生成器（折叠、RRULE/EXDATE、VALARM）
│   ├── xlsx.js          # 自实现 OOXML 写入器（含 CRC32/ZIP 打包）
│   └── util.js          # 日期/CSV/CRC32 等工具
├── public/
│   ├── index.html       # 管理端页面（响应式，适配手机）
│   ├── app.js           # 管理端逻辑（周视图 / 日程列表双模式）
│   └── style.css        # 样式（含 900 / 640 / 400px 断点）
├── docs/
│   ├── xiaomi-calendar-sync.md   # 小米日历同步专项说明（含排障表）
│   └── sample-timetable.ics      # 示例输出
├── scripts/
│   ├── seed.js          # 示例数据
│   ├── smoke.js         # 端到端测试（78 项）
│   ├── import-njpi.js   # 教务系统直连导入（jwxt.njpi.edu.cn）
│   └── open-firewall.ps1# Windows 防火墙放行/回收端口
└── data/                # 运行时数据（db.json、config.json，已 gitignore）
```

---

## 九、测试与验证

```bash
npm test      # node scripts/smoke.js
```

覆盖：鉴权、学期 CRUD 与校验、Monday 对齐、课程 CRUD/批量/过滤、节假日语义、周视图与放假剔除、统计、**五种导出格式**、ICS 的 CRLF 与 75 字节折叠/RRULE/EXDATE/VALARM/VTIMEZONE、JSON/CSV/ICS/URL 四类导入与三种冲突策略、订阅地址与令牌轮换、级联删除、静态资源。当前结果：**通过 78 项，失败 0 项**。

---

## 十、已知约束

- 存储为单文件 JSON（`data/db.json`），适合单机/班级规模使用；生产环境如需多写并发，建议替换 `src/store.js` 为数据库实现（保持同名方法即可）。
- ICS 导入不支持全天事件（大学课表无此场景），会被跳过并在 `details` 中说明。
- 若同一时段在同一天安排多门课，管理端会自动横向分列显示，不做冲突校验（教务场景允许选修冲突）。
