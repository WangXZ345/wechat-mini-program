const { normalizeForMatch, extractBrand, inferCategory } = require("./productNormalize");

const MAX_FUZZY_SCAN_CELLS = 80000;
const MAX_PRICE_ONLY_PREVIEW = 200;

function compactKey(value = "") {
  return normalizeForMatch(value).replace(/\s+/g, "").toLowerCase();
}

function indexValue(row = {}) {
  return compactKey(row.productIndex || row.skuCode || "");
}

function exactKey(row = {}) {
  return [compactKey(row.baseName || row.finalName), compactKey(row.specification), String(row.productionDate || "")].join("|");
}

function nameSpecKey(row = {}) {
  return [compactKey(row.baseName || row.finalName), compactKey(row.specification)].join("|");
}

function overlapCount(a, b) {
  const map = new Map();
  a.forEach((item) => map.set(item, (map.get(item) || 0) + 1));
  let count = 0;
  b.forEach((item) => {
    const current = map.get(item) || 0;
    if (current > 0) {
      count += 1;
      map.set(item, current - 1);
    }
  });
  return count;
}

function bigrams(value = "") {
  const chars = String(value || "");
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars.slice(i, i + 2));
  return result;
}

function similarity(a, b) {
  const aa = compactKey(a);
  const bb = compactKey(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const short = aa.length <= bb.length ? aa : bb;
  const long = aa.length > bb.length ? aa : bb;
  if (long.includes(short)) return Math.min(0.98, short.length / long.length + 0.16);
  const charScore = (2 * overlapCount(aa.split(""), bb.split(""))) / (aa.length + bb.length);
  const aBi = bigrams(aa);
  const bBi = bigrams(bb);
  const biScore = aBi.length && bBi.length ? (2 * overlapCount(aBi, bBi)) / (aBi.length + bBi.length) : 0;
  return (0.68 * charScore) + (0.32 * biScore);
}

function takeFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function mergeItem(inventory, price, matchLevel, warningMessage = "") {
  const finalName = takeFirst(inventory.finalName, price && price.finalName);
  const mergedWarning = [inventory.warningMessage, price && price.warningMessage, warningMessage].filter(Boolean).join("；");
  const missingPrice = !price || !Number.isInteger(price.price);
  let action = "create";
  let selected = true;
  let errorMessage = inventory.errorMessage || "";
  if (missingPrice) {
    action = "error";
    selected = false;
    errorMessage = errorMessage || "未在报价表找到价格";
  }
  if (matchLevel === "fuzzy") {
    action = missingPrice ? "error" : "create";
    selected = false;
  }
  if (errorMessage) {
    action = "error";
    selected = false;
  }
  return {
    selected,
    action,
    matchLevel,
    sourceRowNo: inventory.sourceRowNo,
    priceSourceRowNo: price ? price.sourceRowNo : null,
    rawInventoryName: inventory.rawInventoryName || "",
    rawPriceName: price ? price.rawPriceName || "" : "",
    finalName,
    baseName: finalName,
    brand: takeFirst(inventory.brand, price && price.brand, extractBrand(finalName)),
    category: takeFirst(inventory.category, price && price.category, inferCategory(finalName)),
    specification: takeFirst(inventory.specification, price && price.specification),
    productionDate: takeFirst(inventory.productionDate, price && price.productionDate),
    stock: inventory.stock,
    price: price ? price.price : null,
    originalPrice: price ? price.originalPrice : null,
    productIndex: takeFirst(inventory.productIndex, price && price.productIndex),
    skuCode: takeFirst(inventory.skuCode, price && price.skuCode),
    matchedProductId: "",
    matchedProductName: "",
    candidates: [],
    errorMessage,
    warningMessage: mergedWarning
  };
}

function mergeInventoryAndPriceRows(inventoryRows = [], priceRows = []) {
  const usedPrice = new Set();
  const priceByIndex = new Map();
  const priceByExact = new Map();
  const priceByNameSpec = new Map();
  const priceBySpec = new Map();
  priceRows.forEach((row, index) => {
    const idx = indexValue(row);
    if (idx) priceByIndex.set(idx, { row, index });
    const exact = exactKey(row);
    if (!priceByExact.has(exact)) priceByExact.set(exact, []);
    priceByExact.get(exact).push({ row, index });
    const spec = nameSpecKey(row);
    if (!priceByNameSpec.has(spec)) priceByNameSpec.set(spec, []);
    priceByNameSpec.get(spec).push({ row, index });
    const specOnly = compactKey(row.specification);
    if (specOnly) {
      if (!priceBySpec.has(specOnly)) priceBySpec.set(specOnly, []);
      priceBySpec.get(specOnly).push({ row, index });
    }
  });
  const allowFullFuzzyScan = inventoryRows.length * priceRows.length <= MAX_FUZZY_SCAN_CELLS;

  const items = inventoryRows.map((inventory) => {
    const idx = indexValue(inventory);
    if (idx && priceByIndex.has(idx)) {
      const found = priceByIndex.get(idx);
      usedPrice.add(found.index);
      return mergeItem(inventory, found.row, "index");
    }

    const exactMatches = priceByExact.get(exactKey(inventory)) || [];
    const exact = exactMatches.find((entry) => !usedPrice.has(entry.index));
    if (exact) {
      usedPrice.add(exact.index);
      return mergeItem(inventory, exact.row, "exact");
    }

    const specMatches = priceByNameSpec.get(nameSpecKey(inventory)) || [];
    const sameSpec = specMatches.find((entry) => !usedPrice.has(entry.index));
    if (sameSpec) {
      usedPrice.add(sameSpec.index);
      return mergeItem(
        inventory,
        sameSpec.row,
        "sameNameSpec",
        "报价表无生产日期或生产日期不一致，请确认是否同一商品"
      );
    }

    const inventorySpec = compactKey(inventory.specification);
    const fuzzySource = allowFullFuzzyScan
      ? priceRows.map((price, index) => ({ row: price, index }))
      : (inventorySpec ? (priceBySpec.get(inventorySpec) || []) : []);
    const fuzzy = fuzzySource
      .filter((entry) => !usedPrice.has(entry.index))
      .map((entry) => ({
        price: entry.row,
        index: entry.index,
        score: similarity(`${inventory.baseName} ${inventory.specification}`, `${entry.row.baseName} ${entry.row.specification}`)
      }))
      .filter((entry) => entry.score >= 0.8)
      .sort((a, b) => b.score - a.score)[0];
    if (fuzzy) {
      usedPrice.add(fuzzy.index);
      return mergeItem(inventory, fuzzy.price, "fuzzy", "模糊匹配需人工确认，系统不会默认选中导入");
    }

    return mergeItem(inventory, null, "none", "未在报价表找到价格");
  });

  let skippedPriceOnlyRows = 0;
  priceRows.forEach((price, index) => {
    if (usedPrice.has(index)) return;
    if (skippedPriceOnlyRows >= MAX_PRICE_ONLY_PREVIEW) {
      skippedPriceOnlyRows += 1;
      return;
    }
    skippedPriceOnlyRows += 1;
    items.push({
      selected: false,
      action: "ignore",
      matchLevel: "none",
      sourceRowNo: null,
      priceSourceRowNo: price.sourceRowNo,
      rawInventoryName: "",
      rawPriceName: price.rawPriceName,
      finalName: price.finalName,
      baseName: price.finalName,
      brand: price.brand,
      category: price.category,
      specification: price.specification,
      productionDate: price.productionDate,
      stock: null,
      price: price.price,
      originalPrice: price.originalPrice,
      productIndex: price.productIndex,
      skuCode: price.skuCode,
      matchedProductId: "",
      matchedProductName: "",
      candidates: [],
      errorMessage: "",
      warningMessage: "报价表未匹配库存，默认忽略"
    });
  });

  if (skippedPriceOnlyRows > MAX_PRICE_ONLY_PREVIEW) {
    const omittedCount = skippedPriceOnlyRows - MAX_PRICE_ONLY_PREVIEW;
    items.push({
      selected: false,
      action: "ignore",
      matchLevel: "none",
      sourceRowNo: null,
      priceSourceRowNo: null,
      rawInventoryName: "",
      rawPriceName: "",
      finalName: `报价表未匹配库存的行还有 ${omittedCount} 行`,
      baseName: `报价表未匹配库存的行还有 ${omittedCount} 行`,
      brand: "",
      category: "",
      specification: "",
      productionDate: "",
      stock: null,
      price: null,
      originalPrice: null,
      productIndex: "",
      skuCode: "",
      matchedProductId: "",
      matchedProductName: "",
      candidates: [],
      errorMessage: "",
      warningMessage: "为避免预览过大，仅展示前 200 行报价表未匹配库存数据"
    });
  }

  return items;
}

module.exports = { mergeInventoryAndPriceRows };
