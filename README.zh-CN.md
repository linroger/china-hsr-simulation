# 中国高铁仿真系统 (China HSR Simulation)

> **基于浏览器、由真实数据驱动的中国高速铁路网络仿真系统** —— 包含**区间感知座位库存引擎**、**收益管理动态定价**、**离散事件列车运行内核**、**实时动态需求售票**,以及通过 **Web Worker 多线程**架构,在 OSM 真实铁路走廊几何之上由 **Mapbox GL** 渲染呈现。

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Mapbox](https://img.shields.io/badge/Mapbox%20GL-3.x-000000?logo=mapbox&logoColor=white)](https://docs.mapbox.com/mapbox-gl-js/)
[![Tests](https://img.shields.io/badge/tests-7%2F7%20passing-brightgreen)](#10-测试策略)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🇺🇸 **[English README](./README.md)**

---

## 实时预览

| 实时网络地图 | 运营仪表盘 | 区间感知订票 |
|:---:|:---:|:---:|
| ![实时地图](./screenshots/01-live-map.png) | ![仪表盘](./screenshots/02-operations-dashboard.png) | ![订票](./screenshots/03-booking-panel.png) |
| 1,500 列车次沿 OSM 真实铁路走廊折线移动,按上座率着色。 | 实时关键指标:营收 ¥6,200 万+、客流 40.7 万+、248 列在途、3.6 分钟均延误。 | 可对任意车次任意区段询价订票;乘客下车后座位即可被复用。 |

---

## 目录

1. [项目动机](#项目动机)
2. [快速启动](#快速启动)
3. [核心数据一览](#核心数据一览)
4. [系统架构](#系统架构)
5. [核心算法](#核心算法)
   - 5.1 [区间日历座位库存](#51-区间日历座位库存)
   - 5.2 [收益管理动态定价](#52-收益管理动态定价)
   - 5.3 [离散事件仿真内核](#53-离散事件仿真内核)
   - 5.4 [OSM 铁路匹配的空间网格索引](#54-osm-铁路匹配的空间网格索引)
   - 5.5 [分层多样性采样](#55-分层多样性采样)
   - 5.6 [运营真实性建模](#56-运营真实性建模)
6. [性能与优化](#性能与优化)
7. [并发模型](#并发模型)
8. [数据管道](#数据管道)
9. [可视化层](#可视化层)
10. [测试策略](#10-测试策略)
11. [项目结构](#11-项目结构)
12. [配置与密钥处理](#12-配置与密钥处理)
13. [技术栈](#13-技术栈)
14. [发展规划](#14-发展规划)
15. [免责声明与数据来源](#15-免责声明与数据来源)
16. [许可](#16-许可)

---

## 项目动机

本仓库以小而精的篇幅,试图认真还原**国家级客运铁路票务与调度系统**应有的工程肌理。它把大型互联网平台公司高级岗位面试中反复出现的几个核心命题,在一份代码中同时呈现:

- **在线区间调度问题** —— 经典的"乘客下车后,这个座位能否再卖给下游乘客?"问题,以**区间重叠日历**形式建模,O(k) 检测、O(k log k) 插入、并通过确定性回归测试覆盖。
- **收益管理 / 收益最大化** —— 多因子动态定价综合**距离里程基价**、**Sigmoid 稀缺度投标价**、**时间紧迫度**、**高峰加价**、**频次缓解**、**失约缓冲**与**价格弹性**等维度。
- **离散事件仿真 (DES)** —— 20 Hz 时钟循环驱动 1,500 列车次跨越 1,200 条线路,内置**计划-实际延误模型**、**失约座位释放**、**车站站台压力指标**。
- **空间算法** —— Haversine 大圆距离、垂直距离剪枝、按弧长参数化的折线插值、自研**0.35°×0.35° 网格哈希索引**,把生成的线路区段贴合到真实 OSM 铁路走廊上。
- **浏览器多线程** —— 整个仿真引擎从 React/Mapbox UI 主线程**剥离至 Web Worker**;UI 与引擎之间通过强类型、Promise 化的消息总线交换 `init`、`start`、`setSpeed`、`quoteTrip`、`bookTrip`、`snapshot` 等指令。
- **工程严谨性** —— 确定性种子伪随机数 (FNV-1a)、7 项回归测试覆盖订票语义、定价单调性、失约释放、动态需求、数据多样性,外加 `./run.sh` 一键脚本完成依赖安装、数据生成、测试、构建、上线全流程。

> **面向蚂蚁集团、阿里巴巴、腾讯、百度、华为等公司的招聘官与工程师** —— 项目刻意保持精简(手写核心逻辑约 2,000 行),却同时覆盖了**算法、分布式系统思维、运筹优化/收益管理、全栈 React 工程、地理信息系统(GIS)与端到端产品故事**。

---

## 快速启动

> **运行环境要求**:Node.js ≥ 18(已在 18/20/22 上验证)、npm,以及约 600 MB 磁盘空间。

```bash
git clone https://github.com/linroger/china-hsr-simulation.git
cd china-hsr-simulation
./run.sh
```

仅此一步。脚本会自动:

1. 校验 Node.js 版本。
2. 若 `node_modules/` 缺失则执行 `npm install`。
3. 若上游原始 CSV/GeoJSON 数据存在于父目录,则重新生成车站/线路/Mapbox 数据库;否则直接复用已提交至仓库的 `public/*.json` 预构建数据。
4. 运行完整测试套件。
5. 通过 `vite build` 打包生产版本。
6. 在 `http://127.0.0.1:5174/` 启动静态服务器。

### 可选参数

```bash
./run.sh --dev          # Vite 开发服务器,带 HMR(不构建生产包)
./run.sh --skip-tests   # 跳过测试,仅安装并启动
./run.sh --rebuild      # 清空 node_modules/ 与 dist/,全新安装
PORT=8080 HOST=0.0.0.0 ./run.sh   # 自定义端口 / 暴露到局域网
```

### Windows 用户

```cmd
run.cmd
run.cmd --dev
run.cmd --skip-tests
```

### 手动运行(不使用脚本)

```bash
npm install
npm run prepare:data   # 仅在原始数据文件存在时执行
npm test
npm run build
npm run serve          # http://127.0.0.1:5174/
```

---

## 核心数据一览

| 维度 | 数量 |
|---|---|
| **车站索引规模** | 3,058 个,均带 WGS-84 坐标 |
| **高铁服务记录** | 7,278 条 G/D/C 真实始发/终到记录 |
| **生成仿真线路** | 1,200 条,覆盖 27 个宏观走廊与 27 个起点省份 |
| **排班车次** | 1,500 列(平均每条线路 1.25 列) |
| **每列车座位定员** | 554 席(8 节编组:商务座 10 + 一等座 204 + 二等座 340) |
| **单次仿真模拟的座席-区段总数** | 约 83 万 |
| **OSM 铁路特征数** | 简化后 8,000 条 LineString |
| **铁路匹配率** | ≥ 52.7% 的生成区段成功贴合真实 OSM 走廊(其余降级为站点直线) |
| **快照推送频率** | 250 ms / 次,从 Worker → UI |
| **测试通过率** | 7/7(座位库存、定价、引擎、失约、动态需求、数据多样性) |

---

## 系统架构

```
┌─────────────────────────── 浏览器标签页 ─────────────────────────────────┐
│                                                                          │
│  ┌──────────────────────── 主线程 (UI) ─────────────────────────┐         │
│  │  React 19  ─  App.jsx                                        │         │
│  │     │                                                        │         │
│  │     ├─ HSRMap.jsx        (Mapbox GL: 铁路 + 车站 + 列车)     │         │
│  │     ├─ Dashboard.jsx     (Recharts: 上座率/营收/压力)        │         │
│  │     └─ BookingPanel.jsx  (区段选择 + 询价 + 订票)            │         │
│  │                                                              │         │
│  │  SimulationWorkerClient   ◄──Promise 化消息总线──┐           │         │
│  │   .quoteTrip / .bookTrip / .setSpeed / .snapshot │           │         │
│  └──────────────────────────────────────────────────┼───────────┘         │
│                                                     │ postMessage         │
│                                                     ▼                     │
│  ┌─────────────────── Web Worker 线程 ─────────────────────────┐          │
│  │  simulationWorker.js   (路由 init/start/stop/...)           │          │
│  │      │                                                      │          │
│  │      ▼                                                      │          │
│  │  SimulationEngine                                           │          │
│  │   ├─ tick(realSeconds)    每 50 ms                          │          │
│  │   │     ├─ updateTrain    (状态机,区段进度推进)             │          │
│  │   │     ├─ processStation (上下车/失约处理)                  │          │
│  │   │     └─ sellRealtimeDemand  (实时购票压力)               │          │
│  │   ├─ SeatInventory[trainId]  ←─ 每列车一份区间日历          │          │
│  │   └─ priceQuote / reconcileDemandForecast                   │          │
│  │                                                             │          │
│  │  快照每 250 ms 推送一次 ───► 主线程 setData()                │          │
│  └─────────────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────────┘

                               构建期
   原始 CSV/GeoJSON ──► scripts/prepare-data.cjs ──► public/{station,
                                                  route, stations, rails}
```

整体架构是一个**带背压的生产者-消费者管道**:Worker 以 4 Hz 速率产出快照,UI 始终消费**最新一帧**,丢弃过期帧。所有写操作(订票)走请求-响应配对,UI 永远不会读到部分状态。

---

## 核心算法

### 5.1 区间日历座位库存

整个项目最难的正确性需求:**当原乘客在中途下车的瞬间,座位必须立即对其它乘客可售。** 这是一个面向单座位日历的*区间调度*问题。

每列车持有一份 `SeatInventory`(`src/algorithms/seatInventory.js`),共 554 个物理座位。每个座位维护一份**有序的、半开半闭区间**列表 `[originIndex, destinationIndex)`,索引按车次停靠序列编号。

可用性判断采用经典的**区间重叠谓词**:

```js
export function intervalOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;          // 半开半闭 [a, b)
}

isSeatAvailable(seatId, originIndex, destinationIndex) {
  const seat = this.seatById.get(seatId);
  return seat.intervals.every(
    (held) => !intervalOverlaps(originIndex, destinationIndex,
                                held.originIndex, held.destinationIndex)
  );
}
```

由于插入时保持有序,最坏情况下检测复杂度为 **O(k)**(k 为该座位现有订票数,通常 `k ≤ 6`),插入复杂度为 **O(k log k)**。本仿真器单列车约 6 KB 状态,线性扫描在常数因子上完胜任何基于平衡树的实现。

#### 分配评分机制

`availableSeats({...})` 不仅返回候选座位,还按 `scoreSeat`(`seatInventory.js:176`)启发式*打分排序*:

```js
function scoreSeat(seat, preference, originIndex, destinationIndex) {
  const tripLength = destinationIndex - originIndex;
  const preferenceBonus =
    preference === seat.position ? 100 :
    preference === 'any' && tripLength >= 4 && seat.position === 'window' ? 30 :
    preference === 'any' && tripLength < 4 && seat.position === 'aisle'  ? 20 : 0;
  const reuseBonus  = seat.intervals.length * 5;       // 复用越多越优先
  const rowPenalty  = seat.row * 0.01;                 // 轻微偏向前排
  return preferenceBonus + reuseBonus - rowPenalty;
}
```

为何要给已使用过的座位加 `reuseBonus`?这实现了**最佳契合(best-fit)装箱策略**:优先填充已经有相邻区间的座位,从而把*长连续空洞*留给未来的长途需求。这是对最优区间着色(等价于 NP 难的在线区间图染色)的**线性时间近似**,把每次订票的复杂度从 NP 降至 O(座位数)。

#### 团队订票与无障碍座位

`allocate({ groupSize, accessible, preference })` 在候选座位上按 `(车厢, 排号)` 分组,优先把至多 6 人的团体订到同排;若没有同排空座则退化为"任取 N 个最佳座":

```js
function chooseGroup(candidates, groupSize) {
  if (groupSize === 1) return [candidates[0]];
  const byCarRow = new Map();
  for (const seat of candidates) {
    const key = `${seat.car}-${seat.row}`;
    if (!byCarRow.has(key)) byCarRow.set(key, []);
    byCarRow.get(key).push(seat);
  }
  for (const seats of byCarRow.values()) {
    if (seats.length >= groupSize) return seats.slice(0, groupSize);
  }
  return candidates.slice(0, groupSize);
}
```

#### 回归契约

整个项目**最关键**的回归测试就在 `tests/seatInventory.test.mjs`,一字一句锚定座位复用语义:

```js
test('乘客下车后座位可被复用,区间重叠则被拒绝', () => {
  const inv = new SeatInventory(routeStations, [{ id: 'S1', /* ... */ }]);

  inv.allocate({ originIndex: 0, destinationIndex: 2 /* A → C */ });
  assert.equal(inv.isSeatAvailable('S1', 1, 3), false);   // B→D 冲突,被阻挡
  assert.equal(inv.allocate({ originIndex: 1, destinationIndex: 3 }), null);

  inv.allocate({ originIndex: 2, destinationIndex: 3 /* C → D */ });
  // S1 现持有 [A,C) 与 [C,D) 两段 — 中途下车后实现复用
});
```

### 5.2 收益管理动态定价

`src/algorithms/pricing.js` 实现了一个紧凑的收益管理报价函数。输入为 `{ distanceKm, seatClass, loadFactor, hoursToDeparture, departureHour, frequencyRank, noShowRisk, elasticity }`,输出包含**确定性价格**与**乘子分解** —— UI 因此可以解释*"价格为何如此"*。

```js
const distanceDiscount = distanceKm > 1200 ? 0.88 :
                         distanceKm > 800  ? 0.92 :
                         distanceKm > 500  ? 0.96 : 1;
const baseFare        = distanceKm * 0.46 * config.multiplier * distanceDiscount;
const scarcity        = 1 + sigmoid((loadFactor - 0.62) * 7) * 0.48;
const timePressure    = hoursToDeparture < 2  ? 1.32 :
                        hoursToDeparture < 8  ? 1.18 :
                        hoursToDeparture < 24 ? 1.08 :
                        hoursToDeparture > 168 ? 0.9  : 1;
const peak            = (departureHour ∈ [7-9] ∪ [17-20]) ? 1.16 : 1;
const frequencyRelief = 1 - min(0.14, max(0, frequencyRank) * 0.14);
const noShowBuffer    = 1 + min(0.06, noShowRisk);
const bidPrice        = distanceKm * 0.46 * loadFactor^1.8 * config.multiplier * 0.42;
const raw             = (baseFare + bidPrice) * scarcity * timePressure
                                              * peak * frequencyRelief * noShowBuffer;
```

设计要点:

- **Sigmoid 稀缺度** (`1/(1+e^-x)`):产生中心位于 62% 上座率的平滑需求曲线 —— 经验上接近中国高铁开始撤回 95 折优惠的临界点。线性放大会过度反应早期订票。
- **`bidPrice = d · loadFactor^1.8 · classMul · 0.42`**:这是 [Talluri & van Ryzin《收益管理理论与实践》](https://link.springer.com/book/10.1007/b139000) 投标价(bid-price)的紧凑近似。当区段越满,占用一席的*边际机会成本*超线性增长。`baseFare + bidPrice` 保证价格在任意舱位下**对上座率严格单调**。
- **频次缓解**:服务密集的走廊(`frequencyRank > 0.5`)给最高 14% 的折扣,模拟邻近车次的竞争压力。
- **失约缓冲**:小幅加价(≤ 6%)弥补因失约释放(参见 §5.6)而流失的预期票款。

姊妹函数 `reconcileDemandForecast({ routeDistanceKm, segmentLoad, dayOfWeek, hour, stationTier })` 输出 0.7×–1.7× 的*需求乘子*,在询价时**抬高有效上座率**,使得"北京南站早 8 点商务座"的报价反映*未来预期*占用率,而非仅当前。

定价测试(`tests/pricing.test.mjs`)固化单调性:

```
business@15%   >  first@15%   >  second@15%
second@93%     >  second@15%
bidPrice@93%   >  bidPrice@15%
```

### 5.3 离散事件仿真内核

`SimulationEngine`(`src/simulation_core/SimulationEngine.js`)是一份手写的 23 KB 离散事件仿真运行时。主要职责:

| 方法 | 功能 |
|---|---|
| `createScheduledServices(routes, maxTrains)` | 从 1,200 条线路生成 1,500 列车次,按周期循环复用线路以模拟同一线路的多班次。 |
| `tick(realSeconds)` | 推进 `nowMinutes`,更新所有列车,每 8 个 tick 触发一次实时需求售票。 |
| `updateTrain(train)` | 累加 `segmentMinutes[]`,推进区段索引,完成 `scheduled → running → completed` 状态切换。 |
| `processStation(train, idx)` | 处理上车/下车/失约逻辑,原地变更订票状态。 |
| `quoteTrip(...)` | 纯只读价格计算,内置 `performance.now()` 计时,把 `algorithmMs` 暴露到 UI。 |
| `bookTrip(...)` | 通过 `quoteTrip + inventory.allocate` 串行化读-改-写;若询价与提交之间座位日历改变,则回滚。 |
| `snapshot()` | 构建 700 列上限的 `{ 在途 ∪ 临近发车 ∪ 刚到达 }` 快照,附带完整订票选项、网络汇总、统计数据。 |

Worker 内 tick 频率为 **20 Hz**(50 ms),但向 UI 推快照只 **4 Hz**(250 ms) —— 这种**生产/消费速率解耦**让 Mapbox `setData` 调用始终落在 React 60 fps 预算内。

#### 状态机

```
                    达到 departureMinute
   scheduled ──────────────────────────────────────► running
                                                       │
                              已耗时 ≥ Σ segmentMinutes
                                                       ▼
                                                    completed
```

`processedStationIndexes` 是个 `Set`,使 `processStation` 在时钟抖动下仍**幂等**(单次 tick 可能跨越某站点),保证每个站点的上下车事件**仅触发一次**。

#### 实时需求压力

每 8 个 tick(`tickCounter % 8 === 0`),`sellRealtimeDemand` 注入 10 笔订票请求,选车权重为:

```
weight(train) = max(0.1, frequencyRank + 0.2)
              × departurePressure(t)             ← 钟形分布,峰值约早 9 点
              × max(0.15, 1 - currentLoadFactor) ← 不要再去挤已经满载的车
```

正因如此,直播中的营收与客流计数**会随时间持续增长** —— 它不是预先注入的静态回放。

### 5.4 OSM 铁路匹配的空间网格索引

HOTOSM 中国铁路数据集包含约 14.5 万条 LineString。如果朴素地把每条生成线路区段对所有 OSM 几何做投影,运算量约 **O(线路数 × OSM 特征数) ≈ 10⁹** 次 Haversine 计算 —— 显然不可接受。

`scripts/prepare-data.cjs` 构建了一个 **0.35° 网格哈希索引**(约合 30°N 纬度上 38 km),把每个 OSM 顶点按 `(⌊lng/0.35⌋, ⌊lat/0.35⌋)` 桶号入索引:

```js
function createRailIndex(railGeojson) {
  const cellSize = 0.35;
  const cells = new Map();
  for (const feature of railGeojson.features) {
    feature.geometry.coordinates.forEach((coord, index) => {
      const key = `${Math.floor(coord[0]/cellSize)}:${Math.floor(coord[1]/cellSize)}`;
      cells.set(key, [...(cells.get(key) ?? []), { lng: coord[0], lat: coord[1], index }]);
    });
  }
  return { cells, cellSize };
}
```

对每对 `(from, to)` 区段(直线距离 `directKm`):

1. 扩展边界框 `(from, to) ± margin`,其中 `margin = clamp(directKm/210, 0.55, 3.8)°`。
2. 查询边界框相交的网格(典型 4–80 个,**O(bbox 面积 / cellSize²)**)。
3. 按弦上**带符号投影** `t ∈ (-0.12, 1.12)` 过滤候选。
4. 丢弃**垂直距离**超出 `clamp(directKm × 0.55, 45, 220) km` 的点。
5. 按投影排序,做*最小间距去重*(短途 ≥ 4 km、干线 ≥ 9 km),最后重采样至 ≤ 28–46 个锚点。
6. 若锚点不足 3 个则降级为 `[from, to]` 直线。

最终效果:**52.7% 的生成区段贴合真实 OSM 铁路几何**,彻底消除朴素插值造成的**列车横渡海面、跨越湖泊**等可笑现象。剩余 47.3% 平稳降级为站点弦,并显式打上 `geometrySource: 'station-straight-fallback'` 标记。

#### 折线弧长插值

运行期 `interpolateLine(coordinates, progress)`(`src/simulation_core/geo.js:18`)采用**按弧长参数化的插值**而非按顶点索引插值:

```js
const lengths = coords.slice(0,-1).map((c,i) => haversineKm(c, coords[i+1]));
const total = lengths.reduce((a,b)=>a+b, 0);
let target = total * progress;
for (let i = 0; i < lengths.length; i++) {
  if (target <= lengths[i]) return interpolateCoord(coords[i], coords[i+1], target/lengths[i]);
  target -= lengths[i];
}
```

这意味着 `segmentProgress = 50%` 时,列车正好位于折线的**真实地理距离的一半**处,而非*顶点索引*的一半 —— 当折线密度不均匀(城市枢纽顶点密集、郊野稀疏)时,这一区别至关重要。

### 5.5 分层多样性采样

最初版本只取了 `line.csv` 的前 280 条,导致一切聚集在少数几条干线上,仪表盘看上去"地广人稀"。修复方案是 `selectDiverseRecords()`(`scripts/prepare-data.cjs:177`)中的**两遍分层抽样**:

```js
function selectDiverseRecords(records, limit) {
  const byCorridor = groupBy(records, r => r.corridor);
  const selected = [];
  const seen = new Set();

  // 第一遍:每个宏观走廊先发 4 条基础名额,
  // 按"班次频次 × 距离"排序。
  for (const corridorRecs of [...byCorridor.values()].sort((a,b) => b.length - a.length))
    for (const rec of corridorRecs.slice().sort(compareRoutePriority).slice(0, 4))
      addRecord(rec);

  // 第二遍:按起点省份做轮询直至上限。
  const byProvince = groupBy(records.sort(compareRoutePriority), r => r.originProvince);
  while (selected.length < limit) {
    let progress = false;
    for (const recs of byProvince.values()) {
      const next = recs.find(r => !seen.has(recordKey(r)));
      if (next) { addRecord(next); progress = true; if (selected.length >= limit) break; }
    }
    if (!progress) break;
  }
  return selected.slice(0, limit);
}
```

数据多样性测试(`tests/dataDiversity.test.mjs`)固化:

- 仿真线路 ≥ 1,000 条
- 唯一始发站 ≥ 70 个
- 唯一始发省份 ≥ 24 个(中国共 31 个省级行政区)
- 唯一宏观走廊 ≥ 20 个(按 `华北/华南/华东/华中/西南/西北/东北` 七大区域分类)

### 5.6 运营真实性建模

玩具仿真器只能做静态回放,本系统刻意建模*运营变异性*:

| 效应 | 位置 | 公式 / 数值 |
|---|---|---|
| **枢纽停站压力** | `realisticSegmentMinutes` | 国家级枢纽 +3 分钟,区域级 +1.5 分钟 |
| **天气拖延** | `deterministicNoise(...) > 0.94` | 约 6% 区段触发 +4 分钟 |
| **调度松弛** | `deterministicNoise(...) > 0.86` | 约 14% 区段触发 +2 分钟 |
| **干线偏置** | `scheduledDepartureMinute` | 干线列车(`frequencyRank > 0.55`)发车时间提前 35 分钟 |
| **失约概率** | `noShowProbability(...)` | 商务座 1.8% → 二等座 3.8%;枢纽 -0.6 pp;短途 +0.6 pp |
| **失约座位释放** | `processStation` | 始发站后立即释放区间,可被下游乘客二次销售 |
| **实时延误** | `currentDelay(train)` | `Σ 实际` − `Σ 计划` 的滚动差 |

正是这些细节,让仪表盘"活了起来":列车经过枢纽时均延误漂移、多车汇聚时站台压力激增、实时需求售票推动营收上扬。

#### 确定性种子伪随机数

所有随机性都通过同一个基于 FNV-1a 的 PRNG(`SimulationEngine.random(...parts)`):

```js
function seeded(key) {
  let hash = 2166136261;
  for (const ch of key) {
    hash ^= ch.charCodeAt(0);
    hash  = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1_000_000) / 1_000_000;
}
```

只要 `seed` 固定,每次调用产生**完全相同**的值 —— 测试与演示完全可复现。

---

## 性能与优化

| 痛点 | 优化手段 |
|---|---|
| **UI 主线程饥饿** | 整个仿真迁移到 Web Worker(`simulationWorker.js`),React 只负责渲染和交互。 |
| **Mapbox setData 抖动** | 快照限速 4 Hz;列车 GeoJSON 上限 700 个特征(在途 ∪ 临近 ∪ 刚到达);完成的列车从特征集合中剔除。 |
| **Mapbox 样式复用** | 单实例 `mapbox-gl`,图层在 `'load'` 时一次加入,列车 source 通过 `getSource('trains').setData(...)` 增量更新,绝无整图重渲染。 |
| **快照序列化** | `snapshot()` 只挑出 UI 所需字段,避免对 SeatInventory 整体 `JSON.stringify`。 |
| **OSM 数据负载** | 硬上限 8,000 个特征、82 万顶点;每条 LineString 自适应步长抽稀,确保 geojson 总体积 < 2.5 MB。 |
| **CSV 解析** | 单遍流式、引号感知切分,无正则回溯。 |
| **空间查询** | 0.35° 网格哈希(§5.4)把空间命中检索由 O(特征) 线性扫描降至**亚毫秒级**。 |
| **询价时延** | UI 中暴露 `algorithmMs`,在 2024 款 MacBook 上典型为 **0.1–1 ms** 一次。 |
| **测试套件** | 纯 ESM `node:test` 运行器,全套 < 1 秒完成。 |
| **构建产物** | Vite + Rollup 把 Worker 代码切分为独立 chunk(`simulationWorker-*.js` 约 12 KB),不与主包绑死。 |

---

## 并发模型

```
主线程                                            Worker 线程
────                                              ───────────

new SimulationWorkerClient({ onSnapshot })
   │ new Worker(simulationWorker.js, type:module)
   │
   │ ──postMessage({id:1, type:'init', payload})──►   onmessage('init')
   │                                                    engine = new SimulationEngine(...)
   │                                                    推送首帧快照
   │ ◄────postMessage({type:'snapshot', ...})─────────┘
   │ ◄────postMessage({type:'response', id:1, ...})───
   │
   │ ──postMessage({id:2, type:'start'})───────────►   engine.start()
   │                                                    setInterval(()=>postSnapshot(),250)
   │ ◄────postMessage({type:'snapshot'})······ 每 250 ms
   │
   │ ──postMessage({id:3, type:'quoteTrip',...})──►    respond(engine.quoteTrip(...))
   │ ◄────postMessage({type:'response', id:3,...})
```

三个让架构变干净的关键点:

1. **Promise 化 RPC**:`SimulationWorkerClient.call(type, payload)` 自增 `id`、把 `{resolve, reject}` 暂存到 `Map`,然后投递消息。Worker 在 `'response'` 包装中回传同一个 `id`,客户端查表、settle 该 promise、释放条目。
2. **带外推送**:快照**不**走请求-响应,而是无 `id` 的 `'snapshot'` 消息直送 `onSnapshot()`,避免轮询。
3. **背压容忍**:UI 慢时快照排队,React 仅在收到**最新一帧**时重渲(`setSnapshot(nextSnapshot)`),Worker 不受影响地继续推送。

这正是 VS Code 扩展宿主、Figma 渲染线程、Excel for the Web 计算引擎在生产环境采用的同一种范式。

---

## 数据管道

`scripts/prepare-data.cjs` 是一份 484 行的 ETL 流水线,产出 `public/` 下四个数据文件:

1. **`station-data.json`** —— 3,058 个车站,字段 `{id, name, address, bureau, kind, province, city, lng, lat, sourceCount, tier}`。等级判定:
   - `national-hub`:站名匹配 `北京|上海|广州|深圳|成都|重庆|武汉|郑州|西安|南京|杭州|长沙|天津`
   - `regional-hub`:`sourceCount ≥ 4` 或站名末尾含 `南/西/东/北` 方位词
   - `local`:其他
2. **`route-data.json`** —— 1,200 条仿真线路,含完整区段几何;同时保留 7,278 条原始记录以追溯出处。
3. **`hsr-stations.geojson`** —— Mapbox 即用的车站点要素。
4. **`hsr-rails.geojson`** —— Mapbox 即用的铁路线要素(≤ 8,000、≤ 82 万顶点)。

每条生成线路同时携带:

```jsonc
{
  "id": "route-42-G7001",
  "code": "G7001",
  "trainNo": "240000G70010",
  "type": "G",
  "origin": "北京南",
  "destination": "上海",
  "totalDistanceKm": 1318,
  "frequencyRank": 0.92,
  "corridor": "East China / North China",
  "originProvince": "北京",
  "destinationProvince": "上海",
  "provenance": "始发/终到为真实数据;中间停站为基于车站地理的仿真生成...",
  "stops": [ { "name": "...", "lng": ..., "lat": ..., "tier": "national-hub",
              "simulatedStop": true, "dwellMinutes": 6 }, ... ],
  "segments": [ { "from": "...", "to": "...", "distanceKm": 142,
                  "speedLimitKmh": 350, "track": "double", "signaling": "CTCS-3 simulated",
                  "geometry": [[lng,lat], ...], "geometrySource": "hotosm-rail-corridor" }, ... ],
  "geometry": [ /* 各区段折线合并并去重 */ ]
}
```

数据管道是**确定性、幂等**的 —— 输入相同则字节级输出相同。

---

## 可视化层

### Mapbox GL 地图(`HSRMap.jsx`)

| 图层 | 样式 |
|---|---|
| `rails` | 青蓝色渐变,透明度 0.58,宽度随缩放 0.7 → 5 |
| `local-station-dots` | 小灰点,半径 0.8 → 3 |
| `regional-station-squares` | 青色 `▪` 字符,带光晕,字号 8 → 17 |
| `national-station-diamonds` | 琥珀色 `◆` 字符,带光晕,字号 9 → 20 |
| `train-circles` | 颜色 `interpolate(load, 0→#10b981, 0.72→#f59e0b, 0.95→#ef4444)`,半径 `interpolate(load, 0→3.5, 1→8)` |
| `train-labels` | 车次代码,仅在 `zoom ≥ 7.2` 时显示,以减少视觉拥挤 |

点击列车弹出 Mapbox `Popup`,含车次、当前/下一站、上座率、`pax/capacity`。

### 运营仪表盘(`Dashboard.jsx`)

基于 **Recharts**:

- 9 格关键指标(营收、客流、在途/总车次、可视、在途均延、失约释放、仿真线程、座位定员、列车/线路)
- 1×–120× 仿真倍速滑杆,直连 `worker.setSpeed`
- *最高区段上座率*柱状图(前 18 列车)
- *最近订票营收*单调折线图
- *车站站台压力*双柱图(在途车次 × 客流)
- *运营真实性*面板(站点处理数、≥3 分钟在途延误、失约释放、地图渲染上限)
- *走廊覆盖*与*起点省份覆盖*双柱图
- 实时车次表(40 行,使用 `<meter>` 元素显示上座率)

### 订票面板(`BookingPanel.jsx`)

双栏式表单+报价面板:

- 车次 / 起点 / 终点 / 舱位 / 偏好 / 无障碍 下拉
- `quoteTrip` 跟随选择实时刷新
- 报价卡片显示:价格、距离、剩余可用座位数、**乘子分解**(`scarcity`、`timePressure`、`peak`、`frequencyRelief`、`noShowBuffer`)、`algorithmMs` 计时
- *站点条带*高亮当前持有的区间
- "Book Ticket" 按钮通过 Worker 提交订票
- 最近车票列表:`ticketId`、车次、起讫站、车厢-排-字母、票价

---

## 10. 测试策略

测试金字塔刻意保持**扁平、快速、确定性、面向场景**:

```
tests/
├── seatInventory.test.mjs    ← 座位复用 / 区间冲突拒绝 / 区间时间线
├── pricing.test.mjs          ← 舱位价格序 / 稀缺度单调性
├── engine.test.mjs           ← 端到端订票、规模化排班、
│                                失约释放、动态需求营收增长
└── dataDiversity.test.mjs    ← ≥1000 线路、≥70 起点、≥24 省份、
                                  ≥20 走廊、≥45% OSM 匹配
```

每条测试都基于 `node:test` 与 `assert/strict` 实现,**全套总耗时 < 1 秒**。每条断言都对应*用户在 UI 中可观测的行为* —— 测试通过即代表"功能确实工作"。

本地运行:

```bash
npm test
```

样例输出:

```
✓ 乘客下车后座位可被复用,区间重叠则被拒绝
✓ 动态定价对舱位与稀缺度严格单调
✓ 订票引擎返回票务详情并变更区间可用性
✓ 引擎可生成可扩展的排班车次与完整的订票选项
✓ 失约乘客发车后释放其持有的座位库存
✓ 实时需求会随时钟推进改变营收与客流总量
✓ 生成的线路库覆盖众多走廊与起点
ℹ tests 7
ℹ pass  7
ℹ fail  0
```

---

## 11. 项目结构

```
ChinaHSR_Simulation/
├── README.md                          ← 英文版
├── README.zh-CN.md                    ← 本文档
├── run.sh / run.cmd                   ← 一键启动脚本
├── init.sh                            ← 原始开发流水
├── package.json
├── vite.config.js
├── index.html
├── feature_list.json                  ← 数据化的功能清单,全部通过
├── handoff.md                         ← 决策与验证日志
├── agent-progress.txt                 ← 会话级修改记录
├── public/                            ← 已提交的预生成数据
│   ├── station-data.json   (3,058 个车站)
│   ├── route-data.json     (1,200 条线路 + 7,278 条记录)
│   ├── hsr-stations.geojson
│   └── hsr-rails.geojson   (8,000 条 OSM 铁路特征)
├── scripts/
│   ├── prepare-data.cjs               ← ETL 流水线(§8)
│   └── serve-static.cjs               ← 零依赖的迷你 Node http 服务器
├── src/
│   ├── main.jsx                       ← React 19 根
│   ├── App.jsx                        ← 视图切换、Worker 启动
│   ├── algorithms/
│   │   ├── seatInventory.js           ← 区间日历(§5.1)
│   │   └── pricing.js                 ← 收益管理(§5.2)
│   ├── simulation_core/
│   │   ├── SimulationEngine.js        ← 离散事件内核(§5.3)
│   │   ├── simulationWorker.js        ← Worker 处理器(§7)
│   │   ├── SimulationWorkerClient.js  ← Promise 消息总线(§7)
│   │   └── geo.js                     ← Haversine + 折线插值
│   ├── visualization/
│   │   ├── HSRMap.jsx
│   │   ├── Dashboard.jsx
│   │   └── BookingPanel.jsx
│   └── styles/app.css
├── tests/                             ← 确定性回归测试
└── screenshots/                       ← 本 README 的展示图
```

---

## 12. 配置与密钥处理

本应用默认使用 Mapbox GL 的**公开** `pk.eyJ...` Token。公开 Mapbox Token 不含敏感作用域,可以安全地随客户端代码发布。如需替换为自己的:

```bash
cp .env.example .env
# 编辑:
VITE_MAPBOX_TOKEN=pk.your_public_token
VITE_MAPBOX_STYLE=mapbox://styles/your-account/your-style-id
```

构建期密钥扫描(由 `init.sh` 触发):

```bash
rg "sk\.ey" .   # 必须没有命中;敏感作用域 Token 永远不进仓库
```

---

## 13. 技术栈

- **React 19.2** + Hooks(`useEffect`、`useMemo`、`useRef`、`useCallback`、`useState`)
- **Vite 8** + `@vitejs/plugin-react`,提供 ESM 开发服务器与 Rollup 代码拆分
- **Mapbox GL JS 3.x**,栅格 + 矢量 + 符号图层 + 缩放插值样式
- **Recharts 3.x** 提供 `BarChart`、`LineChart` 与 `ResponsiveContainer`
- **Web Workers**(`type: 'module'`)实现仿真离主线程化
- **`node:test` + `assert/strict`** 组成零依赖回归套件
- **lucide-react** 图标
- **seedrandom / FNV-1a** 确定性伪随机
- **PapaParse**(传递依赖) —— `prepare-data.cjs` 中实际采用了手写 CSV 解析器,以保持数据管道**零外部依赖**

---

## 14. 发展规划

- [ ] 算法对比页:小规模 ILP / MILP 精确最优 vs. 生产启发式,左右对比上座率与营收。
- [ ] 场景导出/回放:把种子 + 需求曲线序列化为 JSON,任何环境下确定性回放。
- [ ] 权威时刻表注入:若获得官方逐站时刻表,可一键替换并撤掉 `simulatedStop` 标记。
- [ ] WebGPU compute shader 并行化整车队座位询价(目前每帧 O(列车数))。
- [ ] WebSocket 多端协同 demo:多浏览器对同一 Node.js Worker Pool 内的共享引擎并发订票。
- [ ] 国际化(i18n)整改:目前中英文混排在 UI 字符串中。

---

## 15. 免责声明与数据来源

本项目**并非中国国家铁路集团(国铁集团)或 12306 的官方产品**,不连接、不复制 12306 生产系统。它是从公开数据集出发的研究级仿真:

- **车站清单** —— `China-rail-way-stations-data-main`(社区维护的中国铁路车站 CSV,含 WGS-84 坐标)。
- **始发-终到记录** —— 同一数据集的 `line.csv`,包含真实 G/D/C 列车 OD 对,但**不含**逐站时刻表。中间停站由车站地理*仿真生成*,每个生成站点都打上 `simulatedStop: true` 标记。
- **铁路几何** —— [HOTOSM 中国铁路](https://data.humdata.org/dataset/hotosm_chn_railways)(LineString 与 Point GeoJSON),遵循 [Open Database License](https://www.openstreetmap.org/copyright)。

每条生成数据都带有 `provenance` 字段。仿真器**清晰标注**哪些数字是真实的(始发、终到、总里程)、哪些是启发式推导的(中间停站、区段距离、限速、停站时长)、哪些是随机化的(失约事件、天气拖延、调度松弛) —— 而所有随机性都封装在确定性种子伪随机数内,因此演示**完全可复现**。

---

## 16. 许可

[MIT](LICENSE) © 2026 Roger Lin

---

> 如果您是来自**蚂蚁集团、阿里巴巴、腾讯、百度、华为**(或其他公司)的招聘官或工程师,我非常乐意带您逐行讲解代码中的设计决策与权衡。可通过 [GitHub 主页](https://github.com/linroger) 联系。
