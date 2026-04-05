import { createServer } from "node:http";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { URL } from "node:url";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";

loadEnvFile(join(process.cwd(), ".env"));

const DEFAULT_SAMPLE_INDEX = { code: "000300.SH", name: "沪深300" };
const PORT = Number(process.env.PORT || 3000);
const DEBUG = process.env.IFIND_DEBUG === "1";
const API_BASE = "https://quantapi.51ifind.com/api/v1";
const TRADE_MARKET_CODE = "212001"; // 上交所，A股交易日历与深交所一致
const SAMPLE_INDEX_CODE = process.env.IFIND_SAMPLE_INDEX_CODE || DEFAULT_SAMPLE_INDEX.code;
const SAMPLE_INDEX_NAME_OVERRIDE = String(process.env.IFIND_SAMPLE_INDEX_NAME || "").trim();
const SAMPLE_INDEX_FALLBACK_NAME = SAMPLE_INDEX_CODE === DEFAULT_SAMPLE_INDEX.code
  ? DEFAULT_SAMPLE_INDEX.name
  : SAMPLE_INDEX_CODE;
const REALTIME_RETURN_INDICATOR = "changeRatio";
const FLOAT_MV_INDICATOR = "ths_current_mv_stock";
const BENCHMARK_INDEXES = [
  { code: "000300.SH", name: "沪深300" },
  { code: "399006.SZ", name: "创业板指" }
];
const DATA_DIR = join(process.cwd(), "data");
const EXPORT_DIR = join(DATA_DIR, "exports");
const SECTOR_DB_FILE = join(DATA_DIR, "sw-sector-map.json");
const DEBUG_LOG_FILE = process.env.IFIND_DEBUG_LOG_FILE || join(DATA_DIR, "ifind-debug.log");
const CACHE = {
  tradeRange: new Map(),
  tradeOffset: new Map(),
  sampleMembers: new Map(),
  floatMv: new Map(),
  valuations: new Map(),
  returns: new Map(),
  heatmap: new Map()
};
const CACHE_TTL = {
  tradeDates: 24 * 60 * 60 * 1000,
  sampleMembers: 24 * 60 * 60 * 1000,
  floatMv: 24 * 60 * 60 * 1000,
  valuations: 24 * 60 * 60 * 1000,
  returnsLatest: 60 * 1000,
  returnsHistory: 24 * 60 * 60 * 1000,
  heatmapLatest: 10 * 1000,
  heatmapHistory: 24 * 60 * 60 * 1000
};
const CACHE_MAX_ENTRIES = {
  tradeRange: envInt("CACHE_MAX_TRADE_RANGE", 5000),
  tradeOffset: envInt("CACHE_MAX_TRADE_OFFSET", 5000),
  sampleMembers: envInt("CACHE_MAX_SAMPLE_MEMBERS", 512),
  floatMv: envInt("CACHE_MAX_FLOAT_MV", 1500),
  valuations: envInt("CACHE_MAX_VALUATIONS", 64),
  returns: envInt("CACHE_MAX_RETURNS", 6000),
  heatmap: envInt("CACHE_MAX_HEATMAP", 1500)
};
const CACHE_SWEEP_INTERVAL_MS = envInt("CACHE_SWEEP_INTERVAL_MS", 10 * 60 * 1000);
const JSON_COMPRESS_MIN_BYTES = envInt("JSON_COMPRESS_MIN_BYTES", 2048);

const INDEXES = [
  ["801010.SL", "农林牧渔"],
  ["801030.SL", "基础化工"],
  ["801040.SL", "钢铁"],
  ["801050.SL", "有色金属"],
  ["801080.SL", "电子"],
  ["801110.SL", "家用电器"],
  ["801120.SL", "食品饮料"],
  ["801130.SL", "纺织服饰"],
  ["801140.SL", "轻工制造"],
  ["801150.SL", "医药生物"],
  ["801160.SL", "公用事业"],
  ["801170.SL", "交通运输"],
  ["801180.SL", "房地产"],
  ["801200.SL", "商贸零售"],
  ["801210.SL", "社会服务"],
  ["801230.SL", "综合"],
  ["801710.SL", "建筑材料"],
  ["801720.SL", "建筑装饰"],
  ["801730.SL", "电力设备"],
  ["801740.SL", "国防军工"],
  ["801750.SL", "计算机"],
  ["801760.SL", "传媒"],
  ["801770.SL", "通信"],
  ["801780.SL", "银行"],
  ["801790.SL", "非银金融"],
  ["801880.SL", "汽车"],
  ["801890.SL", "机械设备"],
  ["801950.SL", "煤炭"],
  ["801960.SL", "石油石化"],
  ["801970.SL", "环保"],
  ["801980.SL", "美容护理"]
].map(([code, name]) => ({ code, name }));

