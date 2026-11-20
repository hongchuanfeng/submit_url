const checks = [
  ['sitemap 提交页签', 'sitemap \u63d0\u4ea4'],
  ['URL 批量提交页签', 'URL \u6279\u91cf\u63d0\u4ea4'],
  ['tablist 容器', 'role="tablist"'],
  ['sitemap 输入框', 'sitemapUrls'],
  ['激活态样式类', 'tab active'],
];

async function main() {
  const html = await (await fetch('http://localhost:3111/')).text();
  let bad = 0;

  for (const [label, needle] of checks) {
    const ok = html.includes(needle);
    if (!ok) bad += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  }

  // 页签内容是客户端渲染的：确认 UrlSubmitForm 已被打进页面 chunk。
  // 页面 chunk 的文件名在开发与生产构建下不同，这里按引用关系查找。
  const scripts = [...html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)].map((m) => m[0]);
  let found = false;
  for (const src of scripts) {
    const chunk = await (await fetch('http://localhost:3111' + src)).text();
    if (chunk.includes('urlList')) {
      found = true;
      break;
    }
  }
  console.log(`${found ? 'PASS' : 'FAIL'}: URL 提交表单已打包进客户端 chunk`);
  if (!found) bad += 1;

  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项未通过`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
