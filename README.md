# stockheatmap

按申万一级行业展示 A 股市场热力图的轻量级 Node.js 应用。

当前实现是一个无构建步骤的单页应用：
- 后端使用原生 Node.js HTTP server 提供 API 和静态文件
- 前端使用原生 HTML/CSS/JavaScript
- 热力图布局使用 `d3-hierarchy` 的 treemap
- 数据来源是同花顺 iFinD HTTP API

## 当前口径

- 页面展示的是“按申万一级行业分组的市场热力图”
- 当前默认样本空间不是全 A，而是一个样本指数成分股集合
- 默认样本指数为 `000300.SH`，即沪深 300
- 样本指数代码可通过 `IFIND_SAMPLE_INDEX_CODE` 覆盖
- 样本指数名称可通过 `IFIND_SAMPLE_INDEX_NAME` 显式指定；未指定时会自动向 iFinD 查询指数简称
- 行业权重来自样本股在权重基准日的流通市值
- 行业涨跌幅来自对应申万一级行业指数的涨跌幅
- 页面 drilldown 到行业后，显示的是该行业内样本股热力图

这意味着：
- 总览图的面积强调“行业对市场的贡献度”，不是单纯市值
- 总览图的行业收益口径和行业内样本股加权收益不是同一个概念
- 审计导出里同时保留了行业指数收益和样本股加权收益，便于核对

## 功能概览

- 时间区间：`latest`、`1w`、`1m`、`ytd`、`1y`、`custom`
- 最新模式支持自动刷新
- 支持全屏
- 支持行业 drilldown 到个股
- 支持导出 latest 审计 CSV

## 快速启动

### 1. 准备凭证

服务端启动时会自动读取仓库根目录的 `.env`。

你可以任选一种方式提供 `THS_REFRESH_TOKEN`：

方式一：写入 `.env`

```zsh
echo "THS_REFRESH_TOKEN=your_ifind_refresh_token" >> .env
```

方式二：在当前 shell 中导出

```zsh
export THS_REFRESH_TOKEN='your_ifind_refresh_token'
```

如果两处都设置了同名变量，以 shell 环境变量为准。

### 2. 可选环境变量

仓库中的 [`.env.example`](.env.example) 提供可直接参考的配置示例。

常用可选项：

```zsh
PORT=3000
IFIND_DEBUG=0
IFIND_SAMPLE_INDEX_CODE=000300.SH
# 可选；不填时自动向 iFinD 查询指数简称
# IFIND_SAMPLE_INDEX_NAME=沪深300
```

### 3. 启动服务

```zsh
cd /Users/chun/projects/stockheatmap
node server.js
```

启动后访问：