const PUBLIC_DIR = join(process.cwd(), "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

class IFindClient {
  constructor() {
    this.accessToken = "";
    this.refreshToken = process.env.THS_REFRESH_TOKEN || "";
  }

  async post(path, payload, retry = true, attempt = 1) {
    if (!this.accessToken && this.refreshToken) {
      await this.refreshAccessToken();
    }
    const t0 = DEBUG ? Date.now() : 0;
    let resp;
    try {
      resp = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.accessToken ? { access_token: this.accessToken } : {})
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      if (DEBUG) {
        debugWarn(
          "[iFinD-retry]",
          path,
          `attempt=${attempt}`,
          "reason=fetch_error",
          `message=${error?.message || String(error)}`,
          attempt < 4 ? `next_wait=${500 * attempt}ms` : "no_more_retries"
        );
      }
      if (attempt < 4) {
        await sleep(500 * attempt);
        return this.post(path, payload, retry, attempt + 1);
      }
      throw error;
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (DEBUG) {
        debugWarn(
          "[iFinD-retry]",
          path,
          `attempt=${attempt}`,
          "reason=non_json",
          `status=${resp.status}`,
          attempt < 4 ? `next_wait=${500 * attempt}ms` : "no_more_retries",
          `body_head=${JSON.stringify(text.slice(0, 120))}`
        );
      }
      if (attempt < 4) {
        await sleep(500 * attempt);
        return this.post(path, payload, retry, attempt + 1);
      }
      throw new Error(`iFinD 返回非 JSON: ${text.slice(0, 120)}`);
    }

    if (resp.status === 429 && attempt < 4) {
      if (DEBUG) {
        debugWarn(
          "[iFinD-retry]",
          path,
          `attempt=${attempt}`,
          "reason=http_429",
          `next_wait=${400 * attempt}ms`
        );
      }
      await sleep(400 * attempt);
      return this.post(path, payload, retry, attempt + 1);
    }

    const tokenError = resp.status === 401 || data.errorcode === -101 || data.errorcode === -201;
    if (tokenError && retry && this.refreshToken) {
      if (DEBUG) {
        debugWarn(
          "[iFinD-retry]",
          path,
          `attempt=${attempt}`,
          "reason=token_error",
          `status=${resp.status}`,
          `errorcode=${data.errorcode ?? ""}`,
          "action=refresh_access_token"
        );
      }
      await this.refreshAccessToken();
      return this.post(path, payload, false, attempt);
    }

    if (!resp.ok || data.errorcode !== 0) {
      if (DEBUG) {
        debugWarn(
          "[iFinD-fail]",
          path,
          `attempt=${attempt}`,
          `status=${resp.status}`,
          `errorcode=${data.errorcode ?? ""}`,
          `errmsg=${JSON.stringify(data.errmsg ?? "")}`
        );
      }
      const detail = `${resp.status} ${data.errorcode ?? ""} ${data.errmsg ?? ""}`.trim();
      throw new Error(`iFinD 接口失败 (${path}): ${detail}`);
    }

    if (DEBUG) {
      debugLog("[iFinD]", path, `${Date.now() - t0}ms`, "ok", data.dataVol ?? "");
    }
    return data;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error("缺少 refresh token，请设置 THS_REFRESH_TOKEN 环境变量");
    }
    const resp = await fetch(`${API_BASE}/get_access_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: this.refreshToken })
    });
    const data = await resp.json();
    const token = data.access_token || data?.data?.access_token;
    if (!resp.ok || !token) {
      throw new Error(`刷新 access token 失败: ${data.errmsg || resp.status}`);
    }
    this.accessToken = token;
  }
}

const ifind = new IFindClient();
let sectorDbCache = null;
let sectorDbMeta = { effectiveDate: null, updatedAt: null };
let debugLogDirReady = false;
const runtimeMeta = {
  sampleIndexName: SAMPLE_INDEX_NAME_OVERRIDE || null,
  sampleIndexNamePending: null
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/heatmap") {
      const body = await readJsonBody(req);
      const result = await buildHeatmap(body || {});
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/export-audit-csv") {
      const body = await readJsonBody(req);
      const result = await exportAuditCsv(body || {});
      return sendJson(res, 200, result);
    }

    if (req.method === "GET") {
      return await serveStatic(url.pathname, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`Stock heatmap server running on http://localhost:${PORT}`);
  startCacheJanitor();
});

async function buildHeatmap(query) {
  const preset = String(query.preset || "latest");
  const customStart = query.startDate;
  const customEnd = query.endDate;
  const forceLatestRefresh = query.forceLatestRefresh === true && preset === "latest";

  const now = new Date();
  const today = shanghaiDateString(now);
  const range = await timed("resolveTradingRange", () => resolveTradingRange(preset, today, customStart, customEnd));
  const heatmapCacheKey = [
    range.preset,
    range.startDate,
    range.endDate,
    range.effectiveStartDate || "",
    range.effectiveEndDate || "",
    range.weightAnchorDate || "",
    range.hasTrades ? "1" : "0"
  ].join("|");
  const heatmapTtl = preset === "latest" ? CACHE_TTL.heatmapLatest : CACHE_TTL.heatmapHistory;
  if (forceLatestRefresh) {
    CACHE.heatmap.delete(heatmapCacheKey);
  }

  return cachedAsync(CACHE.heatmap, heatmapCacheKey, heatmapTtl, async () => {
    if (!range.hasTrades) {
      return buildNoTradeHeatmap(range);
    }
    return timed(`buildHeatmapFromResolvedRange(${range.preset})`, () =>
      buildHeatmapFromResolvedRange(range, { forceLatestRefresh })
    );
  });
}

async function exportAuditCsv(query) {
  const preset = String(query.preset || "latest");
  if (preset !== "latest") {
    throw new Error("当前仅支持导出 latest 审核 CSV");
  }

  const now = new Date();
  const today = shanghaiDateString(now);
  const range = await timed("resolveTradingRange", () => resolveTradingRange(preset, today, query.startDate, query.endDate));
  if (!range.hasTrades) {
    throw new Error("所选区间无交易日，无法导出 latest 审核 CSV");
  }

  const result = await timed(`buildHeatmapFromResolvedRange(${range.preset})`, () =>
    buildHeatmapFromResolvedRange(range, { includeAudit: true, forceLatestRefresh: false })
  );
  const audit = result.audit || {};

  await mkdir(EXPORT_DIR, { recursive: true });
  const stamp = fileStamp(new Date());
  const base = `latest-audit-${stamp}`;

  const files = [];
  files.push(await writeCsvExport(`${base}-meta.csv`, [
    {
      preset: result.range?.preset || "",
      startDate: result.range?.startDate || "",
      endDate: result.range?.endDate || "",
      effectiveStartDate: result.range?.effectiveStartDate || "",
      effectiveEndDate: result.range?.effectiveEndDate || "",
      weightAnchorDate: result.range?.weightAnchorDate || "",
      sampleMemberCount: audit.sampleMemberCount ?? "",
      mappedSampleCount: audit.mappedSampleCount ?? "",
      unmappedCount: audit.unmappedCount ?? "",
      totalFloatMv: audit.totalFloatMv ?? "",
      sampleSectorProxyReturnPct: audit.sampleSectorProxyReturnPct ?? "",
      sampleConstituentWeightedReturnPct: audit.sampleConstituentWeightedReturnPct ?? "",
      note: "股票贡献=起始前一交易日流通市值权重*个股区间收益率；行业贡献=行业权重*申万一级行业指数收益率"
    }
  ]));

  files.push(await writeCsvExport(`${base}-stocks.csv`, (audit.stocks || []).map((x) => ({
    code: x.code,
    name: x.name,
    sectorCode: x.sectorCode,
    sectorName: x.sectorName,
    floatMv_weightAnchorDate: x.floatMv,
    weightInMarket: x.weightInMarket,
    stockReturnPct: x.stockReturnPct,
    stockContributionPctPoint: x.stockContributionPctPoint
  }))));

  files.push(await writeCsvExport(`${base}-sectors.csv`, (audit.sectorsRaw || []).map((x) => ({
    sectorCode: x.sectorCode,
    sectorName: x.sectorName,
    sectorFloatMv_sample: x.sectorFloatMv,
    sectorWeightFraction: x.sectorWeightFraction,
    sectorIndexReturnPct: x.sectorIndexReturnPct,
    sectorContributionPctPoint: x.sectorContributionPctPoint,
    sampleConstituentWeightedReturnPct: x.sampleConstituentWeightedReturnPct,
    sampleStockCount: x.sampleStockCount
  }))));

  files.push(await writeCsvExport(`${base}-benchmarks.csv`, (audit.benchmarksRaw || []).map((x) => ({
    code: x.code,
    name: x.name,
    returnPct: x.returnPct
  }))));

  files.push(await writeCsvExport(`${base}-excluded-stocks.csv`, (audit.excludedStocks || []).map((x) => ({
    code: x.code,
    name: x.name,
    reason: x.reason
  }))));

  return {
    ok: true,
    exportedAt: shanghaiDateString(new Date()),
    range: result.range,
    files
  };
}

