#!/usr/bin/env bash
set -e
git add -A
git commit -m "chore(release): 0.19.0——设置卡思考档位目录真源化+新模型免人工（Qoder 卡档位目录声明驱动含存量兼容、key 型服务商声明透传修 refresh 丢档实锤、Trae 探针负结论落文档、Ark 探针省额度默认、C4 缺口检测脚本；十套件全绿）"
git tag -a v0.19.0 -m "0.19.0：设置卡思考档位目录真源化 + 新模型免人工——B(Qoder 卡档位目录声明驱动、存量 max 以未声明形态可见)+C1(Trae 方言探针全臂 3003 负结论落文档)+C2(key 型服务商声明透传修 refresh 丢档)+C3(Ark 探针省额度默认+repeat 聚合+yaml null 雷)+C4(缺口检测脚本)；十套件全绿；新坑 #65(Mimosa git 门误拦回环网关)"
git push origin main --follow-tags
