# sitemap 批量提交到百度

输入一个或多个 `sitemap.xml` 地址，自动解析出其中的全部 URL，并按百度「链接推送」接口要求（每行一条、`text/plain`）批量提交。

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
| `BAIDU_SITE` | 备用站点值，仅在无法从 sitemap 推断时使用 |
| `BAIDU_TOKEN` | 推送准入密钥（只在服务端使用，不会下发到浏览器） |
| `BAIDU_ENDPOINT` | 百度推送接口地址，仅用于本地联调，默认 `http://data.zz.baidu.com/urls` |

## 使用方式

1. 在页面的多行输入框里填写 sitemap 地址，**每行一个**，可以填多个（例如 `sitemap.xml`、`sitemap-products.xml`、`sitemap-blog.xml`）。
2. 填入 token（token 对所有 sitemap 共用）；留空时使用环境变量。
3. **站点（site）留空即可**，每个 sitemap 会自动取自己链接中出现最多的裸域名；只有当自动推断不符合预期时才需要手动填写。
4. 先点「仅解析预览」确认每个 sitemap 的解析情况、推断出的站点与链接数量。
5. 点「开始提交」，页面展示各 sitemap 的解析结果、域名分布，以及逐条 URL 的推送结果。

**每个 sitemap 独立提交**：某个 sitemap 部分失败或整体失败（配额用尽、接口报错、网络异常、链接被全部过滤）都不会影响后面的 sitemap，它们会继续提交。

## 行为说明

- 支持 sitemap 索引（`<sitemapindex>`），自动递归展开，最多 5 层、50 个子 sitemap。
- 支持 `.xml.gz` 压缩文件。
- 可一次填写多个 sitemap 地址（每行一个，token 共用）：**逐个提交、互不影响**。
  - 第一个 sitemap 只有部分链接成功时，后面的 sitemap 照常提交；
  - 第一个 sitemap 整体失败（`over quota`、接口报错、网络异常）时，后面的 sitemap 照常提交，失败原因只显示在该 sitemap 那一行；
  - 每个 sitemap 留空 site 时各自推断站点，不同域名的 sitemap 推送给各自的站点，配额也按站点分别计算；
  - 同一个 URL 出现在多个 sitemap 中时只推送一次，后续 sitemap 中标记为「未重复提交」；
  - 提交过程中显示「正在处理第 N/M 个 sitemap」。
- `site` 填裸域名（如 `www.example.com`）；留空则自动取 sitemap 链接中出现最多的裸域名，填了则以填写的为准。带 `https://` 也会自动规范化，否则百度会返回 `site init fail`。
- 百度按请求条数整批校验当天剩余额度：先用 1 条探测拿到 `remain`，再按 `min(2000, remain)` 分批提交，配额耗尽时保留已成功的结果并提示剩余未提交条数。
- 默认过滤掉与 `site` 不同域名的链接（可在页面上关闭）；若某个 sitemap 的链接全部被过滤，会在该 sitemap 行上说明，不影响其它 sitemap。
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
│  ├─ site.ts               # site 规范化与自动推断
│  └─ sitemap.ts            # sitemap 抓取与解析（含多 sitemap 批量解析）
├─ scripts/
│  ├─ test-push.ts            # 推送客户端单元测试（mock fetch，不产生真实推送）
│  ├─ test-push-groups.ts     # 分组推送 / 配额耗尽行为测试
│  ├─ test-sitemap-batch.ts   # 批量解析测试（mock fetch）
│  ├─ test-site.ts            # 站点推断测试
│  ├─ test-submit-route.ts    # 接口级测试：某个 sitemap 失败不影响后续 sitemap
│  ├─ test-e2e-overlap.js     # 端到端联调（需先起开发服务器）：跨 sitemap 去重、配额耗尽与接口报错的失败隔离
│  ├─ test-e2e-failover.js    # 端到端联调：假 sitemap 服务 + 假百度接口
│  └─ test-sitemap-server.js  # 本地 sitemap 样例服务器
├─ .env.example
├─ 需求.md
└─ README.md
```

## 本地测试

`npm test` 运行全部单元测试（mock 掉 fetch，不会产生真实推送，也不会真实推送给百度）。

`scripts/test-sitemap-server.js` 是一个本地 sitemap 样例服务器（端口 8899），可用来在没有真实站点的情况下自测：

```bash
node scripts/test-sitemap-server.js
# 然后在页面每行填写一个地址：
#   http://localhost:8899/sitemap.xml
#   http://localhost:8899/sitemap-2.xml
#   http://localhost:8899/sitemap-index.xml   （测试 sitemap 索引展开）
#   http://localhost:8899/missing.xml         （测试单个 sitemap 失败不影响其它）
```

`scripts/test-e2e-failover.js` 会同时启动假 sitemap 服务（8899）和一个假百度接口（8900，每批只接受 10 条，用来模拟「提交 10 个、其余失败」）。配合环境变量可以在不触碰真实百度接口的情况下验证「某个 sitemap 失败后，后面的 sitemap 仍然继续提交」：

```bash
node scripts/test-e2e-failover.js
BAIDU_ENDPOINT=http://localhost:8900/urls npm run dev
# 页面填写：
#   http://localhost:8899/sitemap.xml     （100 条链接）
#   http://localhost:8899/sitemap-2.xml   （20 条链接）
# 观察：第一个 sitemap 成功 10 条、其余失败，但第二个 sitemap 依然会提交
```

`scripts/test-e2e-overlap.js` 是**自动化**的端到端测试，覆盖三个关键场景并逐项断言：

1. **跨 sitemap 去重**：两个 sitemap 有 5 条重叠链接 → 重叠链接只推送给百度一次，另一份标记为「未重复提交」；
2. **配额耗尽隔离**：第一个 sitemap 配额用尽 → 第二个 sitemap（不同站点）仍然提交成功；
3. **接口报错隔离**：第一个 sitemap 返回 token 失效 → 第二个 sitemap（不同站点）仍然提交成功。

它需要真实 HTTP 调用，因此要先起一个指向假百度接口的开发服务器。脚本会自行拉起假 sitemap 服务（8899）与假百度接口（8900），**不要**另外启动 `test-e2e-failover.js`，否则端口会冲突：

```bash
# 终端 1：让开发服务器指向假百度接口
BAIDU_ENDPOINT=http://localhost:8900/urls BAIDU_TOKEN=test-token npx next dev -p 3111
# 终端 2：执行断言（脚本自带假 sitemap 服务与假百度接口）
npm run test:e2e
```

## 需求文档

更完整的功能说明、接口约定与验收标准见 [需求.md](./需求.md)。