async function buildHeatmapFromResolvedRange(range, options = {}) {
  const includeAudit = options.includeAudit === true;
  const forceLatestRefresh = options.forceLatestRefresh === true;
  const sampleIndexName = await getSampleIndexName();
  const sampleMembers = await timed("fetchSampleMembers", () => fetchSampleMembers(range.weightAnchorDate));
  if (!sampleMembers.length) {
    throw new Error(`未获取到样本指数成分股: ${sampleIndexName} (${SAMPLE_INDEX_CODE})`);
  }

  const sectorByStock = await timed("getSectorMapForSample", () => getSectorMapForSample(sampleMembers, range.weightAnchorDate));
  const stockMap = new Map();
  const unmappedMembers = [];
  for (const member of sampleMembers) {
    const sectorInfo = sectorByStock.get(member.code);
    if (!sectorInfo) {
      unmappedMembers.push({
        code: member.code,
        name: member.name,
        reason: "missing_sector_map"
      });
      continue;
    }
    stockMap.set(member.code, {
      code: member.code,
      name: member.name,
      sectorCode: sectorInfo.sectorCode,
      sectorName: sectorInfo.sectorName
    });
  }

  const allCodes = Array.from(stockMap.keys());
  if (!allCodes.length) {
    throw new Error(`样本指数成分无法映射到申万一级行业: ${sampleIndexName} (${SAMPLE_INDEX_CODE})`);
  }

  const weightDate = range.weightAnchorDate;
  const noTradesInRange = !range.hasTrades;
  const valuationDate = toYYYYMMDD(await getLatestTradeDateForSectorDb());
  const [stockReturns, sectorIndexReturns, benchmarkReturns, mvs, valuations] = await timed("parallel(fetch returns+mvs)", () => Promise.all([
    noTradesInRange
      ? zeroReturnsMap(allCodes)
      : range.preset === "latest"
      ? fetchLatestReturns(allCodes, toYYYYMMDD(range.effectiveEndDate), { forceRefresh: forceLatestRefresh })
      : fetchIntervalReturns(allCodes, toYYYYMMDD(range.effectiveStartDate), toYYYYMMDD(range.effectiveEndDate)),
    noTradesInRange
      ? zeroReturnsMap(INDEXES.map((x) => x.code))
      : range.preset === "latest"
      ? fetchLatestReturns(INDEXES.map((x) => x.code), toYYYYMMDD(range.effectiveEndDate), { forceRefresh: forceLatestRefresh })
      : fetchIntervalReturns(INDEXES.map((x) => x.code), toYYYYMMDD(range.effectiveStartDate), toYYYYMMDD(range.effectiveEndDate)),
    noTradesInRange
      ? zeroReturnsMap(BENCHMARK_INDEXES.map((x) => x.code))
      : range.preset === "latest"
      ? fetchLatestReturns(BENCHMARK_INDEXES.map((x) => x.code), toYYYYMMDD(range.effectiveEndDate), { forceRefresh: forceLatestRefresh })
      : fetchIntervalReturns(BENCHMARK_INDEXES.map((x) => x.code), toYYYYMMDD(range.effectiveStartDate), toYYYYMMDD(range.effectiveEndDate)),
    fetchFloatMVs(allCodes, toYYYYMMDD(weightDate)),
    fetchStockValuations(allCodes, valuationDate)
  ]));

  let totalMv = 0;
  for (const code of allCodes) {
    const mv = Number(mvs.get(code) || 0);
    if (Number.isFinite(mv) && mv > 0) {
      totalMv += mv;
    }
  }

  if (!totalMv) {
    throw new Error("流通市值数据为空，无法计算贡献度");
  }

  const sectorBuckets = new Map(INDEXES.map((idx) => [idx.code, {
    sectorCode: idx.code,
    sectorName: idx.name,
    sectorMv: 0,
    weightedReturnSum: 0,
    contribution: 0,
    stocks: []
  }]));

  let marketReturn = 0;
  let sampleStockWeightedReturn = 0;
  const auditStocks = includeAudit ? [] : null;
  const excludedStocks = includeAudit ? [...unmappedMembers] : null;
  for (const code of allCodes) {
    const stock = stockMap.get(code);
    const mv = Number(mvs.get(code) || 0);
    const ret = Number(stockReturns.get(code));
    if (!stock || !Number.isFinite(mv) || mv <= 0 || !Number.isFinite(ret)) {
      if (excludedStocks) {
        excludedStocks.push({
          code,
          name: stock?.name || "",
          reason: !stock ? "missing_stock_map" : (!Number.isFinite(mv) || mv <= 0 ? "invalid_mv" : "invalid_return")
        });
      }
      continue;
    }

    const weightInMarket = mv / totalMv;
    const stockContribution = weightInMarket * ret;
    sampleStockWeightedReturn += stockContribution;
    if (auditStocks) {
      auditStocks.push({
        code,
        name: stock.name,
        sectorCode: stock.sectorCode,
        sectorName: stock.sectorName,
        floatMv: mv,
        weightInMarket,
        stockReturnPct: ret,
        stockContributionPctPoint: stockContribution
      });
    }

    const bucket = sectorBuckets.get(stock.sectorCode);
    bucket.sectorMv += mv;
    bucket.weightedReturnSum += mv * ret; // 仅用于个股样本口径参考
    bucket.stocks.push({
      code,
      name: stock.name,
      mv,
      returnPct: ret,
      contributionPctPoint: stockContribution
    });
  }

  const sectors = [];
  for (const bucket of sectorBuckets.values()) {
    const sectorIndexRet = Number(sectorIndexReturns.get(bucket.sectorCode));
    const hasSectorReturn = Number.isFinite(sectorIndexRet);
    const sectorReturn = hasSectorReturn ? sectorIndexRet : 0;
    const sectorWeight = bucket.sectorMv > 0 ? bucket.sectorMv / totalMv : 0;
    const sectorContribution = sectorWeight * sectorReturn;
    marketReturn += sectorContribution;
    const sortedStocks = bucket.stocks.sort(
      (a, b) => Math.abs(b.contributionPctPoint) - Math.abs(a.contributionPctPoint)
    );
    const topStocks = sortedStocks
      .slice(0, 10)
      .map((s) => ({
        code: s.code,
        name: s.name,
        returnPct: round(s.returnPct, 2),
        contributionPctPoint: round(s.contributionPctPoint, 4)
      }));
    const drilldownStocks = bucket.sectorMv > 0
      ? sortedStocks.map((s) => {
          const sectorWeight = s.mv / bucket.sectorMv;
          const sectorContribution = sectorWeight * s.returnPct;
          return {
            code: s.code,
            name: s.name,
            returnPct: round(s.returnPct, 2),
            marketContributionPctPoint: round(s.contributionPctPoint, 4),
            sectorWeightPct: round(sectorWeight * 100, 4),
            sectorContributionPctPoint: round(sectorContribution, 4),
            tileValue: Math.pow(Math.abs(sectorContribution), 0.65),
            pe: roundNullable(valuations.get(s.code)?.pe, 2),
            pb: roundNullable(valuations.get(s.code)?.pb, 2),
            dy: roundNullable(valuations.get(s.code)?.dy, 2)
          };
        })
      : [];

    const tileValue = Math.pow(Math.abs(sectorContribution), 0.65);
    sectors.push({
      sectorCode: bucket.sectorCode,
      sectorName: bucket.sectorName,
      sectorReturnPct: hasSectorReturn ? round(sectorReturn, 2) : null,
      contributionPctPoint: round(sectorContribution, 4),
      marketWeightPct: round((bucket.sectorMv / totalMv) * 100, 2),
      tileValue,
      topStocks,
      drilldownStocks
    });
  }

  sectors.sort((a, b) => b.tileValue - a.tileValue);

  const benchmarks = BENCHMARK_INDEXES.map((x) => ({
    code: x.code,
    name: x.name,
    returnPct: roundNullable(Number(benchmarkReturns.get(x.code)), 2)
  }));

  const result = {
    range: {
      preset: range.preset,
      modeLabel: range.modeLabel,
      startDate: range.startDate,
      endDate: range.endDate,
      effectiveStartDate: range.effectiveStartDate,
      effectiveEndDate: range.effectiveEndDate,
      weightAnchorDate: range.weightAnchorDate,
      hasTrades: range.hasTrades
    },
    market: {
      sampleSectorProxyReturnPct: round(marketReturn, 2),
      sampleSize: allCodes.length,
      totalFloatMv: round(totalMv, 2),
      sampleUniverse: `${sampleIndexName}成分股（按申万一级行业分类）`,
      sampleConstituentWeightedReturnPct: round(sampleStockWeightedReturn, 2)
    },
    benchmarks,
    sectors
  };

  if (includeAudit) {
    result.audit = {
      sampleMemberCount: sampleMembers.length,
      mappedSampleCount: allCodes.length,
      unmappedCount: unmappedMembers.length,
      stocks: auditStocks || [],
      excludedStocks: excludedStocks || [],
      sectorsRaw: Array.from(sectorBuckets.values()).map((bucket) => {
        const sectorIndexRet = Number(sectorIndexReturns.get(bucket.sectorCode));
        const hasSectorReturn = Number.isFinite(sectorIndexRet);
        const sectorReturn = hasSectorReturn ? sectorIndexRet : 0;
        const sectorWeight = bucket.sectorMv > 0 ? bucket.sectorMv / totalMv : 0;
        return {
          sectorCode: bucket.sectorCode,
          sectorName: bucket.sectorName,
          sectorFloatMv: bucket.sectorMv,
          sectorWeightFraction: sectorWeight,
          sectorIndexReturnPct: hasSectorReturn ? sectorReturn : null,
          sectorContributionPctPoint: sectorWeight * sectorReturn,
          sampleConstituentWeightedReturnPct: bucket.sectorMv > 0 ? bucket.weightedReturnSum / bucket.sectorMv : 0,
          sampleStockCount: bucket.stocks.length
        };
      }),
      benchmarksRaw: BENCHMARK_INDEXES.map((x) => ({
        code: x.code,
        name: x.name,
        returnPct: Number.isFinite(Number(benchmarkReturns.get(x.code))) ? Number(benchmarkReturns.get(x.code)) : null
      })),
      totalFloatMv: totalMv,
      sampleSectorProxyReturnPct: marketReturn,
      sampleConstituentWeightedReturnPct: sampleStockWeightedReturn
    };
  }

  return result;
}

