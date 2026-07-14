const ALLOWED_PUBLIC_TAGS = ["新货", "瑕疵", "热销"];
const PUBLIC_TAG_SET = new Set(ALLOWED_PUBLIC_TAGS);
const MAX_PUBLIC_TAGS = 4;
const MAX_INTERNAL_TAGS = 20;
const MAX_TAG_LENGTH = 10;
const MAX_HOME_ITEMS = 20;

const SECTION_DEFINITIONS = [
  {
    sectionKey: "new_arrivals",
    sectionTitle: "新货",
    subtitle: "最近上新商品",
    displayType: "horizontal",
    sourceType: "rule",
    ruleConfig: { isNew: true },
    fallbackTag: "新货",
    enabled: true,
    sortIndex: 1,
    maxItems: 8,
    showMore: true,
    flag: "isNew"
  },
  {
    sectionKey: "defective",
    sectionTitle: "瑕疵",
    subtitle: "包装或外观瑕疵商品",
    displayType: "horizontal",
    sourceType: "rule",
    ruleConfig: { isDefective: true },
    fallbackTag: "瑕疵",
    enabled: true,
    sortIndex: 2,
    maxItems: 8,
    showMore: true,
    flag: "isDefective"
  },
  {
    sectionKey: "hot_selling",
    sectionTitle: "热销推荐",
    subtitle: "近期下单较多商品",
    displayType: "horizontal",
    sourceType: "rule",
    ruleConfig: { isHot: true },
    fallbackTag: "热销",
    enabled: true,
    sortIndex: 3,
    maxItems: 8,
    showMore: true,
    flag: "isHot"
  },
  {
    sectionKey: "frequent_purchase",
    sectionTitle: "常购",
    subtitle: "你常买的商品",
    displayType: "horizontal",
    sourceType: "stats",
    ruleConfig: {},
    fallbackTag: "",
    enabled: true,
    sortIndex: 4,
    maxItems: 8,
    showMore: true,
    flag: ""
  }
];

const SECTION_BY_KEY = SECTION_DEFINITIONS.reduce((map, item) => {
  map[item.sectionKey] = item;
  return map;
}, {});

