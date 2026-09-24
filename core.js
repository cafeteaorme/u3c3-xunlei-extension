/* u3c3 搜索·迅雷版 - 核心逻辑：番号识别 + u3c3 结果页解析（与 UGOS 版共用同一套站点适配）
 * 弹窗与 Node 测试共用；纯字符串解析，不依赖 DOM。
 * 解析规则基于 2026-09 对 u3c3.com 线上页面的实测：
 *   - 搜索地址: /?search2=<token>&search=<关键词>
 *   - token 是站点页面 search21() 里写死的 nmefafej 变量（字符集 [A-Za-z0-9]，含大写），
 *     会不定期轮换；带过期 token 请求时站点不报错，而是静默返回"最新发布"列表，
 *     因此必须动态提取 token（extractToken），并对降级页面自动重试
 *   - 结果行: <tr> 内含 <a href="/view?id=<hash>" title="标题"> 与 <a href="magnet:?xt=urn:btih:...">
 *   - 置顶广告行的标题链接指向分类页/外站（无 /view?id=），据此过滤
 *   - 站点搜不到时同样返回无关条目，必须按番号做标题相关性校验
 */
(function (global) {
  'use strict';

  const HOME_URL = 'https://u3c3.com/';
  const FALLBACK_TOKEN = 'uebehoye'; // 2026-09-17 观测值；仅当首页提取失败时兜底
  const MAX_ITEMS = 30;

  function searchUrl(token, keyword) {
    return HOME_URL + '?search2=' + encodeURIComponent(token) +
      '&search=' + encodeURIComponent(keyword);
  }

  // 从页面 JS 里提取当前搜索 token（跳过 // 注释掉的旧值；
  // 站点 token 生成字符集为 [a-zA-Z0-9]，可能含大写）
  function extractToken(html) {
    if (!html) return null;
    let token = null;
    for (let line of String(html).split('\n')) {
      const t = line.trim();
      if (t.indexOf('//') === 0) continue;
      const m = t.match(/nmefafej\s*=\s*"([A-Za-z0-9]+)"/);
      if (m) token = m[1];
    }
    return token;
  }

  // —— 番号识别：按规格 a → b → c 顺序，命中即返回 ——
  // 常见技术词排除，避免把 "IOS18" "HD-720" 之类误判为番号
  const TECH_WORDS = new Set([
    'IOS', 'IPADOS', 'MACOS', 'TVOS', 'WATCHOS', 'WIN', 'OSX',
    'HD', 'SD', 'TS', 'HEVC', 'AVC', 'MP4', 'MKV', 'WMV', 'FLAC', 'AAC',
    'HDMI', 'USB', 'WIFI', 'SSD', 'HDD', 'HDR', 'SDR', 'UHD', 'GPS', 'NFC',
    'OLED', 'LCD', 'CPU', 'GPU', 'RAM', 'RGB', 'BIOS', 'UEFI', 'NVME',
    'PCIE', 'APK', 'EXE', 'ISO', 'PDF', 'UTF8', 'UUID'
  ]);
  // a. 英文-数字，如 ABF-385（兼容 abf385 / abf-385 小写、无连杠写法）
  const RE_LETTER_NUM = /\b([A-Za-z]{2,6})-?(\d{2,5})\b/;
  // b. FC2PPV+数字，如 FC2PPV 4978035（兼容 FC2-PPV-4978035 / FC2 PPV 4978035）
  const RE_FC2 = /\bFC2[-_ ]?PPV[-_ ]?(\d{6,10})\b/i;
  // c. 纯数字编号，如 091726-001（兼容下划线 091726_001）
  const RE_NUM_NUM = /\b(\d{6,8})[-_](\d{3})\b/;

  function extractCode(title) {
    if (!title) return null;
    const t = String(title).replace(/\s+/g, ' ');
    let m = t.match(RE_LETTER_NUM);
    if (m && !TECH_WORDS.has(m[1].toUpperCase())) {
      return m[1].toUpperCase() + '-' + m[2];
    }
    m = t.match(RE_FC2);
    if (m) return 'FC2PPV ' + m[1];
    m = t.match(RE_NUM_NUM);
    if (m) return m[1] + '-' + m[2];
    return null;
  }

  // —— HTML 工具 ——
  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&'); // &amp; 最后还原
  }

  // 展示用标题：去转发站前缀（xxx.xyz@）、去 .torrent 后缀
  function cleanTitle(raw) {
    let s = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    s = s.replace(/^[a-z0-9.\-]+\@/i, '');
    s = s.replace(/\.torrent$/i, '');
    return s.trim();
  }

  // 相关性校验：忽略空格/连杠/下划线/点/@/波浪线/各类括号后做包含匹配
  //（括号剥离让「【FC2PPV】4744486」这类前缀与数字被隔开的写法也能命中）
  function normKey(s) {
    return String(s).replace(/[\s\-_.@～~【】\[\]（）()「」『』]/g, '').toUpperCase();
  }

  // FC2 番号放宽：前缀写法不限（FC2PPV-4744486 / FC2 4744486 / fc2-ppv… 均命中），
  // 但必须带 FC2 前缀且数字串完整（防 300MIUM4744486 这类误报）
  function matchesCode(title, code) {
    if (!code) return true;
    if (code.indexOf('FC2PPV ') === 0) {
      const id = code.slice(7);
      if (!/^\d+$/.test(id)) return false;
      const nt = normKey(title);
      return nt.indexOf('FC2PPV' + id) !== -1 || nt.indexOf('FC2' + id) !== -1;
    }
    return normKey(title).indexOf(normKey(code)) !== -1;
  }

  // —— 结果解析（纯字符串）——
  // 只认标题链接为 /view?id=<hash> 的行：过滤置顶广告行；
  // 标题一律取 title 属性（正文可能被 Cloudflare 混淆成 [email protected]）。
  // 返回 { items, realRows }：realRows 是未做相关性过滤的真实行数，
  // 用于区分"页面无结果行"与"有行但都不匹配（token 过期降级页）"。
  function parsePage(html, code) {
    const items = [];
    let realRows = 0;
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = trRe.exec(html)) !== null) {
      const seg = m[1];
      const lm = seg.match(/<a\s+[^>]*href="(\/view\?id=[0-9a-f]{16,64})"[^>]*>/i);
      if (!lm) continue;
      realRows++;
      if (items.length >= MAX_ITEMS) continue;
      const tm = lm[0].match(/title="([^"]*)"/i);
      const title = cleanTitle(tm ? tm[1] : '');
      if (!title || !matchesCode(title, code)) continue;
      const mm = seg.match(/<a\s+[^>]*href="(magnet:\?[^"]+)"/i);
      if (!mm) continue;
      const magnet = decodeEntities(mm[1]);
      // 磁力锚点之后第 1、2 个 td 依次为尺寸、日期
      const tail = seg.slice(seg.indexOf(mm[0]) + mm[0].length);
      const tdRe = /<td[^>]*>\s*([^<]*?)\s*<\/td>/gi;
      let size = '', date = '';
      const t1 = tdRe.exec(tail);
      if (t1) size = decodeEntities(t1[1]).trim();
      const t2 = tdRe.exec(tail);
      if (t2) date = decodeEntities(t2[1]).trim();
      items.push({
        title: title,
        magnet: magnet,
        size: size,
        date: date,
        hash: (lm[1].split('=')[1] || '')
      });
    }
    return { items: items, realRows: realRows };
  }

  function parseResults(html, code) {
    return parsePage(html, code).items;
  }

  // —— 搜索编排（浏览器与 Node 共用，fetch 可被测试 mock） ——
  async function fetchText(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // —— 查询变体：u3c3 服务端按字面子串匹配，不同写法召回不同 ——
  // FC2PPV 4744486 → 只查数字（召回全集，客户端过滤收口）
  // ABF-385 → 补查 ABF385；091726-001 → 补查 091726_001
  function queryVariants(code) {
    if (code.indexOf('FC2PPV ') === 0) return [code.slice(7)];
    let m = code.match(/^([A-Z]+)-(\d+)$/);
    if (m && m[2].length <= 5) return [code, m[1] + m[2]];
    m = code.match(/^(\d{6,8})-(\d{3})$/);
    if (m) return [code, m[1] + '_' + m[2]];
    return [code];
  }

  // 完整搜索流程：首页取最新 token → 逐个查变体并合并去重 →
  // 若"有结果行但都不匹配"（token 刚被轮换的降级页）→ 换新 token 重试
  async function searchCode(code) {
    const token = extractToken(await fetchText(HOME_URL)) || FALLBACK_TOKEN;
    let items = [];
    const seen = new Set();
    let hitVariant = false, anyRealRows = false, lastPage = '';
    for (const q of queryVariants(code)) {
      lastPage = await fetchText(searchUrl(token, q));
      const parsed = parsePage(lastPage, code);
      if (parsed.realRows > 0) anyRealRows = true;
      if (parsed.items.length) hitVariant = true;
      for (const it of parsed.items) {
        if (!seen.has(it.hash)) { seen.add(it.hash); items.push(it); }
      }
    }
    if (!hitVariant && anyRealRows) {
      // 全部变体都零命中但页面有真实行：疑似 token 过期的降级页，
      // 用降级页内的新 token 重查首个变体
      const fresh = extractToken(lastPage);
      if (fresh && fresh !== token) {
        const parsed = parsePage(await fetchText(searchUrl(fresh, queryVariants(code)[0])), code);
        if (parsed.items.length) return parsed.items;
      }
    }
    return items;
  }

  const api = {
    HOME_URL: HOME_URL,
    FALLBACK_TOKEN: FALLBACK_TOKEN,
    MAX_ITEMS: MAX_ITEMS,
    searchUrl: searchUrl,
    extractToken: extractToken,
    extractCode: extractCode,
    parsePage: parsePage,
    parseResults: parseResults,
    fetchText: fetchText,
    searchCode: searchCode,
    queryVariants: queryVariants,
    cleanTitle: cleanTitle,
    matchesCode: matchesCode,
    decodeEntities: decodeEntities
  };

  global.U3C3 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