function buildNoTradeHeatmap(range) {
  const sectors = INDEXES.map((idx) => ({
    sectorCode: idx.code,
    sectorName: idx.name,
    sectorReturnPct: 0,
    contributionPctPoint: 0,
    marketWeightPct: 0,
    tileValue: 1,
    topStocks: []
  }));

  return {
    range: {
      preset: range.preset,
      modeLabel: range.modeLabel,
      startDate: range.startDate,
      endDate: range.endDate,
      effectiveStartDate: range.effectiveStartDate,
      effectiveEndDate: range.effectiveEndDate,
      weightAnchorDate: range.weightAnchorDate,
      hasTrades: false
    },
    market: {
      sampleSectorProxyReturnPct: 0,
      sampleSize: 0,
      totalFloatMv: 0,
      sampleUniverse: "区间内无交易日",
      sampleConstituentWeightedReturnPct: 0
    },
    benchmarks: BENCHMARK_INDEXES.map((x) => ({
      code: x.code,
      name: x.name,
      returnPct: 0
    })),
    sectors
  };
}

async function fetchAllSectorMembers(endDate) {
  const results = await mapWithConcurrency(INDEXES, 4, async (sector) => {
    const members = await fetchIndexMembers(sector.code, endDate);
    return [sector.code, members];
  });

  return new Map(results);
}