function uniqueClean(values = []) {
  const list = Array.isArray(values) ? values : String(values || "").split(/[,，、\s/;；|]+/);
  return Array.from(new Set(list.map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizePublicTags(values = []) {
  const tags = uniqueClean(values).filter((tag) => PUBLIC_TAG_SET.has(tag));
  if (tags.length > MAX_PUBLIC_TAGS) throw new Error("前台标签最多 4 个");
  tags.forEach((tag) => {
    if (tag.length > MAX_TAG_LENGTH) throw new Error("单个标签最多 10 个字");
  });
  return tags;
}

function validatePublicTags(values = []) {
  const raw = uniqueClean(values);
  const invalid = raw.filter((tag) => !PUBLIC_TAG_SET.has(tag));
  if (invalid.length) throw new Error(`前台标签包含非法值：${invalid.join("、")}`);
  return normalizePublicTags(raw);
}

function normalizeInternalTags(values = []) {
  const tags = uniqueClean(values);
  if (tags.length > MAX_INTERNAL_TAGS) throw new Error("内部标签最多 20 个");
  tags.forEach((tag) => {
    if (tag.length > MAX_TAG_LENGTH) throw new Error("单个标签最多 10 个字");
  });
  return tags;
}

function tagsFromFlags(input = {}, existingTags = []) {
  const tags = new Set(normalizePublicTags(existingTags));
  [
    ["isNew", "新货"],
    ["isDefective", "瑕疵"],
    ["isHot", "热销"]
  ].forEach(([flag, tag]) => {
    if (input[flag] === true) tags.add(tag);
    if (input[flag] === false) tags.delete(tag);
  });
  return Array.from(tags).slice(0, MAX_PUBLIC_TAGS);
}

function normalizeProductTagPayload(input = {}, before = {}) {
  const hasTags = Object.prototype.hasOwnProperty.call(input, "tags");
  const hasInternalTags = Object.prototype.hasOwnProperty.call(input, "internalTags");
  const flags = {
    isNew: input.isNew === undefined ? Boolean(before.isNew) : Boolean(input.isNew),
    isDefective: input.isDefective === undefined ? Boolean(before.isDefective) : Boolean(input.isDefective),
    isHot: input.isHot === undefined ? Boolean(before.isHot) : Boolean(input.isHot),
    isFrequent: false
  };
  const baseTags = hasTags ? validatePublicTags(input.tags) : normalizePublicTags(before.tags || []);
  const tags = tagsFromFlags(flags, baseTags);
  return {
    tags,
    internalTags: hasInternalTags ? normalizeInternalTags(input.internalTags) : normalizeInternalTags(before.internalTags || []),
    ...flags,
    defectDescription: String(input.defectDescription === undefined ? (before.defectDescription || "") : input.defectDescription || "").trim()
  };
}

function publicTagClass(tag = "") {
  return {
    "新货": "new",
    "瑕疵": "defective",
    "热销": "hot"
  }[tag] || "";
}

function decoratePublicProduct(item = {}, options = {}) {
  const tags = normalizePublicTags(item.tags || []);
  const product = {
    _id: item._id,
    id: item._id,
    productId: item._id,
    name: item.name || "",
    imageUrl: item.thumbnailUrl || item.imageUrl || "",
    brand: item.brand || "",
    category: item.category || "",
    specification: item.specification || "",
    productionDate: item.productionDate || "",
    price: Number(item.price || 0),
    tags,
    tagItems: tags.map((tag) => ({ name: tag, className: publicTagClass(tag) })),
    isNew: Boolean(item.isNew || tags.includes("新货")),
    isDefective: Boolean(item.isDefective || tags.includes("瑕疵")),
    isHot: Boolean(item.isHot || tags.includes("热销")),
    isFrequent: false
  };
  if (options.includeDescription) product.description = item.description || "";
  if (options.includeDefectDescription) product.defectDescription = item.defectDescription || "";
  return product;
}

function isVisibleProduct(item = {}) {
  return item
    && item.isDeleted !== true
    && item.isActive === true
    && item.status !== "deleted"
    && Number(item.price || 0) > 0;
}

function matchesSection(item = {}, sectionKey = "") {
  const section = SECTION_BY_KEY[sectionKey];
  if (!section) return false;
  const tags = normalizePublicTags(item.tags || []);
  return Boolean(item[section.flag]) || tags.includes(section.fallbackTag);
}

function normalizeSectionConfig(raw = {}) {
  const def = SECTION_BY_KEY[raw.sectionKey] || SECTION_BY_KEY[raw._id] || null;
  if (!def) return null;
  const maxItems = Math.min(MAX_HOME_ITEMS, Math.max(1, parseInt(raw.maxItems, 10) || def.maxItems));
  const isFrequentSection = def.sectionKey === "frequent_purchase";
  return {
    ...def,
    ...raw,
    sectionKey: def.sectionKey,
    sourceType: isFrequentSection ? def.sourceType : (raw.sourceType || def.sourceType),
    ruleConfig: isFrequentSection ? def.ruleConfig : (raw.ruleConfig || def.ruleConfig),
    fallbackTag: def.fallbackTag,
    flag: def.flag,
    displayType: raw.displayType === "grid" ? "grid" : "horizontal",
    enabled: raw.enabled !== false,
    sortIndex: Number(raw.sortIndex || def.sortIndex),
    maxItems,
    showMore: raw.showMore !== false
  };
}

function safeProductLogSnapshot(product = {}) {
  return {
    tags: normalizePublicTags(product.tags || []),
    internalTags: normalizeInternalTags(product.internalTags || []),
    flags: {
      isNew: Boolean(product.isNew),
      isDefective: Boolean(product.isDefective),
      isHot: Boolean(product.isHot),
      isFrequent: Boolean(product.isFrequent)
    },
    defectDescription: product.defectDescription || ""
  };
}

module.exports = {
  ALLOWED_PUBLIC_TAGS,
  SECTION_DEFINITIONS,
  SECTION_BY_KEY,
  MAX_HOME_ITEMS,
  normalizePublicTags,
  validatePublicTags,
  normalizeInternalTags,
  normalizeProductTagPayload,
  decoratePublicProduct,
  isVisibleProduct,
  matchesSection,
  normalizeSectionConfig,
  safeProductLogSnapshot,
  publicTagClass,
  uniqueClean
};
