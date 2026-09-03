# Agent 运行进程模块

该目录在 utility process 中执行模型调用和工具任务，与 `src/main/runtime/` 的桌面控制层分开。

| 位置 | 职责 |
| --- | --- |
| `entry.ts` | 进程入口与消息接收，保留稳定构建入口 |
| `host.ts` | 运行生命周期与各能力的组装/调度 |
| `contracts/` | 主进程通信协议、校验与协议错误 |
| `execution/` | 上下文管理、最终响应提交、协作、Goal、会话标题 |
| `instructions/` | 系统指令、工作区指令与 composer 意图 |
| `models/` | 提供方适配、请求归一化、流式重组、重试与模型文本生成 |
| `media/` | 媒体路由与分析、临时资源发布 |
| `media/audio/` | 音频转写 |
| `media/video/` | 视频提取、原生传输、分析与结果融合 |
| `capabilities/` | 知识库、MCP、Skills 能力接入 |
| `persistence/` | Native binding 与模型历史编解码 |
| `tools/` | 工具执行、返回值处理和进度摘要 |

移动模块时同步更新源码、测试及脚本引用，不增加旧路径转发层。
新增功能按职责放入子目录，`host.ts` 的流程拆分应单独配合生命周期测试进行。
当前目录整理不改变协议、模型输出解析或网关兼容策略。
