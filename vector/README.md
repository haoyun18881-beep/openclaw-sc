# 向量检索 · USearch HNSW

## 架构

```
bridge.js → usearch-bridge.js → Python(embed-serve.py, GPU) + USearch(C++ HNSW, 本地)
```

- **嵌入层**: `scripts/embed-serve.py` — Python `sentence-transformers` GPU 推理，stdin/stdout 通信
- **检索层**: USearch — 内嵌 C++ HNSW 索引，0ms 网络开销，0.3ms 搜索
- **元数据**: `memory/hippocampus/usearch_meta.jsonl` — key→{text,source} 映射，启动时加载到 Map

## 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Python | 3.12+ | 嵌入推理 |
| sentence-transformers | latest | BGE-M3 文本嵌入 |
| numpy | latest | 向量运算 |
| Node.js | 24+ | 运行时 |
| usearch (npm) | 2.25+ | C++ HNSW 索引（需编译） |
| Visual Studio BuildTools | 2022 | usearch npm 编译（C++ 桌面开发工作负载） |

## 模型

| 项目 | 值 |
|------|-----|
| 模型 | `nomic-ai/nomic-embed-text-v1.5` |
| 维度 | 768 |
| 距离 | Cosine |
| 推理设备 | CUDA GPU |
| 镜像源 | `HF_ENDPOINT=https://hf-mirror.com` |

## 索引参数

| 参数 | 值 | 说明 |
|------|-----|------|
| metric | cos | 余弦相似度 |
| dtype | f32 | 32位浮点 |
| connectivity (M) | 16 | HNSW 图层连接数 |
| expansion_add | 128 | 插入时的搜索宽度 |
| expansion_search | 64 | 查询时的搜索宽度 |

## 性能

| 指标 | 冷启动 | 热查询 |
|------|--------|--------|
| 嵌入 | ~300ms (CUDA warmup) | ~6ms |
| 搜索 (USearch) | <1ms | ~0.3ms |
| 元数据查询 | ~2s (加载1M条目) | ~1ms (Map) |
| **总耗时** | ~15s | **~7ms** |

## 文件

| 文件 | 说明 |
|------|------|
| `scripts/embed-serve.py` | 嵌入服务（stdin/stdout，GPU） |
| `scripts/migrate_to_usearch.py` | Qdrant → USearch 迁移脚本 |
| `scripts/qdrant-serve.py` | Qdrant 完整服务（BUILD增量编译用，待迁移到 USearch） |
| `vector/usearch-bridge.js` | Node.js 桥接（USearch + Metadata + 嵌入进程管理） |
| `memory/hippocampus/usearch_vectors.index` | USearch HNSW 索引文件（~1GB） |
| `memory/hippocampus/usearch_meta.jsonl` | 元数据文件（text + source, ~200MB） |

## 数据流

```
用户搜索 "关键词"
  → core_memorySearch(semantic_search)
  → bridge.js: qdrantSearch()
  → usearch-bridge.js: qdrantQuery()
      1. loadIndex() — Index.view() 从 NVMe 映射索引
      2. loadMeta() — 读 meta.jsonl → Map
      3. embedText() → Python embed-serve.py(stdin) → 768维向量
      4. idx.search(vec, topK) → USearch C++ HNSW → keys + distances
      5. 查 Map 获取 text/source
  → 返回 { results, total_in_index, elapsed_ms }
```

## 迁移

```powershell
# 从 Qdrant 迁移到 USearch（103万条，约10分钟）
py -3.12 scripts/migrate_to_usearch.py
```

## 已知问题

1. **冷启动慢**: 首次搜索需 ~15s（模型加载 + CUDA warmup + 元数据加载）。后续热查询 ~7ms
2. **VS BuildTools 必须**: `npm install usearch` 需要 C++ 桌面开发工作负载
3. **增量编译**: 当前 BUILD 仍走 Qdrant Python 脚本，需迁移到 USearch 本地增量
4. **元数据内存**: 1M 条目约 200MB，1亿条约 20GB——届时需换 SQLite/lmdb

## 历史

| 版本 | 引擎 | 搜索耗时 | 网络层 | 增量 |
|------|------|---------|--------|------|
| v1 | FAISS GPU | 2-4ms | Python HTTP | ❌ 需加锁 |
| v2 | LanceDB | 2s→40ms | Python HTTP | ✅ MVCC |
| v3 | Qdrant gRPC | 3-16ms | gRPC/HTTP | ✅ 并发 |
| v4 | USearch HNSW | 0.3ms | 无 | ✅ HNSW动态 |
