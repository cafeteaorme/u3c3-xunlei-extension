/* 搜索召回修复测试：FC2 变体过滤 + 多查询合并。
 * 复现样本来自 2026-09-21 真实对比：u3c3 服务端字面子串匹配下
 * "FC2PPV 4744486"=1 条 / "FC2-PPV-4744486"=5 条 / "4744486"=8 条。
 * 运行：node test/recall.test.mjs */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../config.js');
require('../xlauth.js');
const U3C3 = require('../core.js');

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + '\n    期望: ' + e + '\n    实际: ' + a); }
}
function ok(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
}

console.log('queryVariants:');
eq(U3C3.queryVariants('FC2PPV 4744486'), ['4744486'], 'FC2 → 纯数字查询');
eq(U3C3.queryVariants('ABF-385'), ['ABF-385', 'ABF385'], '英数番号 → 原式+无连杠');
eq(U3C3.queryVariants('091726-001'), ['091726-001', '091726_001'], '数字编号 → 原式+下划线');
eq(U3C3.queryVariants('奇怪格式'), ['奇怪格式'], '未知格式原样');

console.log('matchesCode（FC2 放宽）:');
const CODE = 'FC2PPV 4744486';
ok(U3C3.matchesCode('[HD/720p] FC2PPV 4744486 これぞ…', CODE), 'FC2PPV 空格式命中');
ok(U3C3.matchesCode('FC2-PPV-4744486 ②これぞ…', CODE), 'FC2-PPV 连杠式命中');
ok(U3C3.matchesCode('[无码破解] FC2PPV-4744486 - これぞ…', CODE), 'FC2PPV- 连杠式命中');
ok(U3C3.matchesCode('FC2PPV-4744486', CODE), '裸编号标题命中');
ok(!U3C3.matchesCode('(C99) 无关同人志', CODE), '无关标题拒绝');
ok(!U3C3.matchesCode('300MIUM4744486 别的系列', CODE), '更长数字串的一部分拒绝');
ok(!U3C3.matchesCode('FC2-PPV-147444865', CODE), 'FC2 前缀但数字串更长拒绝');
ok(U3C3.matchesCode('【FC2-PPV】4744486', CODE), '前缀与数字分离的写法命中');

console.log('searchCode（多查询合并去重，mock 站点字面匹配）:');
{
  const ROW = (hash, title) => `<tr class="default">
<td><a href="/view?id=${hash}" title="${title}" target="_blank">${title}</a></td>
<td class="text-center"><a href="magnet:?xt=urn:btih:${hash}&amp;tr=udp%3A%2F%2Ft">m</a></td>
<td class="text-center">1.0GB</td><td class="text-center">2026-09-21</td><td></td><td></td></tr>`;
  const PIN = `<tr class="default"><td><a href="/?type=U3C3&amp;p=1">ad</a></td></tr>`;
  // 服务端字面匹配的忠实模拟：只有标题含查询词原文才返回该行（hash 必须十六进制）
  const ALL = [
    ['a'.repeat(40), '[HD/720p] FC2PPV 4744486 これぞ'],
    ['b'.repeat(40), 'FC2-PPV-4744486 ②これぞ'],
    ['c'.repeat(40), '[无码破解] FC2PPV-4744486 - これぞ'],
    ['d'.repeat(40), 'FC2PPV-4744486'],
    ['e'.repeat(40), 'fc2-ppv-4744486 2人にも内緒で'],
    ['f'.repeat(40), '+++ FC2-PPV-4744486 これぞ'],
    ['0a7c'.padEnd(40, '0'), '[H265] FC2-PPV-4744486 这真是'],
    ['0b8d'.padEnd(40, '0'), '[HD 720p] FC2-PPV-4744486 これぞ'],
    ['9'.repeat(40), '(C99) 完全无关的同人志']
  ];
  const HOME = '<html><script>var nmefafej = "tokB";</script></html>';
  let calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/' && !u.search) return mk(200, HOME);
    const q = u.searchParams.get('search');
    const hits = ALL.filter(([, t]) => t.includes(q));
    const rows = PIN + hits.map(([h, t]) => ROW(h, t)).join('');
    return mk(200, `<html><table class="torrent-list"><tbody>${rows}</tbody></table>${HOME}</html>`);
  };
  function mk(s, t) { return { status: s, ok: true, text: async () => t }; }

  const items = await U3C3.searchCode('FC2PPV 4744486');
  eq(items.length, 8, 'FC2 纯数字查询召回全部 8 条变体');
  eq(new Set(items.map(i => i.hash)).size, 8, '无重复（按 hash 去重）');
  ok(!items.some(i => i.title.includes('同人志')), '无关结果被过滤');
  eq(calls.filter(u => u.includes('search2=')).length, 1, 'FC2 只发一次搜索请求（纯数字）');

  // 英数番号：两个变体查询合并
  calls = [];
  const ALL2 = [
    ['1'.repeat(40), 'ABF-385 甘とろ密着エステ'],
    ['2'.repeat(40), '[ABF385] 无连杠写法']
  ];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/' && !u.search) return mk(200, HOME);
    const q = u.searchParams.get('search');
    const hits = ALL2.filter(([, t]) => t.includes(q));
    return mk(200, `<html><table class="torrent-list"><tbody>${PIN}${hits.map(([h, t]) => ROW(h, t)).join('')}</tbody></table>${HOME}</html>`);
  };
  const items2 = await U3C3.searchCode('ABF-385');
  eq(items2.length, 2, 'ABF 两种写法合并去重后 2 条');
  const qs = calls.filter(u => u.includes('search=')).map(u => decodeURIComponent(u.match(/search=([^&]*)/)[1]));
  eq(qs, ['ABF-385', 'ABF385'], '依次查询原式与无连杠变体');
}

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
