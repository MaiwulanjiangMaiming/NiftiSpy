# NiftiSpy 未执行 AI 建议汇总 Plan

> 基于 7 个 AI 助手（ChatGPT、Claude、DeepSeek、Gemini、Grok、Kimi、Mimo）的意见审查
> 当前版本：v1.1.0
> 生成时间：2026-05-28

---

## 一、已执行项（阶段1-2 完成）

| # | 建议 | 来源 | 状态 |
|---|------|------|------|
| 1 | Worker 内存双份持有修复（就地转换） | Claude BUG#3 | v1.3.3 ✅ |
| 2 | Minimap 坐标翻转修复 | 用户反馈 | v1.3.3 ✅ |
| 3 | 非 axial 切片 Range 读取 | Claude 阶段2 | v1.4.0 ✅ |
| 4 | 远程文件 HTTP Range 请求 | Gemini 破局点1 | v1.5.0 ✅ |
| 5 | 流式 gzip 预览 | Claude BUG#2 | v1.5.0 ✅ |
| 6 | Worker 池并行切片提取 | Claude ARCH#6 | v1.6.0 ✅ |
| 7 | SOLID 架构重构（拆分 5 模块） | Claude 尾部 | v1.1.0 ✅ |
| 8 | throwIfAborted 频率优化 | Claude PERF#1 | v1.3.3 ✅ |
| 9 | 异步 gzip 解压 | Claude PERF#2 | v1.3.3 ✅ |
| 10 | 双缓存合并为单一 LRU | Claude PERF#4 | v1.3.3 ✅ |
| 11 | Worker 代码合并去重 | Claude PERF#5 | v1.3.3 ✅ |
| 12 | compressResponse 管道流式压缩 | Claude PERF#6 | v1.3.3 ✅ |
| 13 | WebGL2 渲染器 + R32F 纹理 | ChatGPT P0 | v1.3.2 ✅ |
| 14 | Transferable ArrayBuffer | ChatGPT P0 | v1.3.2 ✅ |
| 15 | Rust Native 加速 | ChatGPT P2 | v1.3.2 ✅ |
| 16 | VolumeCache 内存管理 | DeepSeek 数据层 | v1.3.2 ✅ |
| 17 | 切片预取 | Grok 交互层 | v1.3.2 ✅ |
| 18 | 分块下载 + 进度报告 | Grok I/O 层 | v1.3.2 ✅ |
| 19 | localResourceRoots 安全修复 | Claude ARCH#5 | v1.3.2 ✅ |

---

## 二、未执行项（按优先级排序）

### 🔴 P0 — 必须尽快执行（影响核心体验）

#### 2.1 GPU 3D 纹理 / Volume Rendering
- **来源**: ChatGPT P0、Grok 渲染层、Gemini 破局点4、Kimi 渲染层
- **问题**: 当前仅使用 `TEXTURE_2D` 逐切片渲染，每次滚动切片都要从 CPU 提取新数据并上传到 GPU
- **目标**: 使用 `TEXTURE_3D` 将完整体数据上传为 3D 纹理，切片提取在 GPU shader 中通过 `texture()` 采样完成
- **收益**: 滚动切片变为纯 GPU uniform 更新，零带宽，144Hz 流畅
- **工作量**: 2-3 周
- **技术要点**:
  - WebGL2 `gl.TEXTURE_3D` + `texImage3D`
  - Shader 中根据 slice index 计算 3D UVW 坐标
  - 支持 axial/coronal/sagittal 任意方向
  - 回退：大体积超出 GPU 显存限制时，分块上传或降级为当前 2D 模式

#### 2.2 GPU 端窗宽窗位（Window/Level）
- **来源**: ChatGPT P1、Gemini 破局点4、Grok 渲染层
- **问题**: 当前 W/L 在 CPU 端计算 lo/hi 后作为 uniform 传入，每次调整都要重新计算
- **目标**: 原始体素值直接作为 `R32F` 或 `R16F` 纹理上传，W/L 计算完全在 fragment shader 中完成
- **收益**: 拖动 W/L 时 60fps 无延迟，无需 CPU 参与
- **工作量**: 1 周（可与 3D 纹理一起实现）
- **技术要点**:
  ```glsl
  float normalized = clamp((rawValue - (level - width/2.0)) / width, 0.0, 1.0);
  ```