async function getSectorMapForSample(sampleMembers, endDate) {
  const localMap = await loadSectorDbMap();
  const missingMembers = sampleMembers.filter((x) => !localMap.has(x.code));
  const missing = missingMembers.map((x) => x.code);
  if (DEBUG) {
    debugLog(
      "[sector-db]",
      `local=${localMap.size}`,
      `sample=${sampleMembers.length}`,
      `missing=${missing.length}`,
      `dbDate=${sectorDbMeta.effectiveDate || "null"}`
    );
    if (missingMembers.length) {
      debugLog(
        "[sector-db]",
        "missing_members",
        missingMembers.map((x) => `${x.code}:${x.name}`).join(",")
      );
    }
  }
  if (missing.length === 0) {
    return localMap;
  }

  const latestTradeDate = await getLatestTradeDateForSectorDb();
  const dbSnapshotDate = sectorDbMeta.effectiveDate || null;
  if (DEBUG) {
    debugLog("[sector-db]", `dbSnapshotDate=${dbSnapshotDate || "null"}`, `latestTradeDate=${latestTradeDate}`);
  }
  if (dbSnapshotDate && dbSnapshotDate >= latestTradeDate) {
    if (DEBUG) {
      debugLog(
        "[sector-db]",
        "skip refresh: local db already latest; missing codes treated as historical constituents and excluded from sample"
      );
    }
    return localMap;
  }

  if (DEBUG) {
    debugLog("[sector-db]", `refresh from network using latestTradeDate=${latestTradeDate}`);
  }
  const refreshed = await refreshAndSaveSectorDb(latestTradeDate);
  const stillMissing = sampleMembers.filter((x) => !refreshed.has(x.code)).map((x) => x.code);
  if (stillMissing.length && DEBUG) {
    const sampleIndexName = await getSampleIndexName();
    debugWarn(`${sampleIndexName} 成分未匹配申万一级行业(示例):`, stillMissing.slice(0, 10));
  }
  return refreshed;
}

async function loadSectorDbMap() {
  if (sectorDbCache) {
    return sectorDbCache;
  }
  if (!existsSync(SECTOR_DB_FILE)) {
    if (DEBUG) {
      debugLog("[sector-db]", "no local file", SECTOR_DB_FILE);
    }
    sectorDbMeta = { effectiveDate: null, updatedAt: null };
    sectorDbCache = new Map();
    return sectorDbCache;
  }
  try {
    const text = await readFile(SECTOR_DB_FILE, "utf8");
    const json = JSON.parse(text);
    const map = new Map();
    sectorDbMeta = {
      effectiveDate: json?.effectiveDate || null,
      updatedAt: json?.updatedAt || null
    };
    const stocks = json?.stocks || {};
    for (const [code, info] of Object.entries(stocks)) {
      if (info?.sectorCode && info?.sectorName) {
        map.set(code, { sectorCode: info.sectorCode, sectorName: info.sectorName });
      }
    }
    sectorDbCache = map;
    if (DEBUG) {
      debugLog(
        "[sector-db]",
        "loaded local file",
        SECTOR_DB_FILE,
        `entries=${map.size}`,
        `effectiveDate=${sectorDbMeta.effectiveDate || "null"}`
      );
    }
    return map;
  } catch (error) {
    if (DEBUG) {
      debugWarn("读取行业映射缓存失败:", error.message);
    }
    sectorDbMeta = { effectiveDate: null, updatedAt: null };
    sectorDbCache = new Map();
    return sectorDbCache;
  }
}

async function refreshAndSaveSectorDb(endDate) {
  const membersBySector = await timed("refreshAndSaveSectorDb.fetchAllSectorMembers", () => fetchAllSectorMembers(endDate));
  const freshMap = buildSectorMembershipMap(membersBySector);
  await timed("refreshAndSaveSectorDb.saveSectorDbMap", () => saveSectorDbMap(freshMap, endDate));
  if (DEBUG) {
    debugLog("[sector-db]", `overwrite local with latest snapshot size=${freshMap.size}`);
  }
  sectorDbCache = freshMap;
  return freshMap;
}

async function saveSectorDbMap(map, effectiveDate) {
  await mkdir(DATA_DIR, { recursive: true });
  const stocks = {};
  for (const [code, info] of map.entries()) {
    stocks[code] = info;
  }
  const payload = {
    schema: 1,
    effectiveDate,
    updatedAt: new Date().toISOString(),
    stocks
  };
  await writeFile(SECTOR_DB_FILE, JSON.stringify(payload, null, 2), "utf8");
  sectorDbMeta = {
    effectiveDate: payload.effectiveDate,
    updatedAt: payload.updatedAt
  };
}

async function fetchSampleMembers(weightAnchorDate) {
  const key = `sampleMembers:${SAMPLE_INDEX_CODE}:${weightAnchorDate}`;
  return cachedAsync(CACHE.sampleMembers, key, CACHE_TTL.sampleMembers, () =>
    fetchIndexMembers(SAMPLE_INDEX_CODE, weightAnchorDate)
  );
}

async function getSampleIndexName() {
  if (runtimeMeta.sampleIndexName) {
    return runtimeMeta.sampleIndexName;
  }
  if (runtimeMeta.sampleIndexNamePending) {
    return runtimeMeta.sampleIndexNamePending;
  }

  runtimeMeta.sampleIndexNamePending = (async () => {
    try {
      const name = await fetchIndexShortName(SAMPLE_INDEX_CODE);
      runtimeMeta.sampleIndexName = name || SAMPLE_INDEX_FALLBACK_NAME;
    } catch (error) {
      runtimeMeta.sampleIndexName = SAMPLE_INDEX_FALLBACK_NAME;
      if (DEBUG) {
        debugWarn(
          "[sample-index-name]",
          `code=${SAMPLE_INDEX_CODE}`,
          `fallback=${SAMPLE_INDEX_FALLBACK_NAME}`,
          `message=${error.message || String(error)}`
        );
      }
    }
    return runtimeMeta.sampleIndexName;
  })();

  try {
    return await runtimeMeta.sampleIndexNamePending;
  } finally {
    runtimeMeta.sampleIndexNamePending = null;
  }
}

async function fetchIndexShortName(indexCode) {
  const data = await ifind.post("/basic_data_service", {
    codes: indexCode,
    indipara: [
      {
        indicator: "ths_index_short_name_index",
        indiparams: []
      }
    ]
  });

  for (const row of data.tables || []) {
    const name = String(row.table?.ths_index_short_name_index?.[0] || "").trim();
    if (name) {
      return name;
    }
  }
  return "";
}

async function fetchIndexMembers(indexCode, endDate) {
  const date = toYYYYMMDD(endDate);
  const output = ["p03473_f002", "p03473_f003"];
  const data = await ifind.post("/data_pool", {
    reportname: "p03473",
    functionpara: {
      iv_date: date,
      iv_zsdm: indexCode
    },
    outputpara: output.join(",")
  });
  const table = data.tables?.[0]?.table || {};
  const codes = table[output[0]] || [];
  const names = table[output[1]] || [];
  return codes.map((code, i) => ({ code, name: names[i] || code }));
}

