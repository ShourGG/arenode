# 套餐建站策略

管理员在套餐编辑框中选择业务类型，或通过套餐 API 设置 `siteProfile`。支持 `web`、`openai`、`anthropic`、`gemini`、`azure_openai`、`cohere`、`china_ai`、`mixed_ai`。现有套餐默认 `web`。

AI 策略在两个新建网站入口中统一应用：原生 `/api/sites` 与兼容 `/api/cdnfly/v1/sites`。策略由客户所属订阅确定，客户不能通过请求字段指定另一个套餐的策略。

- 对选中协议的已知 API 路径添加前置 CC 规则，并保留原有自定义规则。
- 不为 `/`、`/home`、`/login` 等页面添加放行规则。
- 新站点禁用代理缓存、将超时至少设为 600 秒、使用 HTTP/1.1 并启用 WebSocket。

`mixed_ai` 合并各协议规则，包含 Chat Completions、Responses、Messages、Gemini 原生及上传路径等。具体路径以 `src/site-profiles.js` 为准；服务商新增接口时仍需更新规则。策略不代表关闭所有 WAF 检查，也不改变上游套餐带宽和流量限制。

升级自动添加 `plans.site_profile`，不回写已存在网站。修改套餐策略只影响之后新建的网站。回滚代码时可以保留这个字段；若要撤销已建站点的配置，需要单独编辑对应网站。
