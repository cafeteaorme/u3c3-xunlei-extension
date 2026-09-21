/* u3c3 搜索·迅雷版 - 迅雷 pan-auth token
 * 实测（2026-09-21，迅雷 3.23.5 / cnk3x/xunlei 容器）：
 * 版本 ≥3.21.0 时 token 是烘焙在面板 HTML 里的 JWT：
 *   <script>function uiauth(value){ return "eyJhbGciOi..." }</script>
 * 提取即可用（有效期约 3.4 天），无需执行任何 JS。
 *（<3.21.0 的老版本才用 GetXunLeiToken(now) 的 MD5 算法，这里不需要。）
 * UMD：浏览器与 Node 测试共用。 */
(function (global) {
  'use strict';

  // 从面板 HTML 提取 uiauth JWT；失败返回 null
  function extractTokenFromHtml(html) {
    if (!html) return null;
    const m = String(html).match(/function\s+uiauth\s*\([^)]*\)\s*\{\s*return\s+"([^"]+)"/);
    return m ? m[1] : null;
  }

  const api = { extractTokenFromHtml: extractTokenFromHtml };
  global.U3C3XLAUTH = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
