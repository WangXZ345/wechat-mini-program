# Tab Bar Icon Bounce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户切换四个底部导航项时，新选中的图标稳定播放一次约 320ms 的轻微回弹动画。

**Architecture:** 保留现有 `selected` 作为唯一导航选中状态，在 custom tabBar 组件中增加纯视图态 `bouncingIndex`。`setSelected()` 通过先清除、再设置该索引来重启动画；WXML 只给对应图标容器添加状态 class，WXSS 只变换其直接子图标，因此文字、背景胶囊和购物车角标均不移动。

**Tech Stack:** 微信小程序原生 Component、WXML、WXSS、CommonJS、Node.js `node:test`

## Global Constraints

- 仅修改 `miniprogram/custom-tab-bar/`，不修改云函数。
- 不修改 tab 路由、`wx.switchTab` 调用、购物车角标数据、权限可见性或页面生命周期。
- 动画总时长约 `320ms`，相对当前 active 位置向上移动约 `6rpx` 后柔和回落。
- 文字、选中背景胶囊和购物车角标不跟随图标跳动。
- 保留并扩展 `prefers-reduced-motion: reduce` 降级。
- 不新增运行时依赖，不上传云函数，不发布小程序。

---

### Task 1: 为选中图标增加可重复触发的轻微回弹

**Files:**
- Create: `miniprogram/custom-tab-bar/index.test.js`
- Modify: `miniprogram/custom-tab-bar/index.js`
- Modify: `miniprogram/custom-tab-bar/index.wxml`
- Modify: `miniprogram/custom-tab-bar/index.wxss`

**Interfaces:**
- Consumes: 现有 `setSelected(selected)` 公共组件方法，以及 WXML 循环中的 `index`。
- Produces: `data.bouncingIndex: number`，其中 `-1` 表示无动画；WXML class `is-bouncing`；WXSS keyframes `tab-icon-soft-bounce`。

- [ ] **Step 1: 写入失败的局部回归测试**

创建 `miniprogram/custom-tab-bar/index.test.js`：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

function loadComponentDefinition() {
  let definition = null;
  const originalComponent = global.Component;
  const originalLoad = Module._load;
  global.Component = (value) => { definition = value; };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/auth")) {
      return { getAdminProfile: () => Promise.resolve({}) };
    }
    if (request.endsWith("utils/orientation")) {
      return { initOrientation() {}, cleanupOrientation() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const file = require.resolve("./index.js");
    delete require.cache[file];
    require("./index.js");
  } finally {
    Module._load = originalLoad;
    global.Component = originalComponent;
  }
  return definition;
}

