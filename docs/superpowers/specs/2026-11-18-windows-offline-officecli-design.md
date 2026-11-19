# Windows 离线 OfficeCLI 安装设计

## 背景

AionCore 当前在首次启动 Office 文件预览时检查 OfficeCLI；缺失时运行官方联网安装脚本。AionUi 的 Windows x64/ARM64 GitHub Actions 构建没有打包 OfficeCLI，因此离线环境的首次预览可能安装失败。

## 目标与边界

- 支持 AionUi Windows x64 和 ARM64 桌面安装包。
- 安装包包含与目标架构匹配、固定版本且经过 SHA256 校验的 OfficeCLI。
- OfficeCLI 随 AionUi 安装到应用私有资源目录；不修改机器级或用户级 PATH，不覆盖系统上已有的 OfficeCLI。
- AionCore 子进程优先使用 AionUi 随包版本，使 Office 预览不依赖客户端联网。
- 通过 GitHub Actions 的正式构建和手动构建产出一致的离线安装包。
- 不在仓库提交 OfficeCLI 二进制文件；非 Windows 构建行为不变。

## 方案与数据流

1. 在仓库配置中固定 OfficeCLI release 版本。
2. `_build-reusable.yml` 的 Windows 构建 job 按矩阵架构下载对应官方资产，并依据同一 release 的 `SHA256SUMS` 校验。
3. 校验通过后，将单一架构的 `officecli.exe` 暂存到 Windows 安装资源目录。校验失败或下载失败时，构建立即失败，不能生成缺少 OfficeCLI 的离线安装包。
4. `electron-builder.yml` 将暂存的 OfficeCLI 作为 `extraResources` 纳入应用安装目录。x64 包只含 x64 二进制，ARM64 包只含 ARM64 二进制。
5. NSIS `customInstall` 在安装完成阶段验证随包二进制存在且可运行；验证失败时明确报告安装失败。
6. 启动 AionCore 时，AionUi 仅为该后端子进程把安装目录中的 OfficeCLI 资源路径前置到其 `PATH`。AionCore 现有的 OfficeCLI 解析逻辑据此找到随包版本；不改写用户或系统 PATH。

## 版本与已有安装策略

- OfficeCLI 版本固定在仓库配置中，构建下载使用不可变版本 URL，并校验 SHA256。
- AionUi 始终使用自己的随包版本，不复用、修改或卸载机器上其他位置的 OfficeCLI。这样版本行为可复现，也避免后端的更新逻辑影响外部安装。
- AionCore 当前在成功启动 PPT 预览后会尝试检查 OfficeCLI 最新版本。若内网阻断外部访问，该检查失败只记录警告，不应影响已经启动的预览；其更新目标通过 AionUi 子进程私有 PATH 解析，因此不会写入系统级安装。

## 错误处理

- 下载、校验或架构选择失败：Windows 构建 job 失败，不上传不完整安装包。
- NSIS 找不到或无法运行随包 OfficeCLI：安装时明确失败并提示检查安装包，而不是等到首次预览时才失败。
- 运行时若随包 OfficeCLI 被删除或损坏：保留 AionCore 现有错误状态和日志。AionCore 当前缺失时仍会尝试官方在线安装；在离线环境该异常路径会明确失败，因此安装阶段必须验证二进制和 `watch` 能力。
- 非 Windows runner 不下载 OfficeCLI，也不改变现有安装资源。

## 验证

- 单元测试覆盖 OfficeCLI 版本/资产名解析、SHA256 校验失败、架构选择及缺失资源错误。
- 后端启动环境测试验证：Windows packaged 模式下仅子进程 PATH 前置私有目录；资源缺失和非 Windows 模式不污染 PATH。
- 在 GitHub Actions 手动构建 Windows x64 与 ARM64，验证各自安装包仅包含匹配架构的 OfficeCLI，并可执行 `--version` 与 `watch` 能力检查。
- 使用隔离网络环境安装构建产物并启动 Office 预览，确认全程不需要下载 OfficeCLI。