function buildSectorMembershipMap(membersBySector) {
  const map = new Map();
  for (const sector of INDEXES) {
    const members = membersBySector.get(sector.code) || [];
    for (const m of members) {
      if (!map.has(m.code)) {
        map.set(m.code, { sectorCode: sector.code, sectorName: sector.name });
      }
    }
  }
  return map;
}

async function fetchRealtimeReturns(codes, options = {}) {
  const indicator = REALTIME_RETURN_INDICATOR;
  const key = `rt:${indicator}:${codesHash(codes)}`;
  if (options.forceRefresh === true) {
    CACHE.returns.delete(key);
  }
  return cachedAsync(CACHE.returns, key, CACHE_TTL.returnsLatest, async () => {
    const out = new Map();
    await fetchCodesWithFallback(codes, 80, 3, async (part) => {
      const data = await ifind.post("/real_time_quotation", {
        codes: part.join(","),
        indicators: indicator
      });

      for (const row of data.tables || []) {
        const value = row.table?.[indicator]?.[0];
        out.set(row.thscode, Number(value));
      }
    });
    return out;
  });
}

async function fetchLatestReturns(codes, _endDate, options = {}) {
  // latest 统一走实时行情，避免将指数代码错误回退到 N 日涨跌幅口径。
  return fetchRealtimeReturns(codes, options);
}

async function fetchIntervalReturns(codes, startDate, endDate) {
  return cachedAsync(
    CACHE.returns,
    `int:${startDate}:${endDate}:${codesHash(codes)}`,
    CACHE_TTL.returnsHistory,
    async () => {
      const out = new Map();
      await fetchCodesWithFallback(codes, 80, 3, async (part) => {
        const data = await ifind.post("/basic_data_service", {
          codes: part.join(","),
          indipara: [
            {
              indicator: "ths_int_chg_ratio_stock",
              indiparams: [startDate, endDate, "8"]
            }
          ]
        });

        for (const row of data.tables || []) {
          const value = row.table?.ths_int_chg_ratio_stock?.[0];
          out.set(row.thscode, Number(value));
        }
      });
      return out;
    }
  );
}

async function fetchNDReturns(codes, date, nd) {
  return cachedAsync(CACHE.returns, `nd:${date}:${nd}:${codesHash(codes)}`, CACHE_TTL.returnsHistory, async () => {
    const out = new Map();
    await fetchCodesWithFallback(codes, 80, 3, async (part) => {
      const data = await ifind.post("/date_sequence", {
        codes: part.join(","),
        functionpara: {
          date_sequence: date
        },
        indipara: [
          {
            indicator: "ths_chg_ratio_nd_stock",
            indiparams: [nd, "", "8"]
          }
        ]
      });

      for (const row of data.tables || []) {
        const value = row.table?.ths_chg_ratio_nd_stock?.[0];
        out.set(row.thscode, Number(value));
      }
    });
    return out;
  });
}

async function fetchFloatMVs(codes, endDate) {
  return cachedAsync(CACHE.floatMv, `mv:${endDate}:${codesHash(codes)}`, CACHE_TTL.floatMv, async () => {
    const indicator = FLOAT_MV_INDICATOR;
    const out = new Map();
    await fetchCodesWithFallback(codes, 80, 3, async (part) => {
      const data = await ifind.post("/date_sequence", {
        codes: part.join(","),
        functionpara: {
          date_sequence: endDate
        },
        indipara: [
          {
            indicator,
            indiparams: [""]
          }
        ]
      });

      for (const row of data.tables || []) {
        const value = row.table?.[indicator]?.[0];
        out.set(row.thscode, Number(value));
      }
    });

    let positiveCount = 0;
    for (const value of out.values()) {
      if (Number.isFinite(value) && value > 0) {
        positiveCount += 1;
      }
    }
    if (DEBUG) {
      debugLog("float mv indicator:", indicator, "hit", positiveCount);
    }
    return out;
  });
}

async function fetchStockValuations(codes, date) {
  const cacheKey = `val:${date}`;
  pruneValuationCacheByDate(date);
  const now = Date.now();
  let entry = CACHE.valuations.get(cacheKey);
  if (!entry || entry.expiresAt <= now) {
    entry = { expiresAt: now + CACHE_TTL.valuations, values: new Map(), pending: null };
    CACHE.valuations.set(cacheKey, entry);
    trimCacheToMax(CACHE.valuations, "valuations");
    if (DEBUG) {
      debugLog("[cache]", "miss", shortKey(cacheKey));
    }
  }

  while (true) {
    const missing = codes.filter((code) => !entry.values.has(code));
    if (missing.length === 0) {
      if (DEBUG) {
        debugLog("[cache]", "hit", `${shortKey(cacheKey)}:${codes.length}`);
      }
      const out = new Map();
      for (const code of codes) {
        out.set(code, entry.values.get(code));
      }
      return out;
    }

    if (entry.pending) {
      if (DEBUG) {
        debugLog("[cache]", "pending", `${shortKey(cacheKey)}:${missing.length}`);
      }
      await entry.pending;
      continue;
    }

    if (DEBUG) {
      debugLog("[cache]", "fill", `${shortKey(cacheKey)} missing=${missing.length}`);
    }
    const requestedMissing = missing.slice();
    entry.pending = (async () => {
      await fetchCodesWithFallback(requestedMissing, 80, 3, async (part) => {
        const data = await ifind.post("/basic_data_service", {
          codes: part.join(","),
          indipara: [
            {
              indicator: "ths_pe_deduct_nrgal_ttm_stock",
              indiparams: [date, "100"]
            },
            {
              indicator: "ths_pb_mrq_stock",
              indiparams: [date]
            },
            {
              indicator: "ths_dividend_yield_ttm_ex_sd_stock",
              indiparams: [date]
            }
          ]
        });

        for (const row of data.tables || []) {
          entry.values.set(row.thscode, {
            pe: Number(row.table?.ths_pe_deduct_nrgal_ttm_stock?.[0]),
            pb: Number(row.table?.ths_pb_mrq_stock?.[0]),
            dy: Number(row.table?.ths_dividend_yield_ttm_ex_sd_stock?.[0])
          });
        }
      });
      // 负缓存：对本轮请求后仍无返回的代码写入 null，避免无限循环重复拉取。
      let unresolved = 0;
      for (const code of requestedMissing) {
        if (!entry.values.has(code)) {
          entry.values.set(code, null);
          unresolved += 1;
        }
      }
      if (DEBUG && unresolved > 0) {
        debugWarn("[cache]", "val unresolved->null", `${shortKey(cacheKey)}:${unresolved}`);
      }
      entry.expiresAt = Date.now() + CACHE_TTL.valuations;
    })();

    try {
      await entry.pending;
    } finally {
      entry.pending = null;
    }
  }
}

