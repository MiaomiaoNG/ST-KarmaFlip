# ST-KarmaFlip

ST-KarmaFlip 是 SillyTavern 的第三方扩展，显示名为“API随机临幸”。它可以在正文生成前按固定顺序或随机规则选择 API/模型，并在请求失败时自动重试或切换。

## 安装

### 通过 SillyTavern 安装

1. 打开 SillyTavern 的扩展管理页面。
2. 选择“安装扩展”或“从 Git URL 安装”。
3. 输入：`https://github.com/MiaomiaoNG/ST-KarmaFlip`
4. 安装完成后刷新 SillyTavern。
5. 从聊天输入区的扩展菜单（魔法棒）打开“API随机临幸”。

### 手动安装

将仓库放到当前用户的扩展目录，使目录结构为：

```text
SillyTavern/data/default-user/extensions/ST-KarmaFlip/
```

然后刷新页面。更新时保留同一目录并替换插件文件。

## 快速使用

1. 打开插件，创建或选择一个组合。
2. 添加 API 条目，填写名称、URL、接口类型和模型；Key 可按接口要求填写或留空。
3. 选择“固定模式”或“随机模式”。
4. 固定模式可设置每个条目的运行次数；随机模式可设置权重、保底和冷却。
5. 开启“插件已开启”，之后正常发送消息即可。

## 主要功能

- 支持 OpenAI 兼容、Gemini 官方和 Claude 官方接口。
- 固定轮询或按权重随机抽选，可避免连续、设置保底和冷却。
- API 失败自动重试，并可切换到下一个可用条目。
- 为不同 API 绑定 SillyTavern Chat Completion 预设、提示词开关和正则开关。
- 拉取模型列表，并在模型弹窗中用关键词搜索。
- 指定下一次 API、绑定楼层或按聊天锁定 API。
- API 条目长按 450ms 后拖动排序。
- Quick Reply 与可选悬浮按钮快捷切换模式、插件状态或指定 API。
- 配置导入导出、主题美化、顺序检测、请求日志和次数统计。
- 针对原生 SillyTavern、TauriTavern（TT）和 TavernNext（TN）提供兼容处理。

## 日志说明

- 主题色：抽选记录。
- 绿色：请求成功。
- 红色：API、HTTP、业务响应或网络错误。
- 紫色：插件内部处理错误。

红色报错详情右上角可以复制全部内容，便于排查。日志仅保留在当前页面会话中，刷新后清空。

## 数据与密钥

插件设置保存在 SillyTavern 的 `extension_settings.STApiSwitcher`。API Key 会随插件配置保存。主动导出 API 或完整配置时，导出文件可能包含 Key，请妥善保管，不要公开上传。

## 兼容问题排查

遇到问题时请记录：宿主名称及版本、插件版本、触发方式、日志中的完整红色或紫色错误，以及能否在原生 SillyTavern 中复现。正常模型正文不应被当作 API 错误；若 TT 把上游失败包装成 HTTP 200 SSE，插件会尝试识别该错误事件。

开发与实现说明见 `SPEC.md`，开发规则见 `DEVELOPMENT_GUIDE.md`。
