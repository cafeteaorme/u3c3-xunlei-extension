# u3c3 搜索·迅雷版（Chrome 插件）

与 [u3c3 搜索](https://github.com/cafeteaorme/u3c3-search-extension)（UGOS 下载中心版）并存的独立插件：
搜索逻辑相同，**下载走 NAS 上的迅雷**（cnk3x/xunlei Docker，超级会员加速）。

点击插件图标 → 读取标签页标题识别番号 → u3c3.com 搜索 → 点结果复制磁力并弹出
**文件选择界面**（迅雷云端解析，勾选后才创建任务）→ 状态区/角标跟踪进度。

## 与 UGOS 版的差异

| | UGOS 版 | 迅雷版（本插件） |
|---|---|---|
| 下载引擎 | UGOS 下载中心（qB 内核，纯 P2P） | 迅雷（会员高速通道/离线加速） |
| 文件选择 | 添加→暂停→逐文件排除（逆向拼装） | **原生支持**：云端解析→勾选→建任务 |
| 取消 | 需删除已建任务 | 确认前不建任务，取消零残留 |
| 任务匹配 | 已完成列表按名字匹配 | 任务列表带 info_hash，精确匹配 |

## 部署前提（一次性）

1. **迅雷容器**（已部署在 `192.168.5.4`，UGOS Docker 项目名 `xunlei`，端口 2345，
   下载目录 `/volume1/迅雷下载/A-xunlei`；部署脚本 `../nas-dl/deploy_xunlei.py`）
2. **扫码登录**：浏览器打开 `http://192.168.5.4:2345` → 迅雷 App 扫码登录
   超级会员账号。登录态存于 `/volume1/docker/xunlei/data`，容器重启不丢

## 安装

`chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选本目录。
与 UGOS 版可同时安装（名称/图标不同）。

## 使用

- 打开标题带番号的页面 → 点图标 → 结果列表
- **点结果 → 复制磁力 + 文件选择界面**：勾选要下的文件（云端解析，秒出）→
  「确认下载」→ 任务进迅雷；「取消」不产生任何任务
- 弹窗顶部「迅雷下载」状态区：下载中=琥珀 / 已完成=绿 / 错误=红
- 角标：进行中→橙色数字；完成未读→橙色 ok；看过即清
- 只跟踪本插件发起的任务（infohash 注册表）

## 文件结构

```
u3c3-xunlei/
├── manifest.json    # MV3：activeTab/clipboardWrite/storage/alarms + u3c3.com 与容器域名
├── config.js        # 容器地址（http://192.168.5.4:2345）
├── xlauth.js        # pan-auth token（面板 HTML 里的 uiauth JWT 提取）
├── xunlei.js        # 迅雷客户端 + 任务注册表（浏览器/Node 共用）
├── core.js          # u3c3 番号识别 + 结果解析（与 UGOS 版同源）
├── popup.html/css/js、background.js
├── make_icons.mjs   # 橙色闪电图标生成（纯 Node 标准库）
└── test/            # xunlei 单测 + e2e-xl 真机端到端
```

## 测试

```
node test/xunlei.test.mjs    # 纯函数 35 项
node test/e2e-xl.mjs         # 真机 e2e（需已扫码登录；会建测试任务并自动清理）
```

## 迅雷 API 协议备忘（2026-09-21 实测，迅雷 3.23.5 / cnk3x/xunlei）

- 入口：`http://<NAS>:2345/webman/3rdparty/pan-xunlei-com/index.cgi/`
- 鉴权：面板 HTML 内嵌 `function uiauth(value){ return "<JWT>" }`（≥3.21.0 版本，
  有效期约 3.4 天，正则提取即可）；每请求带 `?pan_auth=<JWT>` + `pan-auth` 头；
  云端端点另需**账号已扫码登录**，否则返回 `{"error":"unauthenticated",
  "error_description":"...refresh token not found"}`
- 磁力解析：`POST drive/v1/resource/list {urls}` → `list.resources[0]`（含
  `dir.resources[]` 子文件与 `file_index`）——云端完成，热门资源秒出
- 建任务：`POST drive/v1/task`，`params.sub_file_index` 选文件：
  单文件 `'--1,'`；多文件 `'0-2,5-5,'`（区间，尾随逗号）
- 任务列表：`GET drive/v1/tasks?filters={"type":{"in":"user#download-url,user#download"}}&space=<target>`
  （`target` 来自 `POST device/info/watch`；行内 `params.info_hash` 可精确匹配）
- 暂停：`POST method/patch/drive/v1/task {set_params:{spec:'{"phase":"pause"}'}}`
- 删除：`POST method/delete/drive/v1/tasks?space=<target>&task_ids=<id>`

## 已知限制

- 未登录迅雷账号时，解析/下载会提示去 `http://192.168.5.4:2345` 扫码
- 迅雷会员加速对冷门资源效果有限；部分敏感资源可能被迅雷云端拦截
- 云端解析偶发慢（冷门磁力），60s 超时自动提示
