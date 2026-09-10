# 同题 · Model Gallery

收录同一提示词在不同模型中生成的 HTML 作品，按模型系列筛选、评分并实时对比。前端是无依赖的 HTML/CSS/JavaScript，后端使用 Python 标准库，可以分别部署。

## 功能

- 提示词分组，模型系列、思考档位、模型途径、Agent 工具、完成用时和日期。
- 登录后上传或替换单个 HTML 文件，编辑信息、移除记录、拖动排序和导出资料。
- 游客只读展示；后端会验证所有管理请求，公开列表不包含本地导入路径。
- 缩略图、大图和分屏按队列逐个加载；视口附近优先，离屏自动暂停，超时可重试。
- 明暗主题、列数、筛选和页面位置记忆；更新单个作品不会重建其他预览。
- 同组最多三件作品分屏比较；支持接入 Three.js OrbitControls 的作品联动视角。

## 本地运行

需要 Python 3.10+，无第三方 Python 依赖。Node.js 18+ 只用于 Pages 构建和 JavaScript 测试。

```bash
python backend/set_password.py
python server.py
```

在浏览器打开 http://127.0.0.1:8765 。前端使用 8765 端口，后端使用 8766。Windows 也可双击「启动作品库.cmd」。Ctrl+C 会同时停止两个服务。

`set_password.py` 会交互式设置管理员密码，输入不会回显。没有预设公开密码；未配置密码时只能展示，登录不可用。密码以加盐 scrypt 哈希保存在未跟踪的 `data/auth.json` 中。

独立运行两端：

```bash
python backend/server.py --port 8766 --frontend-origin http://127.0.0.1:8765
python frontend/serve.py --port 8765 --api-url http://127.0.0.1:8766
```

一键启动时自定义端口：`python server.py --port 8775 --backend-port 8776`。本地 config.js 使用环回 API 地址；静态服务器的 `--api-url` 仅覆盖当前响应，不改写文件。

## Cloudflare Pages 连接 GitHub

在 Pages 中导入本仓库，使用以下设置：

| 设置 | 值 |
| --- | --- |
| 生产分支 | `main` |
| 框架预设 | None |
| 构建命令 | `node scripts/build-pages.mjs` |
| 构建输出目录 | `dist` |
| 根目录 | 仓库根目录 |
| 环境变量 | `GALLERY_API_BASE_URL` = 你的 HTTPS API 地址 |

例如 API 为 `https://api.example.com/model-gallery`，环境变量也要包含 `/model-gallery` 前缀。不要在变量里填登录密码或令牌：API 地址是公开配置，会生成到前端 config.js。

构建只复制五个必要静态文件，不会打包后端、资料库或上传作品。后续向 main 推送即可由 Pages 自动构建；生产和 Preview 环境都需设置该环境变量。新前端域名还需加入后端的跨域白名单，否则管理请求会被拒绝。

## 后端部署

后端需要持续运行的 Python 主机；CF Pages 仅托管前端。保留以下目录结构：

```text
frontend/                页面、交互、主题和本地静态服务器
backend/                 API、鉴权和 HTML 预览处理
backend/runtime/         动画暂停和相机联动脚本
scripts/build-pages.mjs  Pages 静态构建
tests/                  回归检查
data/                   密码配置和作品资料库（本地生成、不提交）
projects/               上传的作品副本（本地生成、不提交）
deploy/                 通用 systemd 与环境配置示例
server.py                本地双进程启动器
```

在服务器先设置管理员密码，再启动 API：

```bash
python3 backend/set_password.py
python3 backend/server.py --host 127.0.0.1 --port 8766 --frontend-origin https://gallery.example.com
```

通过 Nginx、Caddy 或 Tunnel 提供 HTTPS。API 域名应转发 `/api/`、`/projects/`、`/preview-runtime/`，保留它们的相对路径。若外部入口带 `/model-gallery`，增加 `--public-prefix /model-gallery` 或 `GALLERY_PUBLIC_PREFIX=/model-gallery`，并让反向代理向后端转发 API 时剥离该前缀。

`--frontend-origin` 可重复指定，精确包含前端协议、域名和端口，不带末尾斜杠。默认只允许本地开发来源。容器需要对外监听时可使用 `--host 0.0.0.0`；同机反代使用环回地址即可。

