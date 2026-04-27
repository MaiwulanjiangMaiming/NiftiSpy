# 性能分析报告模板

## 数据集
- 文件名:
- 尺寸:
- voxel size:
- dtype:
- 本地/远程:

## 基线
- preview first visible:
- interactive slice ready:
- full-volume ready:
- 第 1/5/10/20 张耗时:
- 峰值内存:

## 优化后
- preview first visible:
- interactive slice ready:
- full-volume ready:
- 第 1/5/10/20 张耗时:
- 峰值内存:

## 监控数据
- `window.__niftiPerf`:
- 扩展宿主 RSS/heap:
- cache hit ratio:
- 408/429/5xx 恢复情况:

## 结论
- 单图是否 <= 5s:
- 多图衰减是否 <= 50%:
- 内存峰值是否降低 >= 30%:

