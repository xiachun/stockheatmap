import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_BASE = 'https://quantapi.51ifind.com/api/v1';
const DATA_DIR = join(process.cwd(), 'data');
const OUT_FILE = join(DATA_DIR, 'sw-sector-map.json');
const INDEXES = [
  ['801010.SL', '农林牧渔'], ['801030.SL', '基础化工'], ['801040.SL', '钢铁'], ['801050.SL', '有色金属'],
  ['801080.SL', '电子'], ['801110.SL', '家用电器'], ['801120.SL', '食品饮料'], ['801130.SL', '纺织服饰'],
  ['801140.SL', '轻工制造'], ['801150.SL', '医药生物'], ['801160.SL', '公用事业'], ['801170.SL', '交通运输'],
  ['801180.SL', '房地产'], ['801200.SL', '商贸零售'], ['801210.SL', '社会服务'], ['801230.SL', '综合'],
  ['801710.SL', '建筑材料'], ['801720.SL', '建筑装饰'], ['801730.SL', '电力设备'], ['801740.SL', '国防军工'],
  ['801750.SL', '计算机'], ['801760.SL', '传媒'], ['801770.SL', '通信'], ['801780.SL', '银行'],
  ['801790.SL', '非银金融'], ['801880.SL', '汽车'], ['801890.SL', '机械设备'], ['801950.SL', '煤炭'],
  ['801960.SL', '石油石化'], ['801970.SL', '环保'], ['801980.SL', '美容护理']
].map(([code, name]) => ({ code, name }));

class IFindClient {
  constructor() {
    this.accessToken = '';
    this.refreshToken = process.env.THS_REFRESH_TOKEN || '';
  }

  async post(path, payload, retry = true, attempt = 1) {
    if (!this.accessToken && this.refreshToken) await this.refreshAccessToken();
    let resp;
    try {
      resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.accessToken ? { access_token: this.accessToken } : {})
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      if (attempt < 4) {
        await sleep(300 * attempt);
        return this.post(path, payload, retry, attempt + 1);
      }
      throw e;
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`non-json response: ${text.slice(0, 120)}`);
    }

    if (resp.status === 429 && attempt < 4) {
      await sleep(300 * attempt);
      return this.post(path, payload, retry, attempt + 1);
    }

    const tokenError = resp.status === 401 || data.errorcode === -101 || data.errorcode === -201;
    if (tokenError && retry && this.refreshToken) {
      await this.refreshAccessToken();
      return this.post(path, payload, false, attempt);
    }

    if (!resp.ok || data.errorcode !== 0) {
      throw new Error(`${path}: ${resp.status} ${data.errorcode ?? ''} ${data.errmsg ?? ''}`);
    }
    return data;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('missing THS_REFRESH_TOKEN');
    const resp = await fetch(`${API_BASE}/get_access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken })
    });
    const data = await resp.json();
    const token = data.access_token || data?.data?.access_token;
    if (!token) throw new Error(`refresh failed: ${data.errmsg || resp.status}`);
    this.accessToken = token;
  }
}

const ifind = new IFindClient();
const argDate = process.argv[2];
const isoDate = argDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const yyyymmdd = isoDate.replaceAll('-', '');

const results = await Promise.all(INDEXES.map((sector) => fetchMembers(sector, yyyymmdd)));
const stocks = {};
for (const [sector, members] of results) {
  for (const m of members) {
    if (!stocks[m.code]) {
      stocks[m.code] = { sectorCode: sector.code, sectorName: sector.name };
    }
  }
}

await mkdir(DATA_DIR, { recursive: true });
await writeFile(
  OUT_FILE,
  JSON.stringify({ schema: 1, effectiveDate: isoDate, updatedAt: new Date().toISOString(), stocks }, null, 2),
  'utf8'
);
console.log(`saved ${Object.keys(stocks).length} stocks -> ${OUT_FILE}`);

async function fetchMembers(sector, date) {
  const data = await ifind.post('/data_pool', {
    reportname: 'p03473',
    functionpara: { iv_date: date, iv_zsdm: sector.code },
    outputpara: 'p03473_f002,p03473_f003'
  });
  const table = data.tables?.[0]?.table || {};
  const codes = table.p03473_f002 || [];
  const names = table.p03473_f003 || [];
  return [sector, codes.map((code, i) => ({ code, name: names[i] || code }))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