function pruneValuationCacheByDate(activeDate) {
  const activeKey = `val:${activeDate}`;
  for (const key of CACHE.valuations.keys()) {
    if (typeof key === "string" && key.startsWith("val:") && key !== activeKey) {
      CACHE.valuations.delete(key);
    }
  }
}

async function resolveTradingRange(preset, today, customStart, customEnd) {
  const endDate = preset === "custom" ? String(customEnd || today) : today;

  if (preset === "latest") {
    const effectiveEndDate = await getLastTradeDateOnOrBefore(endDate);
    const effectiveStartDate = effectiveEndDate;
    return {
      preset,
      modeLabel: "最新",
      startDate: endDate,
      endDate,
      effectiveStartDate,
      effectiveEndDate,
      weightAnchorDate: await getPreviousTradeDate(effectiveStartDate),
      hasTrades: true
    };
  }

  if (preset === "custom") {
    if (!customStart || !customEnd) {
      throw new Error("自定义时间区间必须包含起止日期");
    }
    const tradeDates = await getTradeDatesInRange(customStart, customEnd);
    if (!tradeDates.length) {
      throw new Error("所选区间内没有交易日");
    }
    return {
      preset,
      modeLabel: "自定义区间",
      startDate: customStart,
      endDate: customEnd,
      effectiveStartDate: tradeDates[0],
      effectiveEndDate: tradeDates[tradeDates.length - 1],
      weightAnchorDate: await getPreviousTradeDate(tradeDates[0]),
      hasTrades: true
    };
  }

  if (preset === "1w") {
    return await makeCalendarRange(preset, "过去1周", addDays(today, -7), today);
  }
  if (preset === "1m") {
    return await makeCalendarRange(preset, "过去1月", addMonths(today, -1), today);
  }
  if (preset === "1y") {
    return await makeCalendarRange(preset, "过去1年", addYears(today, -1), today);
  }
  if (preset === "ytd") {
    return await makeCalendarRange(preset, "今年以来", `${today.slice(0, 4)}-01-01`, today);
  }

  throw new Error(`不支持的时间区间: ${preset}`);
}

async function makeCalendarRange(preset, modeLabel, startDate, endDate) {
  const tradeDates = await getTradeDatesInRange(startDate, endDate);
  if (!tradeDates.length) {
    return {
      preset,
      modeLabel,
      startDate,
      endDate,
      effectiveStartDate: null,
      effectiveEndDate: null,
      // 无交易日场景会直接短路返回零热力图，不需要再额外查询权重基准日。
      weightAnchorDate: null,
      hasTrades: false
    };
  }
  const effectiveStartDate = tradeDates[0];
  return {
    preset,
    modeLabel,
    startDate,
    endDate,
    effectiveStartDate,
    effectiveEndDate: tradeDates[tradeDates.length - 1],
    weightAnchorDate: await getPreviousTradeDate(effectiveStartDate),
    hasTrades: true
  };
}

async function getLastTradeDateOnOrBefore(date) {
  const dates = await getTradeDatesInRange(addDays(date, -31), date);
  if (!dates.length) {
    throw new Error(`未找到 ${date} 之前的交易日`);
  }
  return dates[dates.length - 1];
}

async function getTradeDatesInRange(startDate, endDate) {
  return cachedAsync(CACHE.tradeRange, `${startDate}:${endDate}`, CACHE_TTL.tradeDates, async () => {
    const data = await ifind.post("/get_trade_dates", {
      marketcode: TRADE_MARKET_CODE,
      functionpara: {
        mode: "1",
        dateType: "0",
        period: "D",
        dateFormat: "2"
      },
      startdate: toYYYYMMDD(startDate),
      enddate: toYYYYMMDD(endDate)
    });
    const list = data.tables?.time || [];
    return list.map(fromYYYYMMDD);
  });
}

async function getTradeDatesByOffset(anchorDate, offset) {
  return cachedAsync(CACHE.tradeOffset, `${anchorDate}:${offset}`, CACHE_TTL.tradeDates, async () => {
    const data = await ifind.post("/get_trade_dates", {
      marketcode: TRADE_MARKET_CODE,
      functionpara: {
        dateType: "0",
        period: "D",
        offset: String(offset),
        dateFormat: "2",
        output: "sequencedate"
      },
      startdate: toYYYYMMDD(anchorDate)
    });
    const list = data.tables?.time || [];
    return list.map(fromYYYYMMDD);
  });
}

async function getPreviousTradeDate(tradeDate) {
  const dates = await getTradeDatesByOffset(tradeDate, -1);
  if (!dates.length) {
    throw new Error(`无法获取 ${tradeDate} 的前一交易日`);
  }
  return dates.length >= 2 ? dates[dates.length - 2] : dates[0];
}

