# Promotional assets and 1.1.0 announcement

The images in this social folder are historical theme examples. Use the freshly generated [1.1.0 README gallery](../../../README.md) for current UI screenshots.

These images are generated from an isolated synthetic catalog and seeded practice data. The cover and theme matrix are illustrative HTML artwork; the remaining images capture the shared browser UI. They are not native-installer or WebView2 acceptance evidence. Filenames retain their original theme names for link stability.

Regenerate with `npm run build` followed by `npm run assets:social-zh`; local Chrome is required. The script uses a new temporary profile, explicitly disables provider keys, and does not read the private JSONL backup. See the [script guide](../../../scripts/README.md).

## Suggested Chinese announcement copy

> LeetCode Tracker 1.1.0：一个本地优先的 Windows 刷题工作台。
>
> 下载一个安装包即可开始，不需要另装 Node.js。自行导入 JSONL 题目元数据，设置每周练习计划，记录进度、复盘 Markdown 笔记，并导出到 Obsidian 或 Notion。
>
> 支持中英文界面、10 套主题和键盘操作。AI 是可选项，可配置 Gemini、OpenAI 或 DeepSeek；本地规则负责筛选与保存。启用 AI 时，相关任务输入会发送到所选服务商。
>
> 1.1.0 安装包尚未签名，完整干净系统安装升级和原生界面验收仍待完成。图片使用演示数据。详细限制请阅读 Release 说明。

Release: [v1.1.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.1.0).

Do not describe these assets as proof of live AI availability, universal sub-millisecond latency, rendered LaTeX previews, legal compliance, or zero data leakage. Notes offer a lightweight Markdown preview, without a full LaTeX typesetter; raw SQLite backups may contain provider keys. Current behavior and limitations are documented in the [release notes](../../releases/1.1.0.md).
