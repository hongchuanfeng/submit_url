/**
 * URL 列表解析与校验的单元测试
 * 运行：npx tsx scripts/test-urls.ts
 */
import { parseUrlList, validateUrl } from '../lib/urls';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// 校验单个 URL
assert(validateUrl('https://www.example.com/a').ok === true, 'https 地址合法');
assert(validateUrl('http://www.example.com/a').ok === true, 'http 地址合法');
assert(validateUrl('www.example.com/a').ok === false, '缺少协议头的地址不合法');
assert(validateUrl('ftp://www.example.com/a').ok === false, 'ftp 协议不合法');
assert(validateUrl('').ok === false, '空字符串不合法');
assert(validateUrl('not a url').ok === false, '乱码字符串不合法');

// 解析多行输入
const parsed = parseUrlList(
  [
    'https://www.example.com/a',
    '  https://www.example.com/b  ',
    '',
    'https://www.example.com/a',
    'bad-url',
  ].join('\n'),
);

assert(parsed.inputCount === 4, '空行被忽略，非空行计数正确');
assert(parsed.urls.length === 2, '去重后剩下 2 条有效链接');
assert(parsed.entries.length === 4, '每个非空输入都有一条对应记录');
assert(parsed.entries[0].kind === 'valid', '第一条是有效链接');
assert(parsed.entries[1].kind === 'valid', '首尾空白被去除');
assert(parsed.entries[2].kind === 'duplicate', '重复链接被识别');
assert(parsed.entries[2].firstIndex === 0, '重复链接指向首次出现的位置');
assert(parsed.entries[3].kind === 'invalid', '非法链接被识别');
assert(parsed.entries[3].reason?.includes('http') === true, '非法链接给出原因说明');

// 支持数组输入
const parsedArray = parseUrlList(['https://www.example.com/a', 'https://www.example.com/b']);
assert(parsedArray.urls.length === 2, '数组输入被正确解析');
assert(parsedArray.inputCount === 2, '数组输入的条数正确');

// 空输入
const empty = parseUrlList(undefined);
assert(empty.inputCount === 0, '未提供输入时条数为 0');
assert(empty.urls.length === 0, '未提供输入时没有链接');

const emptyString = parseUrlList('\n\n  \n');
assert(emptyString.inputCount === 0, '全是空行时条数为 0');
