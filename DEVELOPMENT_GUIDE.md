# AI_WORKFLOW: Development Guidelines

## 1. Encoding Guidelines
This project uses UTF-8 encoded files.
When using PowerShell file commands, specify UTF-8 encoding to preserve Chinese text correctly.

## 2. Communication Tags
The author may use these tags to describe the purpose of a request:
- 【问题】: Discussion or questions. No file changes are expected.
- 【修改】: Code changes or file updates are requested.
- 【解释】: Information sharing. No action is needed unless requested.

## 3. Development Guidelines
- Consult the SillyTavern repository when implementation details depend on its internal behavior.
- Communicate with the author in Chinese.
- Store plugin settings using SillyTavern extension_settings.
- Keep modifications within the ST-KarmaFlip directory.
- Leave the backup-1 directory unchanged.
- Update SPEC.md after completing implementation changes.
- After completing a major update, update the plugin announcement in `const UPDATE_NOTICE_TEXT = \`更新内容如下：……\``. After all work is complete, tell the author exactly what announcement content was added.
- Unless the author explicitly confirms that an update is a major version update, change only the final version component; for example, for `1.2.xx`, update only the `xx` component.
