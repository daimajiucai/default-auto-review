# dsh-plugin-default-auto-review

让 **每个真正新建的 DSH 会话**默认进入你指定的权限模式（默认「自动审查」Auto review，UI 中的 `EXP` 预设），并且在 **「插件 → 已安装 → 新会话默认模式」** 里随时改这个选择、看它是否真的生效。

- 默认目标模式：`auto`（自动审查）
  - 沙箱：`danger-full-access`
  - 审批：`ask`
  - 每次工具调用先由当前 agent 的模型审一遍，再决定放行 / 拒绝
- 新建会话后，composer 的权限控件与 `/permission` 都会显示所选模式。

---

## 0. 它在 DSH 界面的哪里

**插件 → 已安装 → 新会话默认模式**：页面标题栏右侧有一个 **「模式：自动审查 ▾」** 按钮，点开就是设置面板——当前模式、可选模式列表（点一下即保存）、是否套用到恢复/子代理会话、本次启动已应用了多少个会话。插件**不占左侧栏**，正文里也没有第二份表单。

| 位置 | 内容 |
| --- | --- |
| 插件页标题栏（`plugins.detail.actions` 插槽） | 「模式」按钮 + 弹出面板：所有设置都在这里，**在 README 之前** |
| 页面正文 | 正文那段长文就是包里的 `README.md`，插件页把它当作「长描述」渲染 |

为什么放标题栏：插件页把 README 渲染在正文最前面，而官方的配置槽 `plugins.bundle.config` **固定排在 README 之后**——放在那儿就得先滚过整篇 README 才能改设置。`plugins.detail.actions` 是唯一排在描述之前的槽位。

表单走宿主声明的插槽、用宿主主题 token，没有独立窗口、没有 iframe、不往页面注入 DOM。

权限模式一律 **中文在上、英文小字在下**，用词与 DSH 自己的权限选择器一致：

| 值 | 中文 | English |
| --- | --- | --- |
| `read-only` | 仅可查看 | Read Only |
| `workspace-write` | 工作区内修改 | Workspace Write |
| `danger-full-access` | 完全权限 | Full access |
| `auto` | 自动审查 | Auto review |

不认识的值（profile 里自定义的预设）退回到它自己的名字，不会渲染成空白行。

---

## 1. 为什么需要插件

`permission.defaultPreset` 只能填 `presets` 表里声明过的名字，而 `auto` 是**保留名**：

| 事实 | 出处 |
| --- | --- |
| `presets` 默认只有 `workspace-write` / `danger-full-access` | `@deepseek-ai/dsh-permission-presets/lib/index.js` `static Config` |
| 配置里写 `auto` 会被拒绝（`'auto' in this.presets` 直接 throw） | 同上 |
| `defaultSettings()` 校验 `defaultPreset` 是否在预设表里，否则抛 `unknown default preset` | 同上 |
| 审查门只在**会话当前预设就是字符串 `auto`** 时才介入，不认「sandbox + approval 组合」 | `@deepseek-ai/dsh-experimental-auto-review` `tools/pre-execute` |
| 设置页的默认权限下拉**有意省略** `auto`（官方限制：自动审查仅限当前会话） | `@deepseek-ai/dsh-client-ui-permission-presets` README.zh.md |

所以自己造一个 `danger-full-access + ask` 的普通预设 **不等于** 自动审查 —— 那只是「完全权限 + 偶尔询问」，没有审查。

## 2. 实现原理

`session/created` 事件：

1. `permission-presets` 在服务初始化时注册了自己的 `session/created` 监听器，把配置里的默认预设钉到新会话上；
2. 本插件在它之后加载，监听器排在后面执行；
3. 于是本插件在这次事件里调用 `permissionPresets.set(session, <目标模式>)`，覆盖刚钉上的值。

目标模式按优先级解析：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 行配置 `config.preset` | 写进 `cordis.patch.yml` 即视为「固定」，表单只读并给出提示 |
| 2 | `~/.dsh/dsh-default-preset.json` | 表单写入的设置文件（`DSH_DEFAULT_PRESET_FILE` 可改路径） |
| 3 | 内置默认 `auto` | 两者都没有时 |

只有 `permissionPresets.catalog()` / `optionOf()` 认得的模式才会被套用（用 `optionOf` 探测，抛错即跳过），因此 Auto review 集成没启用时本插件什么都不做，也不会抛错阻断建会话；任何异常都只记 `warn`。

跳过两类会话，避免误伤（都可在表单里关掉）：

