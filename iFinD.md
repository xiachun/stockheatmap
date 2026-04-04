# 同花顺 iFinD 数据接口使用说明

同花顺 iFinD 数据接口通过发送 HTTP POST 请求的方式访问，request header 中需包含 `access_token`。
每一条 access token 的有效期为 7 天。当 `access_token` 过期时，可以通过以下 HTTP 请求获取新的 access token。

## 获取 Access Token

```http
POST https://quantapi.51ifind.com/api/v1/get_access_token
Content-Type: application/json
```

**请求体：**

```json
{
  "refresh_token": "..."
}
```

其中 refresh_token 按实际填写。

## 同花顺代码 (thscode)

每一个股票或指数都有一个唯一的同花顺代码：`thscode`，例如中国平安的 `thscode` 是 `601318.SH`，沪深300指数的代码是`000300.SH`，申万农林牧渔行业指数的代码是 `801010.SL`。

### 31个申万一级行业指数的代码及简称

| 代码 (thscode) | 简称 (short_name) |
| :--- | :--- |
| `801010.SL` | 农林牧渔 |
| `801030.SL` | 基础化工 |
| `801040.SL` | 钢铁 |
| `801050.SL` | 有色金属 |
| `801080.SL` | 电子 |
| `801110.SL` | 家用电器 |
| `801120.SL` | 食品饮料 |
| `801130.SL` | 纺织服饰 |
| `801140.SL` | 轻工制造 |
| `801150.SL` | 医药生物 |
| `801160.SL` | 公用事业 |
| `801170.SL` | 交通运输 |
| `801180.SL` | 房地产 |
| `801200.SL` | 商贸零售 |
| `801210.SL` | 社会服务 |
| `801230.SL` | 综合 |
| `801710.SL` | 建筑材料 |
| `801720.SL` | 建筑装饰 |
| `801730.SL` | 电力设备 |
| `801740.SL` | 国防军工 |
| `801750.SL` | 计算机 |
| `801760.SL` | 传媒 |
| `801770.SL` | 通信 |
| `801780.SL` | 银行 |
| `801790.SL` | 非银金融 |
| `801880.SL` | 汽车 |
| `801890.SL` | 机械设备 |
| `801950.SL` | 煤炭 |
| `801960.SL` | 石油石化 |
| `801970.SL` | 环保 |
| `801980.SL` | 美容护理 |

### 一些主要指数的代码

| 名称 | 代码 (thscode) |
| :--- | :--- |
| 上证指数 | `000001.SH` |
| 沪深300 | `000300.SH` |
| 上证50 | `000016.SH` |
| 深证成指 | `399001.SZ` |
| 创业板指 | `399006.SZ` |

---

## 接口说明

### 1. 获取指数成分列表

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/data_pool
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "reportname": "p03473",
  "functionpara": {
    "iv_date": "20260221",
    "iv_zsdm": "801010.SL"
  },
  "outputpara": "p03473_f002,p03473_f003"
}
```

*关键参数：*
* `iv_date`: 样本日期，格式 `yyyymmdd`
* `iv_zsdm`: 指数代码，譬如农林牧渔指数代码是 `801010.SL`
* `outputpara`: 需要返回的指标，其中 `p03473_f002` 是成分股票的代码，`p03473_f003` 是股票简称，多指标间用`,`分隔。

**返回示例：**


```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": [
    {
      "table": {
        "p03473_f002": [
          "000019.SZ",
          "000048.SZ",
          "000505.SZ"
          // ... 更多股票代码
        ],
        "p03473_f003": [
          "深粮控股",
          "京基智农",
          "京粮控股"
          // ... 更多股票简称
        ]
      }
    }
  ],
  "datatype": [],
  "inputParams": {},
  "outParams": {
    "p03473_f002": "同花顺代码",
    "p03473_f003": "证券名称"
  },
  "descrs": {
    "p03473_f002": {
      "name": "p03473_f002",
      "type": "DT_STRING",
      "attrs": []
    }
    // ...
  },
  "perf": 71,
  "dataVol": 208
}
```

---

### 2. 获取指数或个股的最新涨跌幅

获取在盘中的实时涨跌幅，或盘后的最近交易日涨跌幅。

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/real_time_quotation
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "codes": "801010.SL,000002.SZ",
  "indicators": "changeRatio"
}
```