function createComponent(definition) {
  const component = {
    data: JSON.parse(JSON.stringify(definition.data)),
    ...definition.methods,
    setDataCalls: []
  };
  component.setData = function setData(patch, callback) {
    this.setDataCalls.push(patch);
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  component.refreshVisibility = () => {};
  return component;
}

const definition = loadComponentDefinition();
const wxml = fs.readFileSync(path.join(__dirname, "index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(__dirname, "index.wxss"), "utf8");

test("setSelected resets then reapplies the bounce index", () => {
  const component = createComponent(definition);
  component.setSelected(2);
  assert.deepEqual(component.setDataCalls.slice(0, 2), [
    { selected: 2, bouncingIndex: -1 },
    { bouncingIndex: 2 }
  ]);
  assert.equal(component.data.selected, 2);
  assert.equal(component.data.bouncingIndex, 2);
});

test("only the icon container receives the bounce class", () => {
  assert.match(wxml, /class="icon-wrap \{\{bouncingIndex === index \? 'is-bouncing' : ''\}\}"/);
  assert.match(wxss, /\.icon-wrap\.is-bouncing\s+>\s+\.tab-icon\s*\{[\s\S]*?animation:\s*tab-icon-soft-bounce\s+320ms/);
  assert.doesNotMatch(wxss, /\.icon-wrap\.is-bouncing\s*\{[\s\S]*?animation:/);
});

test("bounce ends at the active icon position and supports reduced motion", () => {
  assert.match(wxss, /@keyframes\s+tab-icon-soft-bounce[\s\S]*?100%\s*\{[\s\S]*?translateY\(-1rpx\)\s+scale\(1\)/);
  assert.match(wxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.icon-wrap\.is-bouncing\s+>\s+\.tab-icon/);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/custom-tab-bar/index.test.js
```

Expected: FAIL；第一项因 `bouncingIndex` 状态和两阶段 `setData` 尚不存在而失败，WXML/WXSS 两项因 `is-bouncing` 与 `tab-icon-soft-bounce` 尚不存在而失败。

- [ ] **Step 3: 添加最小动画状态和视图绑定**

在 `miniprogram/custom-tab-bar/index.js` 的 `data` 中增加：

```js
bouncingIndex: -1,
```

将 `setSelected` 改为：

```js
setSelected(selected) {
  const nextSelected = Number(selected || 0);
  this.setData({ selected: nextSelected, bouncingIndex: -1 }, () => {
    this.setData({ bouncingIndex: nextSelected });
  });
  this.refreshVisibility();
},
```

将 `miniprogram/custom-tab-bar/index.wxml` 的图标容器开始标签改为：

```xml
<view class="icon-wrap {{bouncingIndex === index ? 'is-bouncing' : ''}}">
```

- [ ] **Step 4: 添加轻微回弹关键帧与减少动态效果规则**

在 `miniprogram/custom-tab-bar/index.wxss` 的 active 图标规则后增加：

```css
.icon-wrap.is-bouncing > .tab-icon {
  transform-origin: center bottom;
  animation: tab-icon-soft-bounce 320ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes tab-icon-soft-bounce {
  0% {
    transform: translateY(-1rpx) scale(1);
  }
  38% {
    transform: translateY(-7rpx) scale(1.04, 0.96);
  }
  68% {
    transform: translateY(1rpx) scale(0.98, 1.02);
  }
  100% {
    transform: translateY(-1rpx) scale(1);
  }
}
```

并在现有 `@media (prefers-reduced-motion: reduce)` 动画禁用选择器列表中加入：

```css
.icon-wrap.is-bouncing > .tab-icon,
```

- [ ] **Step 5: 运行局部测试并确认通过**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/custom-tab-bar/index.test.js
```

Expected: 3 tests PASS，0 tests FAIL。

- [ ] **Step 6: 运行语法、配置和范围回归检查**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check miniprogram/custom-tab-bar/index.js
Get-Content -Raw -Encoding UTF8 miniprogram/app.json | ConvertFrom-Json | Out-Null
git diff --check
git diff -- miniprogram/custom-tab-bar/index.js miniprogram/custom-tab-bar/index.wxml miniprogram/custom-tab-bar/index.wxss miniprogram/custom-tab-bar/index.test.js
```

Expected: Node syntax check exit `0`；`app.json` 解析成功；`git diff --check` 无输出；diff 仅包含动画状态、绑定、样式和局部测试，不包含路由、角标、权限或云函数变化。

- [ ] **Step 7: 提交实现**

```powershell
git add -- miniprogram/custom-tab-bar/index.js miniprogram/custom-tab-bar/index.wxml miniprogram/custom-tab-bar/index.wxss miniprogram/custom-tab-bar/index.test.js
git commit -m "feat: animate selected tab icon"
```

Expected: 新提交仅包含上述四个 custom tabBar 文件。

## 手工验收

在微信开发者工具中重新编译后，依次切换“商品 → 购物车 → 订单 → 我的 → 商品”：每次只有新选中图标轻微上跳并回落，文字、胶囊和购物车角标保持静止，页面切换不等待动画。再开启系统减少动态效果进行复验，确认动画被禁用。