async function getLatestTradeDateForSectorDb() {
  return getLastTradeDateOnOrBefore(shanghaiDateString(new Date()));
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const full = normalize(join(PUBLIC_DIR, cleanPath));
  if (!full.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  try {
    const st = await stat(full);
    if (!st.isFile()) {
      return sendJson(res, 404, { error: "Not found" });
    }
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }

  const ext = extname(full);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  createReadStream(full).pipe(res);
}

function sendJson(res, code, data) {
  const payload = JSON.stringify(data);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    vary: "Accept-Encoding"
  };

  const acceptEncoding = String(res.req?.headers?.["accept-encoding"] || "");
  if (Buffer.byteLength(payload, "utf8") < JSON_COMPRESS_MIN_BYTES) {
    res.writeHead(code, headers);
    res.end(payload);
    return;
  }

  if (/\bbr\b/i.test(acceptEncoding)) {
    const compressed = brotliCompressSync(Buffer.from(payload), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4
      }
    });
    res.writeHead(code, {
      ...headers,
      "content-encoding": "br"
    });
    res.end(compressed);
    return;
  }

  if (/\bgzip\b/i.test(acceptEncoding)) {
    const compressed = gzipSync(Buffer.from(payload), { level: 6 });
    res.writeHead(code, {
      ...headers,
      "content-encoding": "gzip"
    });
    res.end(compressed);
    return;
  }

  res.writeHead(code, headers);
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalIndex = normalized.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = normalized.slice(equalIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function fetchCodesWithFallback(codes, batchSize, concurrency, fetcher) {
  if (!codes.length) {
    return;
  }
  const effectiveBatchSize = codes.length <= 500 ? codes.length : batchSize;
  const effectiveConcurrency = codes.length <= 500 ? 1 : concurrency;
  const parts = chunk(codes, effectiveBatchSize);
  await mapWithConcurrency(parts, effectiveConcurrency, (part) => fetchPartWithSplit(part, fetcher));
}

async function fetchPartWithSplit(part, fetcher) {
  if (!part.length) {
    return;
  }
  try {
    await fetcher(part);
  } catch (error) {
    const message = String(error.message || "");
    if (!message.includes("-4210")) {
      throw error;
    }
    if (part.length === 1) {
      if (DEBUG) {
        debugWarn("skip invalid code:", part[0]);
      }
      return;
    }
    const mid = Math.floor(part.length / 2);
    await fetchPartWithSplit(part.slice(0, mid), fetcher);
    await fetchPartWithSplit(part.slice(mid), fetcher);
  }
}

function round(num, digits) {
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function roundNullable(num, digits) {
  return Number.isFinite(num) ? round(num, digits) : null;
}

async function zeroReturnsMap(codes) {
  const out = new Map();
  for (const code of codes) {
    out.set(code, 0);
  }
  return out;
}

function shanghaiDateString(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function addDays(isoDate, delta) {
  const d = parseIsoAsUtc(isoDate);
  d.setUTCDate(d.getUTCDate() + delta);
  return formatIsoFromUtc(d);
}

function addMonths(isoDate, delta) {
  const d = parseIsoAsUtc(isoDate);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return formatIsoFromUtc(d);
}

function addYears(isoDate, delta) {
  const d = parseIsoAsUtc(isoDate);
  d.setUTCFullYear(d.getUTCFullYear() + delta);
  return formatIsoFromUtc(d);
}

function toYYYYMMDD(isoDate) {
  return isoDate.replaceAll("-", "");
}

function fromYYYYMMDD(date) {
  if (!date || date.length !== 8) {
    return String(date || "");
  }
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const out = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) {
        return;
      }
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(...args) {
  if (!DEBUG) {
    return;
  }
  console.log(...args);
  writeDebugLine("INFO", args);
}

function debugWarn(...args) {
  if (!DEBUG) {
    return;
  }
  console.warn(...args);
  writeDebugLine("WARN", args);
}

function writeDebugLine(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(formatLogArg).join(" ")}\n`;
  void ensureDebugLogDir()
    .then(() => appendFile(DEBUG_LOG_FILE, line, "utf8"))
    .catch(() => {});
}

async function ensureDebugLogDir() {
  if (debugLogDirReady || !DEBUG) {
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  debugLogDirReady = true;
}

function formatLogArg(arg) {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function fileStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function writeCsvExport(fileName, rows) {
  const fullPath = join(EXPORT_DIR, fileName);
  const csv = toCsv(rows || []);
  await writeFile(fullPath, csv, "utf8");
  return {
    fileName,
    path: fullPath,
    rows: rows?.length || 0
  };
}

function toCsv(rows) {
  if (!rows.length) {
    return "";
  }
  const headers = Array.from(rows.reduce((set, row) => {
    for (const key of Object.keys(row || {})) {
      set.add(key);
    }
    return set;
  }, new Set()));
  const lines = [headers.join(",")];
  for (const row of rows) {
    const line = headers.map((h) => csvCell(row?.[h])).join(",");
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

async function cachedAsync(cache, key, ttlMs, loader) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry?.pending) {
    if (DEBUG) {
      debugLog("[cache]", "pending", shortKey(key));
    }
    return entry.pending;
  }
  if (entry && "value" in entry && entry.expiresAt > now) {
    if (DEBUG) {
      debugLog("[cache]", "hit", shortKey(key));
    }
    return entry.value;
  }
  if (DEBUG) {
    debugLog("[cache]", "miss", shortKey(key));
  }

  const pending = (async () => {
    try {
      const value = await loader();
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      trimCacheToMax(cache);
      return value;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  })();

  cache.set(key, { pending, expiresAt: now + ttlMs });
  trimCacheToMax(cache);
  return pending;
}

function startCacheJanitor() {
  setInterval(() => {
    const now = Date.now();
    for (const [name, map] of Object.entries(CACHE)) {
      let removed = 0;
      for (const [key, entry] of map.entries()) {
        const expiresAt = Number(entry?.expiresAt);
        const hasPending = !!entry?.pending;
        if (!hasPending && Number.isFinite(expiresAt) && expiresAt <= now) {
          map.delete(key);
          removed += 1;
        }
      }
      trimCacheToMax(map, name);
      if (DEBUG && removed > 0) {
        debugLog("[cache]", "sweep", name, `removed=${removed}`, `size=${map.size}`);
      }
    }
  }, CACHE_SWEEP_INTERVAL_MS).unref?.();
}

function trimCacheToMax(cache, cacheNameOverride) {
  const name = cacheNameOverride || getCacheName(cache);
  const maxEntries = CACHE_MAX_ENTRIES[name] ?? 0;
  if (!maxEntries || cache.size <= maxEntries) {
    return;
  }

  const candidates = [];
  for (const [key, entry] of cache.entries()) {
    if (entry?.pending) {
      continue;
    }
    const expiresAt = Number(entry?.expiresAt);
    candidates.push({ key, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY });
  }
  candidates.sort((a, b) => a.expiresAt - b.expiresAt);

  let needDelete = cache.size - maxEntries;
  for (const item of candidates) {
    if (needDelete <= 0) break;
    cache.delete(item.key);
    needDelete -= 1;
  }
}

function getCacheName(cache) {
  for (const [name, ref] of Object.entries(CACHE)) {
    if (ref === cache) return name;
  }
  return "";
}

function codesHash(codes) {
  let hash = 2166136261;
  for (const code of codes) {
    for (let i = 0; i < code.length; i += 1) {
      hash ^= code.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 44;
    hash = Math.imul(hash, 16777619);
  }
  return `${codes.length}:${(hash >>> 0).toString(16)}`;
}

async function timed(label, fn) {
  if (!DEBUG) {
    return fn();
  }
  const t0 = Date.now();
  try {
    const out = await fn();
    debugLog("[perf]", label, `${Date.now() - t0}ms`);
    return out;
  } catch (error) {
    debugLog("[perf]", label, `${Date.now() - t0}ms`, "ERROR");
    throw error;
  }
}

function shortKey(key) {
  const s = String(key);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function parseIsoAsUtc(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function formatIsoFromUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