*关键参数：*
* `codes`: 指数或股票的代码，多个代码之间用 `,` 隔开。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "Success!",
  "tables": [
    {
      "marketCategory": "1",
      "pricetype": 1,
      "thscode": "801010.SL",
      "time": [
        "2026-02-13 20:01:43"
      ],
      "table": {
        "changeRatio": [
          -0.4976291767916903
        ]
      }
    },
    {
      "marketCategory": "1",
      "pricetype": 1,
      "thscode": "000002.SZ",
      "time": [
        "2026-02-13 16:00:51"
      ],
      "table": {
        "changeRatio": [
          1.0162601626016224
        ]
      }
    }
  ],
  "datatype": [
    {
      "itemid": "changeRatio",
      "type": "DT_DOUBLE"
    }
  ],
  "inputParams": {
    "indexs": "changeRatio"
  },
  "dataVol": 2,
  "perf": 230
}
```
返回结果中的`changeRatio` 就是百分比涨跌幅，例如 1.3 就表示上涨 1.3%。

---

### 3. 获取个股的流通市值

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/date_sequence
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "codes": "600312.SH,000002.SZ",
  "functionpara": {
    "date_sequence": "20260214"
  },
  "indipara": [
    {
      "indicator": "ths_current_mv_stock",
      "indiparams": [
        ""
      ]
    }
  ]
}
```

*关键参数：*
* `codes`: 股票代码，多个代码间用 `,` 隔开。
* `date_sequence`: 日期。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": [
    {
      "thscode": "600312.SH",
      "time": [
        "2026-02-14"
      ],
      "table": {
        "ths_current_mv_stock": [
          29716576667.1
        ]
      }
    },
    {
      "thscode": "000002.SZ",
      "time": [
        "2026-02-14"
      ],
      "table": {
        "ths_current_mv_stock": [
          48290506156.13
        ]
      }
    }
  ]
  // ... 其他信息省略
}
```

---

### 4. 获取个股或指数的 N 日涨跌幅

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/date_sequence
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "codes": "600312.SH,801010.SL",
  "functionpara": {
    "date_sequence": "20260214"
  },
  "indipara": [
    {
      "indicator": "ths_chg_ratio_nd_stock",
      "indiparams": [
        "-5",
        "",
        "8"
      ]
    }
  ]
}
```

*关键参数：*
* `date_sequence`: 基准日期，若该日期为非交易日，则基准日期为距离该日期最近的最后交易日
* `indiparams` 中的 `"-5"`，表示从基准交易日期前推 5 个交易日，相应的，10 日涨跌幅就是 `"-10"`，而`"-1"`则是相对于前一个交易日的涨跌幅，也就是基准日期当日的涨跌幅。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": [
    {
      "thscode": "600312.SH",
      "time": [
        "2026-02-14"
      ],
      "table": {
        "ths_chg_ratio_nd_stock": [
          3.8406827880512
        ]
      }
    },
    {
      "thscode": "801010.SL",
      "time": [
        "2026-02-14"
      ],
      "table": {
        "ths_chg_ratio_nd_stock": [
          -2.1037488654073
        ]
      }
    }
  ]
  // ... 其他信息省略
}
```

返回结果中的 `ths_chg_ratio_nd_stock` 就是对应 `thscode` 的 N 日百分比涨跌幅。

---

### 5. 获取个股或指数的区间涨跌幅

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/basic_data_service
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "codes": "000002.SZ,801010.SL",
  "indipara": [
    {
      "indicator": "ths_int_chg_ratio_stock",
      "indiparams": [
        "20260112",
        "20260113",
        "8"
      ]
    }
  ]
}
```