- [http://localhost:3000](http://localhost:3000)

如果改了端口，就用对应的端口访问。

## 可用脚本

定义见 [`package.json`](package.json)：

```zsh
node server.js
node scripts/build-sector-db.js
```

或：

```zsh
npm start
npm run build:sector-db
```

## 数据流

### 1. 解析时间区间

服务端会先把用户选择的区间解析成：
- `startDate`
- `endDate`
- `effectiveStartDate`
- `effectiveEndDate`
- `weightAnchorDate`

其中：
- `effectiveStartDate` / `effectiveEndDate` 是实际交易日
- `weightAnchorDate` 是有效起始日前一个交易日，用于取样本股与流通市值

### 2. 获取样本指数成分股

服务端按 `weightAnchorDate` 从 iFinD 获取样本指数成分股，因此样本股不是写死的，会随查询日期变化。

样本指数名称的显示规则：
- 如果配置了 `IFIND_SAMPLE_INDEX_NAME`，优先使用该值
- 如果只配置了 `IFIND_SAMPLE_INDEX_CODE`，服务端会调用 iFinD 的 `ths_index_short_name_index` 自动补全简称
- 如果自动查询失败，则回退显示指数代码

### 3. 映射到申万一级行业

行业映射优先使用仓库中的 [`data/sw-sector-map.json`](data/sw-sector-map.json)。

当前行为：
- 先加载本地行业映射快照
- 如果当前样本股都能匹配到行业，则直接使用本地快照
- 如果存在缺失，并且本地快照落后于最新交易日，则重新抓取 31 个申万一级行业全部成分并覆盖本地快照

因此，行业映射不是每次启动都刷新，而是“本地快照优先，必要时增量更新到较新状态”。

### 4. 拉取计算所需数据

服务端会并行拉取：
- 样本股涨跌幅
- 申万一级行业指数涨跌幅
- 基准指数涨跌幅
- 样本股流通市值
- 样本股估值指标（PE / PB / DY）

### 5. 组装前端热力图数据

总览图：
- 面积来自 `|行业贡献度|^0.65`
- 颜色按行业涨跌幅着色
- 行业块内展示该行业贡献度靠前的样本股

行业 drilldown：
- 展示该行业内样本股热力图
- 面积来自个股对该行业贡献度的缩放值
- 可显示 PE / PB / DY

## API

### `GET /api/health`

健康检查。

### `POST /api/heatmap`

返回热力图数据。

示例请求：

```json
{
  "preset": "latest"
}
```

或：

```json
{
  "preset": "custom",
  "startDate": "2026-03-01",
  "endDate": "2026-03-31"
}
```

### `POST /api/export-audit-csv`

导出 latest 审计 CSV。

当前仅支持：

```json
{
  "preset": "latest"
}
```

导出文件会写到 `data/exports/`，但该目录当前已在 `.gitignore` 中，不参与版本管理。

## 关键文件

- [`server.js`](server.js)
  后端入口、iFinD 客户端、交易日处理、行业映射、热力图组装、CSV 导出

- [`public/index.html`](public/index.html)
  页面结构

- [`public/app.js`](public/app.js)
  前端状态管理、数据请求、treemap 渲染、drilldown、自动刷新

- [`public/styles.css`](public/styles.css)
  页面样式

- [`scripts/build-sector-db.js`](scripts/build-sector-db.js)
  手动重建申万一级行业映射快照

- [`data/sw-sector-map.json`](data/sw-sector-map.json)
  本地行业映射快照

- [`iFinD.md`](iFinD.md)
  当前项目用到的 iFinD 接口说明与示例

- [`.env.example`](.env.example)
  本地环境变量示例

## 缓存与性能

服务端内存中维护多类缓存：
- 交易日区间缓存
- 交易日偏移缓存
- 样本成分缓存
- 流通市值缓存
- 估值缓存
- 收益率缓存
- 热力图结果缓存

特点：
- `latest` 模式缓存 TTL 更短
- 历史区间缓存 TTL 更长
- 有后台定时清理
- 大于阈值的 JSON 响应会自动启用 `br` 或 `gzip` 压缩

## 调试与输出

- `IFIND_DEBUG=1` 时会输出调试日志
- 默认调试日志路径是 `data/ifind-debug.log`
- 审计导出目录是 `data/exports/`

当前 `.gitignore` 已忽略：
- `.env`
- `node_modules`
- `.DS_Store`
- `data/ifind-debug.log`
- `data/exports/`

## 已知边界

- 当前“市场”口径默认是样本指数成分股，不是全 A
- 行业映射依赖本地快照和 iFinD 刷新逻辑，不是每次请求都全量重建
- latest 模式的收益率统一走实时行情接口
- 审计导出目前只支持 `latest`
- 仓库没有测试框架和自动化测试
- 仓库没有构建流程，前后端都直接运行源码

## 接手建议

如果后续要继续开发，建议优先从以下入口阅读：

1. [`server.js`](server.js)
2. [`public/app.js`](public/app.js)
3. [`iFinD.md`](iFinD.md)
4. [`scripts/build-sector-db.js`](scripts/build-sector-db.js)

如果要先确认程序运行链路，最短路径是：

1. 在 `.env` 或当前 shell 中设置 `THS_REFRESH_TOKEN`
2. 启动 `node server.js`
3. 打开本地页面
4. 从 `POST /api/heatmap` 开始顺着服务端数据流阅读
