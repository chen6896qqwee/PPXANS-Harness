# 安全策略

PPXANS-Harness 是一个**会执行命令、读写文件、访问网络**的自主 Agent。  
我们认真对待它的每一层安全边界。

## 支持的版本

| 版本    | 安全支持    |
| ----- | ------- |
| 3.x   | ✅ 支持    |
| < 3.0 | ❌ 已停止维护 |

## 报告漏洞

**请不要在公开 Issue 里披露安全漏洞。**

- 邮件: 见仓库主页作者联系方式 (或通过 GitHub Security Advisory 私密上报)
- 请附带: 影响版本 / 复现步骤 / 影响面评估
- 承诺: 72 小时内确认，修复后视情况署名致谢

## 安全模型 (你需要知道的)

### 内置防线

- **命令守卫三层防线** + 反混淆: 危险命令默认拦截，审批后放行 (`AskForApproval` 四档)
- **SSRF 防护**: 内网地址/重定向逐跳校验 (`http_request` / `fetch_page`)
- **路径防护**: `safePath` realpath 校验 + symlink 越界拦截
- **提示注入扫描**: 工具结果入库前扫描 (`security/injection.js`)
- **审计哈希链**: 全部工具调用 append-only + SHA-256 链式防篡改，事后可追责
- **HTTP 认证**: Bearer Token，本机 token 注入有 Origin 同端口校验

### 已知边界 (诚实声明)

- **JS 沙箱 (`code_run`) 防失误不防恶意**: worker_threads + node:vm 隔离了 IO/网络/进程，  
  但 Node 原生不提供强隔离。**不要**用它跑不受信第三方的恶意代码——  
  那种需求请用容器级隔离（Docker / Firecracker）。
- **权限引擎的边界**: 沙箱策略 + 审批档位能拦常见误操作，但一个拥有 shell 权限的 Agent  
  本质上等价于把电脑交给它。**在隔离环境（容器/虚拟机/专用账户）里跑高自主任务**  
  是我们对生产部署的强烈建议。
- **token 即权限**: HTTP Bearer token 拥有全部 API 权限，泄露 = 全权失控。  
  绑定 127.0.0.1 只对单机场景安全。

## 安全相关配置速查

```json
{
  "security": {
    "allow_all": false,
    "command_timeout_ms": 30000,
    "deny": ["rm", "del", "format"]
  },
  "channels": { "http": { "host": "127.0.0.1" } }
}
```

- `allow_all: true` = 关掉审批闸门，**只建议在一次性容器里用**
- `channels.http.host` 绑 `0.0.0.0` 前请确保有网络层隔离