*关键参数：*
* `indiparams` 中的前两个参数 `"20260112"` 和 `"20260113"`，分别是区间的起始日和终止日。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": [
    {
      "thscode": "000002.SZ",
      "table": {
        "ths_int_chg_ratio_stock": [
          -2.6209677419355
        ]
      }
    },
    {
      "thscode": "801010.SL",
      "table": {
        "ths_int_chg_ratio_stock": [
          -1.1560386409238
        ]
      }
    }
  ]
  // ... 其他信息省略
}
```

返回结果中 `ths_int_chg_ratio_stock` 是从起始日到终止日这一时间区间（包含端点）内所有交易日的累计百分比涨跌幅，即区间内最后一个交易日的收盘价相对区间前最后一个交易日收盘价的涨跌幅。若此时间区间内没有交易日则返回 `null`

### 6. 日期查询

交易日期查询中需要指定具体的交易市场，每个市场都有一个代码 `marketcode`，`212001` 表示上交所，`212100` 表示深交所。对于中国A股市场来说，不同交易所的交易日历是统一的，因此用哪个结果都一样。

#### 6.1 查询指定时间区间内的所有交易日

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/get_trade_dates
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "marketcode": "212001",
  "functionpara": {
    "mode": "1",
    "dateType": "0",
    "period": "D",
    "dateFormat": "2"
  },
  "startdate": "20260212",
  "enddate": "20260222"
}
```

*关键参数：*
* `startdate`, `enddate`：区间的起始日和终止日。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": {
    "time": [
      "20260212",
      "20260213"
    ]
  },
  // ... 其他信息省略
}
```

`time` 是区间内（包含端点）所有交易日的列表，若区间内无交易日则返回 `[]`。

#### 6.2 前推 N 个交易日

**请求：**

```http
POST https://quantapi.51ifind.com/api/v1/get_trade_dates
Content-Type: application/json
access_token: f53f5c8ae758bdfdfda3f8077122900cdd12fb5f.signs_NjY0MzIyNzAx
```

**请求体：**

```json
{
  "marketcode": "212001",
  "functionpara": {
    "dateType": "0",
    "period": "D",
    "offset": "-2",
    "dateFormat": "2",
    "output": "sequencedate"
  },
  "startdate": "20260222"
}
```

*关键参数：*
* `offset`：前推的交易日数目，`-1`表示前推一个交易日，`-2`表示前推两个交易日，依此类推。
* `startdate`：基准日期。若此日期非交易日，则基准日期为此日期前的最后一个交易日。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": {
    "time": [
      "20260211",
      "20260212",
      "20260213"
    ]
  },
  // ... 其他信息省略
}
```

`time` 是基准日期及之前 N 个交易日的列表，共有 `N+1` 项。

### 7. 获取个股的估值指标

```http
POST https://quantapi.51ifind.com/api/v1/basic_data_service
Content-Type: application/json
access_token: ed71057d9cd1eec6b2840971a8d3fc95ac928ed0.signs_NjY0MzIyNzAx
```

**请求体：**


```json
{
  "codes": "600519.SH",
  "indipara": [
    {
      "indicator": "ths_pe_deduct_nrgal_ttm_stock",
      "indiparams": [
        "20260223",
        "100"
      ]
    },
    {
      "indicator": "ths_pb_mrq_stock",
      "indiparams": [
        "20260223"
      ]
    },
    {
      "indicator": "ths_dividend_yield_ttm_ex_sd_stock",
      "indiparams": [
        "20260223"
      ]
    }
  ]
}
```

*关键参数：*
* `codes`: 股票代码，多个代码间用 `,` 隔开。
* `indipara`：需要提取的指标列表，可以包含 1 个或多个指标。

* 对于每个指标，都包含两个参数：

  1. `indicator`：指标代码。常用指标代码如下：

     | 指标代码                                   | 含义   |
     |--------------------------------------------|--------|
     | `ths_pe_deduct_nrgal_ttm_stock`            | 市盈率 |
     | `ths_pb_mrq_stock`                         | 市净率 |
     | `ths_dividend_yield_ttm_ex_sd_stock`       | 股息率 |

  2. `indiparams`：指标对应的参数列表。不同指标的参数要求不同，但第一个元素均为日期。对于 `ths_pe_deduct_nrgal_ttm_stock`，还需要增加第二个元素 `"100"`。

**返回示例：**

```json
{
  "errorcode": 0,
  "errmsg": "",
  "tables": [
    {
      "thscode": "600519.SH",
      "table": {
        "ths_pe_deduct_nrgal_ttm_stock": [
          20.633875139752
        ],
        "ths_pb_mrq_stock": [
          7.2353724978348
        ],
        "ths_dividend_yield_ttm_ex_sd_stock": [
          3.476065441325
        ]
      }
    }
  ],
  // ... 其他信息省略
}
```