#### 2.3 SharedArrayBuffer 零拷贝通信
- **来源**: ChatGPT P0、DeepSeek 传输层、Grok 传输层、Kimi 传输层
- **问题**: 当前 Worker → Main 通过 `postMessage(data, [buffer])` 转移，但 Extension Host → Webview 的数据仍通过 HTTP 代理传输，无真正的共享内存
- **目标**: Extension Host 分配 `SharedArrayBuffer`，Webview Worker 直接读写，零拷贝
- **收益**: 消除 Extension Host ↔ Webview 的数据拷贝开销
- **工作量**: 1-2 周
- **技术要点**:
  - VS Code Webview 需要设置 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`
  - 通过 `webviewPanel.webview.html` 注入 `<meta>` 标签或 HTTP 头
  - `new SharedArrayBuffer(size)` 在 Extension Host 创建，通过 `postMessage` 传递引用

---

### 🟠 P1 — 重要优化（显著提升性能）

#### 2.4 WebGPU 支持
- **来源**: ChatGPT P2、Grok 渲染层、Kimi 渲染层
- **问题**: WebGL2 有隐式状态机开销，无计算着色器，纹理管理不够显式
- **目标**: 添加 WebGPU 渲染路径，WebGL2 作为回退
- **收益**: 计算着色器做直方图、强度归一化；显式内存管理；现代纹理格式原生支持
- **工作量**: 3-4 周
- **技术要点**:
  - `navigator.gpu.requestAdapter()` 检测支持
  - `GPUTexture` 3D 体积纹理
  - Compute Shader 用于 MIP、体渲染 ray marching
  - WebGPU 的 `renderBundle` 预录制静态管线

#### 2.5 WASM SIMD 加速
- **来源**: ChatGPT P2、DeepSeek 计算层、Gemini 第三部分
- **问题**: Worker 中的 NIfTI 解析和切片提取仍是纯 JavaScript
- **目标**: 将解析逻辑用 Rust 编译为 WASM，开启 SIMD (`-msimd128`)
- **收益**: 解析速度提升 3-5 倍
- **工作量**: 2-3 周
- **技术要点**:
  - `wasm-pack` + `rayon`（多线程 WASM）
  - Rust `nifti` crate 或自实现解析器
  - 输出 TypedArray，直接 transferable

#### 2.6 OffscreenCanvas 渲染
- **来源**: Claude 阶段3
- **问题**: 渲染仍在主线程执行，大体积数据量时主线程阻塞
- **目标**: 使用 `canvas.transferControlToOffscreen()` + Worker 中渲染
- **收益**: 主线程完全解放，只处理 UI 事件
- **工作量**: 1-2 周
- **技术要点**:
  - 主线程创建 OffscreenCanvas 后 transfer 到 Worker
  - Worker 中执行所有 WebGL/WebGPU 渲染命令
  - 通过 `postMessage` 传递渲染参数（slice index、W/L 等）

#### 2.7 预测性预取引擎
- **来源**: Grok 交互层、Kimi 交互层
- **问题**: 当前预取只是简单的相邻切片，无速度感知
- **目标**: 根据滚动速度和方向，动态调整预取范围和优先级
- **收益**: 快速滚动时无白屏，慢速滚动时节省带宽
- **工作量**: 1 周
- **技术要点**:
  ```typescript
  class PredictivePrefetcher {
    private scrollVelocity = 0;
    onScroll(sliceIndex: number) {
      const velocity = (sliceIndex - this.lastSlice) / dt;
      const prefetchCount = Math.min(10, Math.ceil(Math.abs(velocity) * 3));
      for (let i = 1; i <= prefetchCount; i++) {
        this.prefetch(sliceIndex + Math.sign(velocity) * i);
      }
    }
  }
  ```

#### 2.8 IndexedDB 磁盘缓存
- **来源**: Grok I/O 层、Kimi 缓存管理
- **问题**: 远程文件的分块数据每次重新下载，无持久化缓存
- **目标**: 将远程下载的切片/分块缓存到 IndexedDB，按 URL + range 作为 key
- **收益**: 重复访问远程文件时秒开
- **工作量**: 1-2 周
- **技术要点**:
  - IndexedDB 存储 `ArrayBuffer` 分块
  - LRU 淘汰策略
  - 缓存过期检查（ETag / Last-Modified）

---

### 🟡 P2 — 长期架构升级（决定天花板）

#### 2.9 分块体数据 / Chunked Volume
- **来源**: ChatGPT P0 核心、Grok 数据层、Claude 阶段4
- **问题**: 数据模型仍是 `VolumeImage.data: TypedArray`（完整加载），无 streaming
- **目标**: 实现 `VolumeProvider { getChunk(x,y,z,lod) }` 抽象，支持 Zarr/N5 格式
- **收益**: 只加载当前视图附近的数据，支持 TB 级体积
- **工作量**: 4-6 周
- **技术要点**:
  - 体数据按 64x64x64 分块
  - HTTP Range 请求分块
  - LOD 金字塔（1/2、1/4、1/8 分辨率）
  - 类似 neuroglancer 的 chunk 管理

#### 2.10 多级缓存架构
- **来源**: Kimi 缓存管理
- **问题**: 只有 VolumeCache（内存 LRU），缺少 GPU 显存级和磁盘级缓存
- **目标**: L1 GPU Texture → L2 WASM 内存池 → L3 IndexedDB 磁盘 → L4 远程源
- **收益**: 完整的缓存层次，最大化复用
- **工作量**: 2-3 周
- **技术要点**:
  - GPU 显存 LRU（按 chunk 为单位）
  - WASM 内存池固定大小分配（避免 JS GC）
  - IndexedDB 持久化分块

#### 2.11 HTTP/2 多路复用代理
- **来源**: Claude ARCH#1
- **问题**: 当前 HTTP/1.1 代理，快速滚动时请求排队
- **目标**: 升级到 HTTP/2 或 HTTP/3，支持并发多路复用
- **收益**: 同时请求多个切片无阻塞
- **工作量**: 1-2 周
- **技术要点**:
  - Node.js `http2` 模块
  - 或 `spdy` / `fastify` 框架

#### 2.12 索引化 GZIP 随机访问
- **来源**: Grok I/O 层、Kimi 远程优化、Gemini 第一部分
- **问题**: `.nii.gz` 不支持随机 seek，必须从头解压
- **目标**: 构建 `zran.c` 风格的 GZIP 索引，实现任意位置快速解压
- **收益**: 远程 `.nii.gz` 切片级随机访问，无需下载完整文件
- **工作量**: 3-4 周
- **技术要点**:
  - 首次打开时后台构建索引（1-3 秒）
  - 索引持久化到磁盘
  - 根据索引定位最近同步点，局部解压

#### 2.13 真正的 LOD 金字塔
- **来源**: Claude ARCH#3
- **问题**: 当前 `/lod/` 端点只对单个切片降采样，不是完整的多分辨率体金字塔
- **目标**: 构建完整 3D 多分辨率金字塔，类似 Google Maps 瓦片
- **收益**: 初始加载显示低分辨率预览，后台异步加载高分辨率
- **工作量**: 3-4 周
- **技术要点**:
  - LOD0: 原始分辨率
  - LOD1: 1/2 分辨率
  - LOD2: 1/4 分辨率
  - 初始加载策略：0ms 显示空白画布 → 50ms LOD2 → 200ms LOD1 → 1000ms LOD0

#### 2.14 Rust Core Engine 扩展
- **来源**: ChatGPT P2、Grok 计算层
- **问题**: 当前 Rust native 只做 parser acceleration，不是完整 Volume Engine
- **目标**: 扩展 Rust 模块为完整 Volume Engine（mmap、SIMD 解压、切片提取）
- **收益**: 接近原生 ITK-SNAP 的解析速度
- **工作量**: 4-6 周
- **技术要点**:
  - `memmap2` 内存映射本地文件
  - `zstd` / `libdeflate` 高速解压
  - `ndarray` + `simd` 体素处理
  - `napi-rs` 暴露 JS API

---

### 🟢 P3 — 远景功能（可选）

#### 2.15 体渲染 Ray Marching
- **来源**: Mimo 渲染、Grok 渲染层
- **目标**: 3D 体渲染视图，支持透明度传递函数
- **工作量**: 4-6 周

#### 2.16 DICOM 支持
- **来源**: Grok Phase 4
- **目标**: 支持 DICOM 格式解析和显示
- **工作量**: 3-4 周

#### 2.17 分割工具
- **来源**: Mimo Phase 5
- **目标**: 阈值分割、水平集、Snake 等基础分割
- **工作量**: 6-8 周

#### 2.18 多模态配准显示
- **来源**: Mimo Phase 5
- **目标**: 同时显示多个 volume，支持 overlay 融合
- **工作量**: 4-6 周

---

## 三、推荐实施顺序

```
Phase A: GPU 渲染革命（2-3 周）
  ├── 3D 纹理上传 + GPU 切片提取
  ├── GPU 端窗宽窗位
  └── OffscreenCanvas 渲染移出主线程
  预期: 切片滚动 60fps，W/L 调整零延迟

