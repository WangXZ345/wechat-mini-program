# 后台工作台顶部与商品首页视觉统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将小程序后台工作台截图所示顶部区域改成商品首页的暖米白、白色实体控件和深棕选中态，同时保持全部数据、权限和筛选行为不变。

**Architecture:** 这是一个局部表现层改动。WXML 只调整顶部更新时间的语义类名，WXSS 只替换 `workbench-hero` 到时间范围控件的样式块；页面 JS、JSON、云函数和后续数据区块保持不动。

**Tech Stack:** 微信小程序原生 WXML/WXSS、PowerShell 静态断言、bundled Node.js 语法检查。

## Global Constraints

- 仅修改 `miniprogram/pages/admin/dashboard/index.wxml` 和 `miniprogram/pages/admin/dashboard/index.wxss`。
- 页面主色保持 `#B99C74`，选中态使用现有深棕动作色 `#806448`，背景使用 `#F8F4ED`，实体表面使用 `#FFFDF9`。
- 保留 `adminProfile.roleName`、`updatedAt`、`rangeOptions`、`rangeIndex`、`onRangeChipTap` 和 `onRangeChange`。
- 不修改云函数、权限、字段、集合、后台入口、订单、库存、付款或账款逻辑。
- 不上传云函数，不发布小程序。
- 当前目录不是 Git 仓库，实施过程中不执行 commit；用变更文件清单和验证输出代替提交记录。

---

### Task 1: 统一后台工作台顶部视觉

**Files:**
- Modify: `miniprogram/pages/admin/dashboard/index.wxml:2-24`
- Modify: `miniprogram/pages/admin/dashboard/index.wxss:399-532`
- Test: PowerShell 静态断言与 bundled Node.js 回归检查

**Interfaces:**
- Consumes: `adminProfile.roleName: string`、`updatedAt: string`、`rangeOptions: Array<{label: string, value: string}>`、`rangeIndex: number`。
- Produces: 与首页一致的暖米白顶部、白色角色卡、次级更新时间文本和深棕选中态时间分段栏；不产生新的数据或事件接口。

- [ ] **Step 1: 运行改前静态断言并确认失败**

```powershell
$wxml = Get-Content -Raw -Encoding UTF8 'miniprogram/pages/admin/dashboard/index.wxml'
$wxss = Get-Content -Raw -Encoding UTF8 'miniprogram/pages/admin/dashboard/index.wxss'
if ($wxml -notmatch 'class="hero-update"') { throw 'EXPECTED FAIL: hero-update 尚未实现' }
if ($wxss -match 'linear-gradient\(145deg, #F3E7D6') { throw 'EXPECTED FAIL: 旧渐变 Hero 仍存在' }
```

Expected: FAIL，至少报告 `hero-update 尚未实现`。

- [ ] **Step 2: 调整顶部更新时间结构**

将 `miniprogram/pages/admin/dashboard/index.wxml` 中的 `hero-meta` 改为：

```xml
    <view class="hero-meta">
      <view class="hero-update">更新：{{updatedAt || "暂无"}}</view>
    </view>
```

角色名称继续由顶部的 `hero-role` 渲染，避免同一角色信息重复出现；角色数据源与权限逻辑不变。

- [ ] **Step 3: 用首页风格替换 Hero 与时间范围样式**

将 `miniprogram/pages/admin/dashboard/index.wxss` 的 `.workbench-hero` 至 `.range-picker:active` 样式替换为：