通用 systemd 示例位于 `deploy/model-gallery.service`，使用前需创建专用运行账号并授予data/projects 写权限，将 `deploy/backend.env.example` 的占位域名换成真实前端来源。密码文件需要由运行账号读取，不能放入任何公开静态目录。

## 上传和数据

网页只需要选择 `.html` 或 `.htm` 文件，最大 20 MB、UTF-8 编码。图片、样式和脚本应内嵌，或引用公开 HTTPS 资源。编辑时不选文件只更新信息，替换文件会生成新副本，旧副本保留。

上传是浏览器直传后端，不经过 Pages。反向代理请求体上限至少设置为 21 MB，例如 Nginx `client_max_body_size 21m`。

`data/library.json` 保存资料，`projects/` 保存文件。导出只包含 JSON 资料；完整备份要包含这两个目录。源码仓库不包含真实作品、用户资料、密码哈希或服务器部署记录。不要强制添加被 .gitignore 排除的运行数据。

## 登录和访问控制

会话有效期为 12 小时，退出立即撤销；改密或重启后端会使旧会话失效。前端将临时令牌保存在按 API 地址隔离的 sessionStorage 中，不依赖跨站 Cookie。HTTPS 部署下需保持 Authorization 请求头和 OPTIONS 预检可达。

公开作品和提示词可以被游客读取；管理接口、导出和原始导入路径要求登录。作品 iframe 不携带管理员令牌。登录失败有限流，限流按后端看到的来源地址计算，不信任任意 X-Forwarded-For。

当前会话为单进程内存状态，适合单实例部署；多个后端实例需另外共享会话。API 和鉴权响应不缓存，不要用 CDN 的全站缓存规则覆盖它们。

## 主要接口

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/health` | 公开 |
| GET | `/api/library` | 游客得到公开字段，管理员得到完整记录 |
| POST | `/api/auth/login` | JSON password，返回 token/expiresAt |
| GET | `/api/auth/session` | Bearer 会话 |
| POST | `/api/auth/logout` | Bearer 会话，JSON 空对象 |
| POST / PATCH | `/api/groups` / `/api/groups/{id}` | 管理员 |
| POST / PATCH | `/api/projects` / `/api/projects/{id}` | 管理员 |
| DELETE | `/api/projects/{id}` | 管理员，仅移除记录 |
| POST | `/api/projects/reorder` | 管理员，JSON ids 数组 |
| GET | `/api/export` | 管理员 |
| GET | `/projects/{id}/...` | 公开作品 |

上传请求用 multipart/form-data，字段 metadata 为 JSON 文本、file 为 HTML 文件；不要手动指定浏览器 multipart 的 Content-Type。仅修改信息可发 JSON。错误响应为 `{ "error": "说明" }`。旧的 JSON 路径导入接口为本地脚本保留。

## 预览与性能边界

同一时刻只启动一个预览，完成后等待约 0.8 秒；45 秒未完成会显示重试。缩略图只加载视口附近，打开大图后优先处理查看器。离屏、后台或编辑时暂停可控制的动画，已加载 iframe 保留状态。HTML 采用 ETag/304 校验减少重复传输。

受支持动画包括 requestAnimationFrame、CSS/Web Animations、SVG SMIL。外部网站可能限制嵌入，Worker 或自行使用定时器绘制的作品不能保证完全暂停。页面加载确认不代表作品自身逻辑或 WebGL 性能正常。

视角联动需要作品暴露 `window.__galleryCamera = { camera, controls }`，支持 Three.js 透视相机、Y 轴向上与 OrbitControls；可选 cancelMotion() 取消自定义动画。内置保留了原有示例的兼容适配，但示例作品不随源码发布。

## 验证

```bash
python -m unittest discover -s tests -v
nodetests/test_frontend.cjs
node --testtests/test_auth_frontend.cjs
nodetests/test_preview_queue.cjs
nodetests/test_upload_frontend.cjs
nodetests/test_theme.cjs
```

Python 检查使用临时资料库，不修改运行数据。前端检查使用 Node 模拟环境；不替代真实浏览器或公网部署验证。
