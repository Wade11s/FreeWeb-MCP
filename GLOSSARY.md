# FreeWeb-MCP

FreeWeb-MCP 为 AI 客户端提供统一的 Web 搜索、读取与浏览能力，同时保证不会自动转入付费使用。

## Language

**Free**:
一种使用约束：允许无费用的本地能力和明确配置的免费额度，但额度耗尽后必须停止或降级，不能自动产生费用。TinyFish 只使用 Search 和 Fetch，且其 API Key 必须属于确认无钱包支出能力的账户；仅有免费额度或关闭自动充值不满足这个条件。
_Avoid_: Unlimited、No-account、Offline

**Initialization**:
为 FreeWeb-MCP 准备本地 Provider 和初始配置的显式、可重复运行过程；它区分安装、配置与验证，过程成功不代表所有可选能力均已就绪，账户授权和 ego onboarding 可能仍需用户完成。
_Avoid_: Install-all、One-click Setup

**Initialization Step**:
Initialization 中一次只引导一个环境检查、Provider、配置或验证决策的阶段；单个阶段的结果不替代整个 Initialization 的结果。
_Avoid_: Plan Confirmation、Unattended Initialization

**Search**:
根据查询发现相关 Web 结果，返回候选资源的位置与摘要，而不是读取整个站点。
_Avoid_: Fetch、Crawl

**Fetch**:
读取一个或多个已知 URL 的内容。
_Avoid_: Scrape、Browse、Crawl

**Crawl**:
从起始 URL 出发，在授权范围内遍历并读取多个页面的内容。
_Avoid_: Map、Fetch

**Crawl Job**:
一次异步 Crawl 及其状态、部分结果和错误；运行状态包括 scraping、completed、failed、cancelled 和 lost。lost 表示执行过程已中断但可能留有 checkpoint，不表示可以从断点继续运行。
_Avoid_: Persistent Task、Resumable Job

**Artifact**:
工具输出或 Crawl checkpoint 在用户私有本地数据目录中的一份有保留期限的记录，可以通过 Artifact ID 或 MCP resource URI 读取。
_Avoid_: Cache、Permanent Export

**Map**:
发现站点内符合范围的 URL，而不读取这些页面的完整内容。
_Avoid_: Crawl、Search

**Browse**:
在浏览器任务空间中访问动态渲染的页面，并在获得授权时使用用户身份读取或操作页面。
_Avoid_: Fetch、Scrape

**Fallback**:
同一操作在首选能力不可用、超时、限流、额度耗尽或不支持内容时，最多改用一个备选能力的过程；有效空结果与目标网站的正常错误响应不触发切换，且调用方可以关闭。备选 Provider 是否已配置（例如 keyless Firecrawl Search 的独立开关）是配置状态：未配置只表示该 Provider 不存在，不等于调用方关闭了 Fallback。
_Avoid_: Retry、Provider loop

**Page Evaluation**:
在指定网页中执行的任意 JavaScript；它可以使用该网站中的用户身份并改变外部状态，但不能直接使用 Node.js 的本机能力。
_Avoid_: Read-only script、Node execution

**Managed Browse**:
由 FreeWeb-MCP 管理 Task Space 创建、恢复、保留和关闭的浏览任务；其包装器可以强制执行公网、文件、身份和生命周期约束。
_Avoid_: Raw Browse、Persistent Space

**Unrestricted Browse**:
由可信调用方执行原生 ego-lite Node.js 脚本并自行管理副作用与 Task Space 生命周期的浏览方式；它不受 Managed Browse 包装器安全边界约束。
_Avoid_: Sandboxed Browse、Managed Browse

**Task Space**:
为一个浏览任务创建、在任务结束时关闭的临时浏览器工作区；它可以使用已授权的用户身份，但本身不是独立的数据或身份隔离边界。
_Avoid_: Persistent Space、Temporary Profile