Phase B: 零拷贝通信（1-2 周）
  ├── SharedArrayBuffer 配置
  ├── Extension Host ↔ Webview 共享内存
  └── Worker 池直接读写 SAB
  预期: 消除数据拷贝开销

Phase C: 智能缓存（2-3 周）
  ├── IndexedDB 磁盘缓存
  ├── 预测性预取引擎
  └── 多级缓存架构
  预期: 远程文件重复访问秒开

Phase D: 现代 API（3-4 周）
  ├── WebGPU 渲染路径
  ├── WASM SIMD 解析
  └── HTTP/2 代理
  预期: 充分利用 2026 年硬件

Phase E: 分块架构（4-6 周）
  ├── Chunked Volume 抽象
  ├── Zarr/N5 格式支持
  ├── 索引化 GZIP
  └── 真正 LOD 金字塔
  预期: 支持 TB 级体积，媲美 neuroglancer

Phase F: 功能扩展（长期）
  ├── 体渲染 Ray Marching
  ├── DICOM 支持
  ├── 分割工具
  └── 多模态配准
```

---

## 四、关键决策点

| 决策 | 选项 A | 选项 B | 建议 |
|------|--------|--------|------|
| 渲染 API | WebGL2 为主 | WebGPU 为主 | 先 WebGL2 3D 纹理，再逐步迁移 WebGPU |
| 远程 gzip | 索引化 GZIP | 转 Zarr 格式 | 短期索引化 GZIP，长期支持 Zarr |
| 数据模型 | 完整 TypedArray | Chunked Volume | 当前保留，新功能用 Chunked 抽象 |
| 通信方式 | HTTP 代理 | SharedArrayBuffer | 两者并存，SAB 用于大体积，HTTP 用于切片 |
| UI 框架 | 原生 TS | Svelte/React | 保持原生 TS，减少依赖 |

---

## 五、与顶尖工具对比

| 特性 | ITK-SNAP | Niivue | 当前 NiftiSpy | 目标 NiftiSpy |
|------|----------|--------|---------------|---------------|
| 架构 | C++ 原生 | 纯 WebGL2 | VS Code + WebGL2 | VS Code + WebGPU/WASM |
| 远程支持 | 无 | 有限（全量） | HTTP Range | 流式 + 智能缓存 |
| 渲染 | OpenGL | WebGL2 3D 纹理 | WebGL2 2D 纹理 | WebGPU 3D 纹理 |
| 内存模型 | mmap | JS 堆 | JS 堆 + HTTP | WASM 内存池 + GPU |
| 分块 | 否 | 否 | 否 | 是 |
| 安装 | 独立软件 | 浏览器 | VS Code 扩展 | VS Code 扩展 |
| W/L | GPU | GPU | CPU→GPU | GPU shader |
| 体渲染 | 是 | 有限 | 否 | 是 |

---

## 六、立即开始的三个动作

1. **验证 WebGL2 3D 纹理原型**（1 天）
   - 上传 256³ `R32F` 3D 纹理
   - 用 fragment shader 提取任意方向切片
   - 验证帧率是否达到 60fps+

2. **配置 SharedArrayBuffer**（1 天）
   - 在 VS Code Webview 中设置 COOP/COEP 头
   - 验证 `new SharedArrayBuffer()` 可用
   - 测试 Extension Host ↔ Webview 零拷贝传输

3. **IndexedDB 缓存原型**（2-3 天）
   - 实现简单的 key-value 存储（URL + range → ArrayBuffer）
   - 测试缓存命中和 LRU 淘汰
   - 测量缓存读取 vs 网络请求速度差异

---

*本 Plan 基于 7 个 AI 助手的综合意见，结合当前代码库 v1.1.0 的实际状态生成。*
*建议按 Phase A → B → C → D → E 的顺序逐步实施，每个 Phase 完成后发布一个小版本。*
