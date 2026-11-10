# ADR-0004：文件预览用字节通道 + 扩展名分派，不引第三方渲染库

状态：已采纳 · 2026-11

## 背景

右栏预览原本只有一种形态：服务端 `readWorkspaceFile()` 读 UTF-8 文本，前端 `<pre>` 原样铺开。它连图片都打不开（二进制直接 `415`），更谈不上 PDF、Word、表格。

要做「常见文件都能看，而且看得像这个产品」，绕不开三个决定：

1. 二进制字节怎么送到浏览器；
2. 前端按什么规则挑渲染方式；
3. PDF / Word / Excel 这些重格式，是自己渲染、引库，还是交给平台。

约束是真实的：这是跑在用户机器上的单人工具，文档 CSP 是 `default-src 'none'`，依赖每加一个都要算体积与供应链账。

## 候选方案

**A. 全部塞进 `files/content`，用 base64 返回**
- 优点：不加路由。
- 缺点：1 MiB 上限下 base64 再涨 33%，内存双份；`<img src>` / `<video src>` / Range 全都用不上。否决。

**B. 二进制走独立 `files/raw`，渲染交给现成库**（pdfjs-dist + docx-preview + SheetJS）
- 优点：保真度最高，PDF 能自绘工具栏、Word 能还原分页。
- 缺点：pdfjs 133 kB gz + worker + cMaps；docx-preview 49 kB；SheetJS 已从 npm 撤源且旧版有 CVE。对一个侧边面板，这份预算是花在「更像 Acrobat」上。

**C. 二进制走独立 `files/raw`，PDF 交给浏览器，Office 用平台能力自解**
- 优点：零新增依赖。PDF 由浏览器自带阅读器渲染（选区、搜索、打印、表单全都有）；`.docx`/`.xlsx` 本质是 ZIP + XML，`DecompressionStream('deflate-raw')` 加 `DOMParser` 足够解出结构与表格。
- 缺点：Word 只能还原结构（标题、段落、列表、表格、对齐），不还原版式；PDF 的界面归浏览器，无法与主题统一。

**D. 服务端转 HTML/PDF**（LibreOffice、soffice）
- 优点：保真度与格式覆盖最好。
- 缺点：要在用户机器上找并驱动外部二进制，失败模式复杂、启动慢、还要处理临时文件与并发。为一个预览功能引入这种依赖不划算。否决。

## 决定

采用 **C**，并把它拆成三层：

- **L1 传输**：`GET|HEAD /api/workspaces/:id/files/raw?path=&download=1`，流式、支持单区间 Range、按扩展名白名单给 `content-type`。白名单之外的扩展名（包括 `text/html`）一律 `application/octet-stream` + `attachment`，所以这个路由永远不会变成 XSS 出口。文案与错误码见 [web-api.md](../web-api.md)。
- **L2 分派**：`ui/src/components/preview/path.ts` 用扩展名判定 `PreviewKind`，顺序固定（`svg` 先于 code、`csv` 先于 code、`ipynb` 归 JSON），再由 `registry.ts` 的一张表映射到 viewer。禁用某类型 = 删一行。
- **L3 呈现**：`PreviewSurface` + `PreviewChrome` 提供统一外壳与状态机，`viewers/*` 各自渲染。

配套的两个判断：

- **CSP 只放开 `frame-src 'self'` 与 `media-src 'self'`**：PDF 走同源 iframe，音视频走同源 `<video>`/`<audio>` 直接吃 Range。不放开 `object-src`，也不引 `worker-src`（没有 wasm/worker 需求）。
- **HTML 不用 sandbox iframe**：`srcdoc` 与 `blob:` 文档都继承创建者的 CSP，在 `default-src 'none'` 下只会渲染出一张白纸；改用 `html/sanitize.ts` 的白名单净化后内联渲染，既保住主题也保持惰性。

## 后果

- 主包不增长（新增代码全部是几百行的纯前端模块），没有新的供应链与审计面；`pnpm add` 也就不再是这项功能的先决条件。
- Word 预览是「阅读视图」而非「打印视图」：页边距、浮动图形、页眉页脚、自定义主题不还原，嵌入图片只报数量不显示。这一点写在 §11 的已知限制里，并通过下载 / 新窗口打开兜底。
- Excel 只读单元格原值：日期、货币格式与公式结果按存储值显示。
- PDF 的阅读器界面由浏览器决定，深浅色跟随系统而非应用主题。
- 若日后确实需要版式级 Word 预览，只需替换 `registry.ts` 里 `docx` 那一行，字节通道和外壳都不用动 —— 这是把分派表单独拿出来的主要理由。