```css
.workbench-hero {
  margin: 0 0 30rpx;
  padding: 20rpx 0 0;
  background: transparent;
  box-shadow: none;
  box-sizing: border-box;
}

.hero-topline,
.hero-meta,
.section-head,
.metric-top,
.menu-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.hero-kicker {
  color: var(--color-text-secondary, #82776B);
  font-size: 24rpx;
  font-weight: 700;
}

.hero-role {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 64rpx;
  padding: 0 22rpx;
  border: 1rpx solid rgba(185, 156, 116, 0.28);
  border-radius: 20rpx;
  background: var(--color-card, #FFFDF9);
  color: var(--color-text-main, #1F1A15);
  box-shadow: 0 6rpx 18rpx rgba(117, 89, 58, 0.06);
  font-size: 22rpx;
  font-weight: 700;
}

.workbench-title {
  margin-top: 16rpx;
  color: var(--color-text-main, #1F1A15);
  font-size: 52rpx;
  font-weight: 800;
  line-height: 1.16;
  letter-spacing: 0;
}

.hero-subtitle {
  max-width: 620rpx;
  margin-top: 10rpx;
  color: var(--color-text-secondary, #82776B);
  font-size: 26rpx;
  line-height: 1.45;
}

.hero-meta {
  justify-content: flex-start;
  margin-top: 14rpx;
}

.hero-update {
  color: var(--color-text-muted, #A79B8B);
  font-size: 22rpx;
  line-height: 32rpx;
  font-variant-numeric: tabular-nums;
}

.range-panel {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-top: 24rpx;
  padding: 4rpx;
  border: 1rpx solid rgba(185, 156, 116, 0.24);
  border-radius: 999rpx;
  background: var(--color-card, #FFFDF9);
  box-shadow: 0 8rpx 22rpx rgba(117, 89, 58, 0.07);
  box-sizing: border-box;
}

.range-label {
  flex-shrink: 0;
  padding-left: 18rpx;
  color: var(--color-text-secondary, #82776B);
  font-size: 23rpx;
  font-weight: 700;
}

.range-scroll {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}

.range-chip-row {
  display: flex;
  align-items: center;
  gap: 4rpx;
}

.range-chip {
  flex-shrink: 0;
  min-height: 64rpx;
  line-height: 64rpx;
  padding: 0 22rpx;
  border: 0;
  border-radius: 999rpx;
  background: transparent;
  color: var(--color-text-secondary, #82776B);
  font-size: 24rpx;
  font-weight: 700;
  box-sizing: border-box;
  transition: background-color var(--motion-press, 120ms) var(--motion-ease-out, ease-out), color var(--motion-press, 120ms) var(--motion-ease-out, ease-out), transform var(--motion-press, 120ms) var(--motion-ease-out, ease-out);
}

.range-chip.is-active {
  background: #806448;
  color: var(--color-action-text, #FFFDF9);
  font-weight: 800;
  box-shadow: 0 6rpx 16rpx rgba(117, 89, 58, 0.18), inset 0 1rpx 0 rgba(255, 255, 255, 0.28);
}

.range-picker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 64rpx;
  padding: 0 20rpx;
  border-radius: 999rpx;
  background: var(--color-card-warm, #FCF7EF);
  color: var(--color-text-secondary, #82776B);
  font-size: 22rpx;
  font-weight: 700;
}

.range-chip:active,
.range-picker:active,
.menu-tile:active {
  opacity: 0.82;
  transform: scale(0.98);
}
```

- [ ] **Step 4: 运行目标静态断言并确认通过**

```powershell
$wxml = Get-Content -Raw -Encoding UTF8 'miniprogram/pages/admin/dashboard/index.wxml'
$wxss = Get-Content -Raw -Encoding UTF8 'miniprogram/pages/admin/dashboard/index.wxss'
$required = @(
  'class="hero-update"',
  'adminProfile.roleName',
  'updatedAt',
  'rangeOptions',
  'onRangeChipTap',
  'onRangeChange'
)
foreach ($item in $required) {
  if ($wxml -notmatch [regex]::Escape($item)) { throw "缺少必要结构或绑定: $item" }
}
if ($wxss -match 'linear-gradient\(145deg, #F3E7D6') { throw '旧渐变 Hero 未移除' }
if ($wxss -notmatch '\.workbench-title[\s\S]*font-size: 52rpx') { throw '标题字号未统一' }
if ($wxss -notmatch '\.range-chip\.is-active[\s\S]*background: #806448') { throw '时间选中态未统一' }
'顶部 UI 静态断言通过'
```

Expected: `顶部 UI 静态断言通过`。

- [ ] **Step 5: 运行语法、JSON 和 UTF-8 回归检查**

```powershell
$node = 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --check 'miniprogram/pages/admin/dashboard/index.js'
Get-Content -Raw -Encoding UTF8 'miniprogram/pages/admin/dashboard/index.json' | ConvertFrom-Json | Out-Null
$files = @(
  'miniprogram/pages/admin/dashboard/index.wxml',
  'miniprogram/pages/admin/dashboard/index.wxss'
)
foreach ($file in $files) {
  $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes((Resolve-Path $file)))
  if ($text.Contains([char]0xFFFD)) { throw "发现 UTF-8 替换字符: $file" }
}
'JS、JSON 与 UTF-8 回归检查通过'
```

Expected: Node.js 无语法错误，最后输出 `JS、JSON 与 UTF-8 回归检查通过`。

- [ ] **Step 6: 微信开发者工具手工验收**

在微信开发者工具中重新编译，使用有 `dashboard:view_basic` 权限的后台账号检查：

1. 顶部为暖米白平铺布局，不再显示棕色渐变 Hero。
2. “工作台”标题尺寸与商品首页“商品”接近，角色显示为右侧白色实体卡。
3. 更新时间可见，日期数字不跳动错位。
4. 今日、近 3 日、近 7 日、近 30 日和“切换”均可操作；选中项为深棕底暖白字。
5. 切换时间后概览数据正常刷新，错误态和重试仍正常。
6. 竖屏无横向溢出；横屏和宽屏仍能完整显示顶部与后续数据区块。

Expected: 所有检查通过；本地无法替代微信运行时与真实后台数据验证时，在交付中明确标注未验证项。

---

## Plan Self-Review

- Spec coverage: 页面基底、标题、角色、更新时间、时间分段控件、交互、响应式、权限与部署边界均有对应步骤。
- Placeholder scan: 所有实现和验证步骤均已写明，无占位内容或模糊测试步骤。
- Interface consistency: WXML 使用的字段和事件均为现有 `index.js` 接口，没有新增方法或字段。
