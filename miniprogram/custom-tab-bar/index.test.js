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