| 场景 | 判据 | 默认行为 |
| --- | --- | --- |
| 恢复 / 种子会话 | `session.header.isSeeded === true` | 保持原预设 |
| 子代理会话 | `session.header.parentSession !== undefined` | 保持原预设 |

## 3. 安装

```powershell
& "D:\Software\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add C:\Myproj\dsh-plugins\plugins\default-auto-review
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，CLI 会自动把这条 `insert` 提升进 profile 的组合层，**不需要**再手改 `cordis.patch.yml`。

装完必须**重启 DSH 桌面端**才会加载新插件（重启会结束当前会话）；重启后在「插件 → 已安装」里点开 **新会话默认模式**，标题栏右侧就是「模式」按钮。

> 只改 `client.js` 不需要重启：插件以 `link:` 安装时宿主直接从源码目录读浏览器半，刷新页面（或等 HMR）即可。但改 `package.json` 的 `dsh.client.inject` 属于 manifest 改动，宿主只在启动时读一次，**必须重启**。

## 4. 验证

1. 插件 → 已安装 → 新会话默认模式：标题栏右侧出现 **「模式：自动审查 ▾」**，点开面板应显示当前模式（中文在上、英文小字在下）、可选模式列表和「本次启动已应用到 N 个新会话」；
2. 面板可以点 ✕、按 Esc 或点面板外面关掉；
3. 左侧栏**不应**出现「新会话模式」之类的独立入口，正文里也**不应**再出现一份配置表单；
4. 新建一个会话：composer 权限控件显示所选模式，`/permission` 报告同一个名字；
5. 会话 runtime context 显示对应的 `DSH file policy` / `Approval policy`（`auto` 时是 `danger-full-access` + `ask`）；
6. 在面板里换一个模式，再新建会话，确认新会话用的是新模式；
7. 没生效时搜日志中的 `default-auto-review:` 前缀，或看面板上的错误提示。

自动化回归：`node test/run-all.mjs`（Host 半 24 项 + 浏览器半 13 项，含插槽归属、面板开合、中英对照顺序与保存请求）。

回归检查：恢复旧会话 → 权限保持原样；起 subagent → 子会话不变成目标模式（除非在面板里打开对应开关）。

## 5. 卸载

```powershell
& "D:\Software\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-plugin-default-auto-review
```

重启后生效。注意：卸载 Auto review 本身或本插件时，**当前处于 auto 的会话会被迁到 `danger-full-access`**（auto-review 自身的清理逻辑），属预期行为。

## 6. 配置项

### 6.1 表单写的设置文件

`~/.dsh/dsh-default-preset.json`：

```json
{
  "preset": "auto",
  "skipSeeded": true,
  "skipSubagents": true
}
```

- `preset`：新建会话的目标模式，必须是当前可选模式之一（表单里的列表就来自 `permissionPresets.catalog()`）；
- `skipSeeded`：`true` 表示恢复/种子会话不动它；表单里关掉后恢复会话也会被切换；
- `skipSubagents`：`true` 表示子代理会话不动它。

### 6.2 用行配置固定（优先级最高）

```yaml
- id: default-auto-review
  name: dsh-plugin-default-auto-review
  config:
    preset: auto              # 固定目标模式；表单此时只读
    skipSeeded: true          # 默认 true：种子/恢复会话不处理
    skipSubagents: true       # 默认 true：子代理会话不处理
```

固定任何一项后，表单对那一项的修改会返回 409 并提示去 `cordis.patch.yml` 改。

## 7. 成本与风险

- **审查成本**：选择 `auto` 时每次工具调用多一次模型请求，token 与延迟都上升（KV cache 前缀固定，不会额外失效）。
- **`deny` 的实际效果**：`ask` 策略下会转成向用户提问（可放行）；只有 `never` 策略才是硬拒绝。
- **设置页仍显示旧默认值**：「设置 → 通用 → 默认权限」读的是 `permission.defaultPreset`，改它对本插件无效 —— 本插件在每次建会话时覆盖。
- **依赖内部 API 形状**：用到 `permissionPresets.catalog/optionOf/current/set` 与 `session.header.isSeeded/parentSession`。这些目前是公开字段/方法，但 DSH 升级后可能变化；失败时只打 warn，不会阻断建会话。
- **顺序依赖**：若将来有插件在 permission-presets 之后注册 `session/created` 并再次改写权限，可能与本插件竞争。
- **表单读取的是同源路由**：`GET /dsh-default-preset/state`、`POST /dsh-default-preset/preset`，用的是当前页面的 DSH 会话；没有 `webServer` 的纯 Host 组合下这两个路由不存在，会话切换逻辑照常工作。
