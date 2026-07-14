const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wxss = fs.readFileSync(path.join(__dirname, "list.wxss"), "utf8");
const bottomAction = wxss.match(/\.bottom-action\s*\{([\s\S]*?)\}/);

assert.ok(bottomAction, "应保留底部新增地址操作区");
assert.match(bottomAction[1], /position:\s*fixed/);
assert.match(bottomAction[1], /env\(safe-area-inset-bottom\)/);
assert.doesNotMatch(bottomAction[1], /background\s*:/, "底部操作区不应再绘制白色胶囊背景");
assert.doesNotMatch(bottomAction[1], /border\s*:/, "底部操作区不应再绘制胶囊边框");
assert.doesNotMatch(bottomAction[1], /box-shadow\s*:/, "底部操作区不应与按钮叠加阴影");

console.log("address list bottom action styles: ok");
