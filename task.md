# 项目任务主线（仅新增/作废标记，不删除历史）

- 初始化与基础设施
  - #+已完成 固定端口 3002 的 dev/start 脚本，提供稳定预览
  - #+已完成 数据目录 data/config.json 持久化加载与启动同步读入
- 配置与可视化增强
  - #+已完成 设置页增加“图片供应商-jimeng 测试生成”按钮与后端代理
  - #+已完成 图片生成尺寸归一化（1024/1280/1536/2048）与前端默认 1024
  - #+已完成 主题与颜色方案：记录暗色媒体查询导致的外观变化与后续可选方案
- 图片生成与流水线联调
  - #+已完成 pipeline: image-generation 仅在选择/凭据满足时调用，否则占位
  - 运行结果核验：runs/*/04c_image-generation.json 中应出现公网 URL
- 问题复现与修复跟进（AK/SK 刷新后空白 + 流程占位）
  - #+已完成 定位：后端 GET 脱敏 ak/sk + 前端保存后用返回值覆盖，导致输入框空白错觉
  - #+已完成 前端修复：
    - 图片供应商 AK/SK 使用本地临时输入状态 imgAkInputs/imgSkInputs 不再回显服务端值
    - 保存时仅在本次填写时才发送 ak/sk，避免空字符串覆盖
  - 待验证：保存设置后在供应商行显示 AK✓/SK✓，刷新后仍保持标记
  - 待验证：阶段模型选择勾选 jimeng 并保存后，正式运行不再回退占位
  - 如仍回退：放宽 pipeline hasCred，允许仅从 apiKey 同时解析出 AK/SK 即启用

# 下一步（请逐项确认）
- 设置页 -> 图片供应商：勾选 jimeng，填写 AK 与 SK，保存；观察 AK✓/SK✓ 标记
- 设置页 -> 阶段模型选择：image-generation 勾选 jimeng 并保存
- 运行一次流水线，核验图片 URL；如仍为占位，将按上条策略继续修复

# 任务主线（仅新增，不删除）

主线：修复“图片生成阶段回退占位，终稿不展示图片”的问题
  - 目标：在完整流水线中，image-generation 实际调用即梦（Jimeng），产出真实图片 URL，并在终稿追加“图片预览”区块展示。

子任务：
  - 待办：核对前端设置
    - 启用 图片供应商 -> jimeng（enabled=true）
    - 在 阶段模型选择 -> image-generation 勾选 jimeng
  - 待办：凭据配置
    - 在设置页填写 AK 与 SK（或 .env.local 配置 VOLC_ACCESS_KEY_ID/VOLC_SECRET_ACCESS_KEY）并保存
    - 以 AK✓/SK✓ 标志确认保存成功
  - 待办：运行验证
    - 运行一次流水线，检查 runs/*/04c_image-generation.json 是否 provider=jimeng，info 提示“使用 jimeng”
    - 确认 runs/*/08_final-merge.json 的 final.markdown 含“## 图片预览”，且图片链接为 http/https 或 data: URL
  - 待办：如仍回退占位
    - 检查 hasCred 判定条件与 selected() 选择逻辑
    - 核对 image-prompts 是否产出 images 数组
  - 待办：终稿展示排查
    - 若 URL 正常但页面不显示，再排查前端渲染区域的 Markdown 展示逻辑

  - 终稿内联插图与标题修复
    - 目标：图片按对应小节标题在 H2 下方内联展示；未匹配的保留“图片预览”兜底；文首保证有主标题；目录与分级标题明确。
    - 已完成：
      - #+已完成 修改 pipeline.ts，在 final-merge 阶段按 H2 内联图片，剩余图片拼接画廊；无主标题补 `# 终稿`
      - #+已完成 本地端到端运行一次，确认 04c 使用 jimeng 且 08_final-merge 出现内联图片与目录
    - 待办：
      - 前端：定位并修复 ResizeObserver loop completed with undelivered notifications 报错（怀疑 ReactFlow 或日志框尺寸监听），增加防抖和 requestAnimationFrame 包裹
      - 匹配优化：当章节标题在合并后被“要点A：xxx”改写时，用 sectionId->最终标题映射做更稳健的插入

- 仓库发布与版本管理（新增）
  - 目标：将当前项目以干净历史推送到 GitHub，忽略敏感文件，提供清晰的 README。
  - #+已完成 重写 README.md，聚焦项目简介与使用说明，端口统一为 3002。
  - #+已完成 提供 GitHub 上传的详细操作步骤（手动执行）。
  - 待办：在本地完成 Git 初始化、首次提交与推送（参照步骤执行）。
  - 待办：在 GitHub 创建仓库（私有/公开自选），启用 Issues 以跟踪后续问题。
  - 待办：首次推送后创建 release v0.1.0（可选），并在 Releases 中附上变更摘要。