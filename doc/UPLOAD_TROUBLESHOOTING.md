# 上传证书时连接超时

如果同一证书可以在提供方控制台上传，但经本应用请求超时或出现连接重置，应比较应用容器到上游的网络路径。小请求成功、大请求失败可能与路径 MTU、隧道或 Docker 网络有关；先核对请求大小、原始错误和出口路由，不把所有上传错误都当作证书格式问题。

确认是路径 MTU 问题后，可选择使用附带的网络覆盖配置：

```sh
docker compose -f compose.yaml -f compose.upload-mtu.yaml config --quiet
docker compose -f compose.yaml -f compose.upload-mtu.yaml up -d --no-deps app
```

该配置需要支持 `gw_priority` 的 Docker Compose。它增加 MTU 为 1280 的应用出口网络，并保留连接 PostgreSQL、Redis 的原有网络。它不修改宿主机全局网络，也不是默认部署选项。每次使用相同的两个 Compose 文件管理服务，避免重建时丢失配置。

在容器中检查实际默认路由及其对应接口 MTU；重建后接口名称可能改变，不能假定出口始终为某一个 `ethN`。验收应包含代表性的证书上传、普通接口及数据库和缓存连通性。不同提供方的网络条件不同，应根据实测选取 MTU。

回滚时仅用原 `compose.yaml` 重建应用服务，并复核原有默认路由。保留 PostgreSQL、Redis 数据卷和服务；清理额外网络前先确认没有其他容器连接。
