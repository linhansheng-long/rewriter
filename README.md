# Rewriter

一个基于 Next.js 的多阶段 AI 写作与重写助手。支持“意图 → 多模型大纲 → 合并 → 分工写作 → 图片生成 → 终稿合并”等流水线，并把每个阶段的结果落盘到 runs/<RUN_ID>/xx_*.json 便于排查与回溯。

## 主要特性
- 多模型并发与合并：outline-multi、outline-merge、write-sections、merge-assembly、final-merge 等阶段可按配置选择模型提供方。
- 图片生成与内联插图：image-generation 支持接入第三方图像服务；在 final-merge 阶段，图片会按章节标题（H2）内联到正文，无法匹配的保留“图片预览”兜底区块。
- 快照与可追溯性：每次运行会在 runs/ 目录下生成阶段快照（01_intent.json … 08_final-merge.json），定位问题更直观。
- 本地可配置：providers、stageProviders、imageProviders 等通过 data/config.json 持久化保存；.env.local 可选。

## 目录结构速览
- app/        应用入口与 API 路由（/api/...），UI 在 app/page.tsx
- lib/        配置、提示词、流水线与类型定义（例如 lib/pipeline.ts, lib/config.ts）
- runs/       每次运行的快照输出（按时间戳+UUID 分目录）
- public/     静态资源

## 快速开始
前置：建议 Node.js ≥ 18，已安装 npm。

1) 安装依赖
```
npm install
```

2) 启动开发服务器（固定 3002 端口）
```
npm run dev
```
打开浏览器访问 http://localhost:3002 即可。

3) 基本使用
- 在页面的设置区域启用需要的模型/图片供应商并填写凭据；
- 点击开始运行，右侧将实时展示各阶段日志与最终 Markdown；
- 所有阶段输出会写入 runs/<RUN_ID>/ 目录，可用来对照终稿。

## 配置说明
- 持久化文件：data/config.json（已被 .gitignore 忽略）
- 环境变量：.env.local（已被 .gitignore 忽略）
- 运行快照：runs/（默认未忽略，若仓库需精简体积，可自行将 runs/ 加入 .gitignore）

## 构建与部署
```
npm run build
npm run start
```
同样使用 3002 端口提供服务。

## 常见问题
- 看到 ResizeObserver 警告：一般来自可视化/日志区域的尺寸监听，通常不影响功能；如需，后续可增加节流/延迟测量降低噪声。

## 许可证

