# sitemap 批量提交到百度

输入一个 `sitemap.xml` 地址，自动解析出其中的全部 URL，并按百度「链接推送」接口要求（每行一条、`text/plain`）批量提交。

## 快速开始

```bash
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
npm run dev
```

打开 http://localhost:3000 。

环境变量（可选，页面里也能直接填）：

| 变量 | 说明 |
| --- | --- |
| `BAIDU_SITE` | 百度验证过的站点，如 `www.example.com` |
| `BAIDU_TOKEN` | 推送准入密钥（只在服务端使用，不会下发到浏览器） |

## 使用方式

1. 在页面填入 sitemap 地址（如 `https://www.example.com/sitemap.xml`）。
2. 可选：填入 site 与 token；留空时使用环境变量。
3. 先点「仅解析预览」确认链接数量与内容。
4. 点「开始提交」，页面展示解析数量、推送成功条数、当天剩余额度以及异常明细。

## 行为说明

- 支持 sitemap 索引（`<sitemapindex>`），自动递归展开，最多 5 层、50 个子 sitemap。
- 支持 `.xml.gz` 压缩文件。
- `site` 填裸域名（如 `www.example.com`）；带 `https://` 也会自动规范化，否则百度会返回 `site init fail`。
- 百度按请求条数整批校验当天剩余额度：先用 1 条探测拿到 `remain`，再按 `min(2000, remain)` 分批提交，配额耗尽时保留已成功的结果并提示剩余未提交条数。
- 默认过滤掉与 `site` 不同域名的链接（可在页面上关闭）；若全部被过滤会给出提示与域名分布。
- 链接自动去重。
- 推送完成后逐条列出每个 URL 的结果：成功 / 失败（非本站链接、链接不合法、百度未确认接收）/ 未提交（配额用尽），可按「全部 / 成功 / 失败」筛选。

## 常见错误

| 页面提示 | 原因 | 处理 |
| --- | --- | --- |
| `site init fail` | `site` 带了协议头，或站点未在该 token 的账号下验证 | 填裸域名，确认站点已验证 |
| `site error` | `site` 与 token 不匹配 | 确认站点与密钥归属 |
| `token is not valid` | 密钥错误 | 核对搜索资源平台的准入密钥 |
| `over quota` | 当天推送配额已用尽，本次提交条数超过剩余额度 | 配额按天重置，次日再推 |
| `not same site` | sitemap 中的链接域名与 `site` 不一致 | 核对 site 与 sitemap 域名 |

## 目录结构

```
submit_url/
├─ app/
│  ├─ api/submit/route.ts   # 解析 + 推送接口
│  ├─ globals.css
│  ├─ layout.tsx
│  └─ page.tsx
├─ components/SubmitForm.tsx
├─ lib/
│  ├─ baidu.ts              # 百度推送客户端
│  └─ sitemap.ts            # sitemap 抓取与解析
├─ .env.example
├─ 需求.md
└─ README.md
```

## 本地测试

`npm test` 运行推送客户端的单元测试（mock 掉 fetch，不会产生真实推送）。

`scripts/test-sitemap-server.js` 是一个本地 sitemap 样例服务器（端口 8899），可用来在没有真实站点的情况下自测：

```bash
node scripts/test-sitemap-server.js
# 然后在页面填入 http://localhost:8899/sitemap.xml
# 或 http://localhost:8899/sitemap-index.xml（用于测试 sitemap 索引展开）
```

## 需求文档

更完整的功能说明、接口约定与验收标准见 [需求.md](./需求.md)。
