# 基金日记

五只持仓基金的「前一天预测、后一天复盘」日记，PWA，部署在 GitHub Pages，运行不依赖 Claude。

## 自动更新
- **每晚 22:13（北京时间）**：抓天天基金净值 → 滚动更新持仓金额 → 复盘当日预测、沉淀经验 → 预测下一交易日
- **交易日 8:07**：结合隔夜美股收盘定稿当日预测（晚间版本保存在 `predsEvening`）；9:25 之后不再修改
- 数据源：天天基金（净值、指数、板块、快讯），新浪财经作备用；AI 用 Gemini 免费额度（不带搜索）
- GitHub 定时任务高峰期可能延迟几十分钟；Actions 页面可手动 Run workflow

## 配置
- Settings → Secrets and variables → Actions：`GEMINI_API_KEY`（可选变量 `GEMINI_MODEL`）
- Settings → Pages：Deploy from branch，`main` / root

## 手动维护
- 加减仓：改 `data/funds.json` 里对应基金的 `amount`、`pnl`，`navDate` 设为金额对应的净值日期
- 休市日：每年 12 月交易所公布次年安排后，补进 `data/calendar.json`
- 经验库：`data/diary.json` 的 `lessons`，可手动增删

预测仅作记录与复盘练习，不构成投资建议。
