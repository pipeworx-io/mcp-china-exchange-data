# @pipeworx/china-exchange-data

Live market data straight from the two Chinese mainland exchanges — SZSE (Shenzhen) and SSE (Shanghai), one pack because they are a single jurisdiction. Fills what `@pipeworx/china-stocks` doesn't cover: industry/sector turnover ranking, index daily/weekly bars, a full-market board snapshot for screens, and company bulletins (公告) by code.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1764+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

板块 主力资金 净流入 指数 日线 公告 — 深交所 上交所 A股行情数据接口

## Tools

- `ashares_sector_flows({ date?, top? })` — SZSE-official per-industry (行业) turnover ranking: turnover amount (成交金额/亿元), volume, company count, market cap, weighted P/E. **This is turnover, not the vendor "主力资金净流入" (large-order net-inflow) metric** — see Data sources below for why.
- `ashares_index_bars({ index?, days?, weeks? })` — daily or weekly OHLC + volume + turnover bars for a major index: `000001` 上证指数 Shanghai Composite, `000016` 上证50, `000300` 沪深300 CSI 300, `000688` 科创50 STAR50 (all SSE), `399001` 深证成指 Shenzhen Component, `399006` 创业板指 ChiNext (both SZSE).
- `ashares_market_bars({ date?, limit?, sort? })` — full SSE-board latest-session snapshot (~2,358 stocks): code, name, last, change %, volume, turnover amount. SSE only — see limitations below.
- `ashares_bulletins({ code, since?, type?, limit? })` — SSE-listed company disclosure bulletins by 6-digit code: title, type, date, PDF URL. SSE only.

## Auth

Keyless. All four upstreams are public, unauthenticated JSON/JSONP endpoints. Every one requires a same-site `Referer` header or 4xx-blocks the request.

## Data sources

- **SZSE report API** — `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=<id>` with `Referer: https://www.szse.cn/market/trend/index.html`. `CATALOGID=1804_gptj_merge_after` (股票行业统计) is a per-industry turnover report; requires `txtQueryDate`. Catalog ids are undocumented by SZSE and were read out of the site's own network calls while browsing 市场数据 → 股票数据 → 行业统计 — `1804_gptj_merge_after` is the only one this pack uses; `1110` (A股列表, static company metadata — code/name/listing date/industry, no price data) and `1815_stock_snapshot` (per-code quote history, requires a specific security code, not a bulk snapshot) were probed and found not useful for a full-market bulk report.
- **SZSE quote history** — `https://www.szse.cn/api/market/ssjjhq/getHistoryData?cycleType=<32|33>&marketId=1&code=<code>`, same Referer. `cycleType=32` = daily, `cycleType=33` = weekly (empirically confirmed by testing 5/6/7/8/16/33/40/48 — 7/8/16 are intraday minute bars, 32/33 are the only two that returned clean day-spaced/week-spaced rows). `marketId=1` works for both SZSE stocks (e.g. `000001` 平安银行) and SZSE indices (e.g. `399001` 深证成指) — SZSE does not distinguish stock vs. index by market id, only by code. Row shape is **undocumented by SZSE** and was reverse-engineered from the data: `[date, open, close, low, high, change, change_pct, volume, amount]` (confirmed by checking `low <= open,close <= high` holds across every row, and that `close + (-change) ≈` the visible previous close).
- **SSE public quote system (yunhq)** — `http://yunhq.sse.com.cn:32041/v1/sh1/...`. **Plain HTTP only** — the documented TLS port did not respond from this environment; HTTP did. `/dayk/<code>?begin=-N&end=-1&period=day|week` gives OHLCV bars for any SSE code OR SSE index under the single `sh1` namespace (`000001` 上证指数 and `600519` 贵州茅台 both resolve through the same path — SSE doesn't separate stock/index namespaces either). Row = `[date(YYYYMMDD), open, high, low, close, volume, amount]`. `/list/exchange/equity?select=...&begin=&end=` returns the full SSE equity board (~2,358 rows) as one paged call: `[code, name, last, chg_rate_pct, volume, amount]` — no per-row OHLC, just last/change/volume/turnover, and it is a **live/latest-session snapshot**, not addressable by an arbitrary past date (tested: no date parameter changes the result).
- **SSE bulletins** — `https://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do?productId=<code>` (JSONP, `Referer: https://www.sse.com.cn/disclosure/listedinfo/announcement/`). The working parameter is **`productId`** — `securityCode` / `SECURITY_CODE` (which the site's own `commonQuery.do?sqlId=COMMON_PL_SSGSXX_ZXGG_NUM_L` count-endpoint accepts) are silently ignored by this endpoint and return `total: 0`. Server-side `beginDate`/`endDate` also return `total: 0` regardless of format tried — the `since` filter in this pack is applied **client-side** against the returned `SSEDATE` field, paging back through `pageHelp.pageNo` until either enough rows are collected or the page's oldest date passes `since`.

## What isn't built, and why

- **No literal 主力资金净流入 (large-order-classified net capital inflow).** Neither SZSE nor SSE publishes that computed metric — it's a vendor number (East Money / 同花顺-style trackers compute it from tick-level order classification). `push2.eastmoney.com` is confirmed empty from any non-China IP (see `docs/china-vertical-plan.md` and `project_china_ashares_pack` memory) and is out of scope for this SZSE/SSE-sourced pack regardless. `ashares_sector_flows` instead reports SZSE's own official per-industry **turnover** ranking — a real, live, exchange-published number that answers the same "which sectors are hot today" question, labeled honestly as turnover rather than inflow.
- **No full-market bar set for an arbitrary past date.** The only bulk full-market endpoint found (SSE yunhq's board list) is a live/latest-session snapshot. SZSE's per-stock snapshot report (`1815_stock_snapshot`) requires a specific security code per call, so reconstructing a market-wide set for a past date would mean ~2,900 SZSE calls plus the SSE side — not viable as a single tool call. `ashares_market_bars` always returns the latest available SSE session and says so explicitly (`date_note`) if the requested date doesn't match, rather than silently substituting or fabricating rows. SZSE is not covered by this tool at all (no equivalent single-call bulk endpoint was found within the research budget) — flagged in the tool description and in the fleet task close note as an open gap, not silently dropped.
- **`ashares_market_bars` and `ashares_bulletins` are SSE-only.** No SZSE equivalent of the bulk board list or the bulletin API was found in the time available; SZSE bulletins live under a different disclosure system (`www.szse.cn/disclosure/`) not yet probed for this pack.

## Traps for the next person

- Every SZSE and SSE endpoint here 403s/400s without the exact `Referer` shown above.
- SSE's `queryCompanyBulletinNew.do` param name mismatch (`productId` not `securityCode`) is invisible from the metadata — the response happily echoes back whatever param name you send under `securityCode` in its JSON, even the wrong one, and still returns `total: 0`. Only `productId` actually filters.
- `yunhq.sse.com.cn:32041` is HTTP-only from this environment; don't waste a retry loop on HTTPS.
- SZSE's `ssjjhq/getHistoryData` field order is not documented anywhere public — re-verify with the `low <= min(open,close)` / `high >= max(open,close)` sanity check if SZSE ever changes their payload shape.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-exchange-data": {
      "url": "https://gateway.pipeworx.io/china-exchange-data/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-exchange-data/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1764+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ashares_sector_flows \
  -H 'Content-Type: application/json' \
  -d '{"top":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ashares_sector_flows`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-exchange-data": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-exchange-data"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-exchange-data
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Exchange Data data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
