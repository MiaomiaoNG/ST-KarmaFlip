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
- Leave the backup-1 directory unchanged unless the author explicitly requests a specific archive or recovery operation there.
- Update SPEC.md after completing implementation changes.
- After completing a major update, update the plugin announcement in `const UPDATE_NOTICE_TEXT = \`更新内容如下：……\``. After all work is complete, tell the author exactly what announcement content was added.
- Unless the author explicitly confirms that an update is a major version update, change only the final version component; for example, for `1.2.xx`, update only the `xx` component.

## 4. Reference Repositories
在查找问题产生原因时，有需要可进入以下链接进行检索查找。

- 原生酒馆 SillyTavern 文件链接：`https://github.com/SillyTavern/SillyTavern`
- 鸿蒙端使用的类酒馆 TavernNext（TN）链接：`https://github.com/cestbon0309/TavernNext-ARK`
- 类酒馆 TauriTavern（TT）链接：`https://github.com/Darkatse/TauriTavern`

检索宿主实现时，应优先核对与当前问题直接相关的事件、请求路径、请求体、响应流和生命周期代码。外部仓库可能随时间变化；写入本项目文档的结论必须注明是源码确认、实机确认还是待验证推断。

## 5. SPEC.md Usage

`SPEC.md` is the current implementation specification and the first document to read when learning the plugin.

- Keep only behavior that exists in the current source: features, data boundaries, runtime flow, compatibility constraints, file responsibilities, and validation requirements.
- Verify a statement against the current source before adding or retaining it. Do not copy an old design forward solely because it appeared in a historical document.
- Do not use SPEC.md as a chronological changelog, conversation transcript, wish list, or bug diary.
- When implementation changes, update the affected section in place. Remove or rewrite superseded text instead of appending another dated paragraph.
- Mark device or host behavior as pending validation when source inspection alone cannot confirm it.
- Keep detailed confirmed failed approaches in `KNOWN_FAILURES.md` and link to that file instead of expanding failure history in SPEC.md.
- Before a large rewrite, archive the previous specification only when the author has authorized it. Archived files are immutable historical evidence.

## 6. KNOWN_FAILURES.md Usage

`KNOWN_FAILURES.md` is a local development guardrail for approaches that have been conclusively shown not to work. It is intentionally listed in `.gitignore` and is not part of the GitHub release.

- Organize records by feature, such as request recognition, streaming, host startup, UI styling, or drag sorting.
- Every record must include: the problem to solve, the attempted method, the observed failure, the confirmation evidence, the current replacement, and any condition required before reconsidering it.
- Add a record only after failure is confirmed by a rollback, reproducible test, author feedback tied to a fix, or a later implementation that explicitly replaces the failed method.
- Do not record speculation, open questions, ordinary bugs, or untested alternatives as confirmed failures.
- Read the relevant category before changing a sensitive path. If retrying an old approach, first explain what environment or constraint has changed and add a focused validation plan.
- When a failure becomes obsolete because the underlying host or architecture changed, update the record with evidence; do not silently delete it.
