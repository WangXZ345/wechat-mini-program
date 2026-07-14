const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const { call, moneyText, toast } = require("../../utils/api");
const { ensureAdmin } = require("../../utils/auth");
const { normalizeSearchText } = require("../../utils/searchNormalize");
const { generateIdempotencyKey } = require("../../utils/idempotency");
const { buildStatusSnapshot } = require("../../utils/productStatusSnapshot");
const haptics = require("../../utils/haptics");

const BATCH_SIZE = 100;
const PAGE_SIZE = 50;
const PUBLIC_TAG_NAMES = ["新货", "瑕疵", "热销"];
const STOCK_STATUS_TEXT = {
  normal: "库存正常",
  warning: "库存预警",
  out_of_stock: "已缺货"
};

function emptyForm() {
  return {
    _id: "",
    name: "",
    baseName: "",
    imageUrl: "",
    specification: "",
    price: "",
    productionDate: "",
    stock: "",
    warningStock: 10,
    autoHideWhenOutOfStock: false,
    description: "",
    productIndex: "",
    skuCode: "",
    keywordsText: "",
    isActive: true,
    tags: [],
    internalTags: [],
    internalTagsText: "",
    isNew: false,
    isDefective: false,
    isHot: false,
    defectDescription: ""
  };
}

function splitBatches(items) {
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

function buildTagOptions(tags = []) {
  const selected = new Set(Array.isArray(tags) ? tags : []);
  return PUBLIC_TAG_NAMES.map((name) => ({ name, checked: selected.has(name) }));
}

function buildTagFlags(tags = []) {
  const selected = new Set(Array.isArray(tags) ? tags : []);
  return {
    isNew: selected.has("新货"),
    isDefective: selected.has("瑕疵"),
    isHot: selected.has("热销")
  };
}

function buildFormTags(product = {}) {
  const tags = new Set(Array.isArray(product.tags) ? product.tags.filter((tag) => PUBLIC_TAG_NAMES.includes(tag)) : []);
  if (product.isNew) tags.add("新货");
  if (product.isDefective) tags.add("瑕疵");
  if (product.isHot) tags.add("热销");
  return Array.from(tags);
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    products: [],
    selectedIds: [],
    allSelected: false,
    activating: false,
    selectingAll: false,
    indexGenerating: false,
    loading: false,
    initialized: false,
    loadingMore: false,
    keyword: "",
    normalizedKeyword: "",
    page: 1,
    hasMore: false,
    total: 0,
    batchType: "set",
    batchValue: "",
    batchReason: "",
    stockStatusFilter: "all",
    batchWarningStock: "",
    batchAutoHideWhenOutOfStock: false,
    tagOptions: buildTagOptions(),
    tagFilter: "all",
    specialFilter: "all",
    defectDescriptionFilter: "all",
    internalTagFilter: "",
    batchInternalTag: "",
    form: emptyForm(),
    showForm: false
  },

  onLoad(options = {}) {
    this.productRequestVersion = 0;
    this.productRequestId = 0;
    this.activeProductRequest = null;
    this.pendingProductReset = null;
    this.productLoading = null;
    this.productResetPromise = null;
    this.resolveProductReset = null;
    this.selectedProductSnapshots = new Map();
    this.productSelectionRequestId = 0;
    this.bulkActivateAttempt = null;
    initOrientation(this);
    const nextData = {};
    if (options.stock && ["normal", "warning", "out_of_stock"].includes(options.stock)) {
      nextData.stockStatusFilter = options.stock;
    }
    if (options.filter === "expiring") nextData.specialFilter = "expiring";
    if (options.tag && ["new", "defective", "hot"].includes(options.tag)) {
      nextData.tagFilter = options.tag;
    }
    if (options.action === "create") {
      nextData.form = emptyForm();
      nextData.tagOptions = buildTagOptions();
      nextData.showForm = true;
    }
    if (Object.keys(nextData).length) this.setData(nextData);

    ensureAdmin("product:view").then(() => {
      if (options.action === "create" && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      return this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  load(options = {}) {
    const reset = options.reset !== false;
    if (reset) {
      this.productRequestVersion = Number(this.productRequestVersion || 0) + 1;
      this.pendingProductReset = {
        version: this.productRequestVersion,
        silent: Boolean(options.silent)
      };
      const resetTask = this.ensureProductResetPromise();
      this.drainProductResetQueue();
      return resetTask;
    }

    if (this.productLoading || this.pendingProductReset || this.data.loading || this.data.loadingMore) {
      return Promise.resolve();
    }
    if (!this.data.hasMore) return Promise.resolve();
    return this.startProductRequest({
      reset: false,
      version: Number(this.productRequestVersion || 0),
      silent: Boolean(options.silent)
    });
  },

  ensureProductResetPromise() {
    if (!this.productResetPromise) {
      this.productResetPromise = new Promise((resolve) => {
        this.resolveProductReset = resolve;
      });
    }
    return this.productResetPromise;
  },

  drainProductResetQueue() {
    if (this.productLoading || !this.pendingProductReset) return;
    const pendingReset = this.pendingProductReset;
    this.pendingProductReset = null;
    this.startProductRequest({
      reset: true,
      version: pendingReset.version,
      silent: pendingReset.silent
    });
  },

  buildProductRequestParams() {
    return {
      keyword: this.data.normalizedKeyword || this.data.keyword,
      filters: this.buildFilters()
    };
  },

  buildProductRequestScope(params = this.buildProductRequestParams()) {
    return JSON.stringify(params);
  },

  invalidateProductSelectionRequest() {
    this.productSelectionRequestId = Number(this.productSelectionRequestId || 0) + 1;
  },

  isProductSelectionRequestCurrent(request) {
    return request.id === Number(this.productSelectionRequestId || 0)
      && request.scope === this.buildProductRequestScope();
  },

  isProductRequestCurrent(request) {
    return request.version === Number(this.productRequestVersion || 0)
      && request.scope === this.buildProductRequestScope();
  },

  startProductRequest(options) {
    const reset = options.reset;
    const page = reset ? 1 : this.data.page + 1;
    const params = this.buildProductRequestParams();
    const request = {
      id: Number(this.productRequestId || 0) + 1,
      version: options.version,
      scope: this.buildProductRequestScope(params),
      reset,
      page
    };
    this.productRequestId = request.id;
    this.activeProductRequest = request;
    this.setData(reset
      ? { loading: !options.silent, loadingMore: false }
      : { loadingMore: true });

    const task = Promise.resolve().then(() => call("adminSearchProducts", {
      keyword: params.keyword,
      page,
      pageSize: PAGE_SIZE,
      filters: params.filters
    }, { showLoading: false })).then((data) => {
      if (!this.isProductRequestCurrent(request)) return;
      const selectedSet = new Set(this.data.selectedIds);
      const nextProducts = (data.products || []).map((item) => ({
        ...item,
        priceText: moneyText(item.price),
        tagsText: (item.tags || []).join("、"),
        internalTagsText: (item.internalTags || []).join("、"),
        defectDescriptionStatus: item.defectDescription ? "有瑕疵说明" : "无瑕疵说明",
        stockStatusText: STOCK_STATUS_TEXT[item.stockStatus] || "库存正常",
        newPrice: "",
        checked: selectedSet.has(item._id)
      }));
      nextProducts.forEach((product) => {
        if (!selectedSet.has(product._id)) return;
        const snapshot = buildStatusSnapshot(product);
        if (snapshot) this.selectedProductSnapshots.set(snapshot.id, snapshot);
        else this.selectedProductSnapshots.delete(product._id);
      });
      const products = reset ? nextProducts : this.data.products.concat(nextProducts);
      const selectedIds = Array.from(selectedSet);
      const state = {
        products,
        selectedIds,
        page,
        total: Number(data.total || products.length),
        hasMore: Boolean(data.hasMore),
        allSelected: Number(data.total || products.length) > 0 && selectedIds.length >= Number(data.total || products.length),
        initialized: true
      };
      this.setData(state);
    }).catch((err) => {
      if (this.isProductRequestCurrent(request)) toast(err.message);
    });
    const settledTask = task.finally(() => this.finishProductRequest(request));
    this.productLoading = settledTask;
    return settledTask;
  },

  finishProductRequest(request) {
    if (!this.activeProductRequest || this.activeProductRequest.id !== request.id) return;
    this.activeProductRequest = null;
    this.productLoading = null;
    this.setData({ loading: false, loadingMore: false });
    if (this.pendingProductReset) {
      this.drainProductResetQueue();
      return;
    }
    if (!this.resolveProductReset) return;
    const resolve = this.resolveProductReset;
    this.resolveProductReset = null;
    this.productResetPromise = null;
    resolve();
  },

  buildFilters() {
    const filters = this.data.stockStatusFilter === "all" ? {} : { stockStatus: this.data.stockStatusFilter };
    const tagMap = {
      new: "isNew",
      defective: "isDefective",
      hot: "isHot"
    };
    if (tagMap[this.data.tagFilter]) filters[tagMap[this.data.tagFilter]] = true;
    if (this.data.specialFilter === "expiring") filters.expiring = true;
    if (this.data.defectDescriptionFilter !== "all") filters.defectDescription = this.data.defectDescriptionFilter;
    if (this.data.internalTagFilter) filters.internalTag = this.data.internalTagFilter;
    return filters;
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onActiveChange(e) {
    this.setData({ "form.isActive": e.detail.value });
  },

  onAutoHideChange(e) {
    this.setData({ "form.autoHideWhenOutOfStock": e.detail.value });
  },

  onFormTagsChange(e) {
    const tags = e.detail.value;
    const tagFlags = buildTagFlags(tags);
    this.setData({
      "form.tags": tags,
      "form.isNew": tagFlags.isNew,
      "form.isDefective": tagFlags.isDefective,
      "form.isHot": tagFlags.isHot,
      tagOptions: buildTagOptions(tags)
    });
  },

  onBatchAutoHideChange(e) {
    this.setData({ batchAutoHideWhenOutOfStock: e.detail.value });
  },

  onStockStatusFilterChange(e) {
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({ stockStatusFilter: e.currentTarget.dataset.status, selectedIds: [], allSelected: false, selectingAll: false }, () => this.load({ reset: true }));
  },

  onTagFilterChange(e) {
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({ tagFilter: e.currentTarget.dataset.tag, selectedIds: [], allSelected: false, selectingAll: false }, () => this.load({ reset: true }));
  },

  onSpecialFilterChange(e) {
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({ specialFilter: e.currentTarget.dataset.filter, selectedIds: [], allSelected: false, selectingAll: false }, () => this.load({ reset: true }));
  },

  onDefectFilterChange(e) {
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({ defectDescriptionFilter: e.currentTarget.dataset.value, selectedIds: [], allSelected: false, selectingAll: false }, () => this.load({ reset: true }));
  },

  onSearchInput(e) {
    const keyword = e.detail.value;
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({
      keyword,
      normalizedKeyword: normalizeSearchText(keyword),
      selectedIds: [],
      allSelected: false,
      selectingAll: false
    });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load({ reset: true }), 300);
  },

  searchNow() {
    clearTimeout(this.searchTimer);
    this.load({ reset: true });
  },

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({ keyword: "", normalizedKeyword: "", selectedIds: [], allSelected: false, selectingAll: false }, () => this.load({ reset: true }));
  },

  newProduct() {
    haptics.selection();
    this.productEditBaselineStock = undefined;
    this.setData({ form: emptyForm(), tagOptions: buildTagOptions(), showForm: true });
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  editProduct(e) {
    const product = this.data.products.find((item) => item._id === e.currentTarget.dataset.id);
    if (!product) return;
    haptics.selection();
    this.productEditBaselineStock = Number.isSafeInteger(product.stock) && product.stock >= 0
      ? product.stock
      : undefined;
    const tags = buildFormTags(product);
    const tagFlags = buildTagFlags(tags);
    this.setData({
      form: {
        ...product,
        warningStock: product.warningStock === undefined ? 10 : product.warningStock,
        autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true,
        keywordsText: Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "",
        tags,
        internalTags: Array.isArray(product.internalTags) ? product.internalTags : [],
        internalTagsText: Array.isArray(product.internalTags) ? product.internalTags.join(" ") : "",
        ...tagFlags,
        defectDescription: product.defectDescription || ""
      },
      tagOptions: buildTagOptions(tags),
      showForm: true
    });
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  saveProduct() {
    haptics.medium();
    const action = this.data.form._id ? "update" : "create";
    const internalTags = String(this.data.form.internalTagsText || "")
      .split(/[,，、\s\/;；|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const tags = Array.isArray(this.data.form.tags) ? this.data.form.tags.filter((tag) => PUBLIC_TAG_NAMES.includes(tag)) : [];
    const tagFlags = buildTagFlags(tags);
    const productPayload = {
      ...this.data.form,
      tags,
      ...tagFlags,
      isFrequent: false,
      internalTags,
      warningStock: this.data.form.warningStock,
      autoHideWhenOutOfStock: this.data.form.autoHideWhenOutOfStock,
      keywords: this.data.form.keywordsText
    };
    const expectedVersion = action === "update"
      && Number.isSafeInteger(this.data.form.version)
      && this.data.form.version >= 0
      ? this.data.form.version
      : undefined;
    const expectedStock = action === "update" ? this.productEditBaselineStock : undefined;
    const attemptFingerprint = JSON.stringify({
      action,
      productId: this.data.form._id || "",
      expectedVersion,
      expectedStock,
      product: productPayload
    });
    if (!this.productSaveAttempt || this.productSaveAttempt.fingerprint !== attemptFingerprint) {
      this.productSaveAttempt = {
        fingerprint: attemptFingerprint,
        idempotencyKey: generateIdempotencyKey(`product_${action}`)
      };
    }
    return call("manageProduct", {
      action,
      productId: this.data.form._id,
      product: productPayload,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(expectedStock === undefined ? {} : { expectedStock }),
      idempotencyKey: this.productSaveAttempt.idempotencyKey
    }).then(() => {
      const warning = tagFlags.isDefective && !String(this.data.form.defectDescription || "").trim()
        ? "该商品已标记为瑕疵，建议填写瑕疵说明。"
        : "";
      toast(warning || "已保存");
      this.productSaveAttempt = null;
      this.productEditBaselineStock = undefined;
      this.setData({ form: emptyForm(), showForm: false });
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  deleteProduct(e) {
    const productId = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item._id === productId);
    if (!product) {
      toast("商品已变化，请刷新后重试");
      return;
    }
    call("manageProduct", {
      action: "delete",
      productId,
      expectedIsActive: product.isActive !== false,
      expectedVersion: Number.isSafeInteger(product.version) && product.version >= 0 ? product.version : 0,
      reason: "后台商品列表下架",
      idempotencyKey: generateIdempotencyKey("product_deactivate")
    }).then(() => {
      toast("已下架");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  onProductSelect(e) {
    this.invalidateProductSelectionRequest();
    const visibleIds = this.data.products.map((item) => item._id);
    const visibleSet = new Set(visibleIds);
    const selectedVisibleSet = new Set(e.detail.value);
    const selectedIds = this.data.selectedIds
      .filter((id) => !visibleSet.has(id))
      .concat(visibleIds.filter((id) => selectedVisibleSet.has(id)));
    const selectedSet = new Set(selectedIds);
    const products = this.data.products.map((item) => ({ ...item, checked: selectedSet.has(item._id) }));
    this.data.products.forEach((product) => {
      if (!visibleSet.has(product._id)) return;
      if (!selectedSet.has(product._id)) {
        this.selectedProductSnapshots.delete(product._id);
        return;
      }
      const snapshot = buildStatusSnapshot(product);
      if (snapshot) this.selectedProductSnapshots.set(snapshot.id, snapshot);
      else this.selectedProductSnapshots.delete(product._id);
    });
    this.setData({
      products,
      selectedIds: Array.from(selectedSet),
      allSelected: this.data.total > 0 && selectedSet.size >= this.data.total,
      selectingAll: false
    });
  },

  toggleSelectAll() {
    if (this.data.allSelected) {
      this.invalidateProductSelectionRequest();
      this.selectedProductSnapshots.clear();
      this.setData({
        selectedIds: [],
        allSelected: false,
        products: this.data.products.map((item) => ({ ...item, checked: false })),
        selectingAll: false
      });
      return;
    }

    this.selectAllMatching();
  },

  fetchProductPageSnapshots(page, snapshots, request) {
    if (!this.isProductSelectionRequestCurrent(request)) {
      const error = new Error("商品选择已取消");
      error.code = "PRODUCT_SELECTION_CANCELLED";
      return Promise.reject(error);
    }
    return call("adminSearchProducts", {
      keyword: request.params.keyword,
      page,
      pageSize: 100,
      filters: request.params.filters
    }).then((data) => {
      if (!this.isProductSelectionRequestCurrent(request)) {
        const error = new Error("商品选择已取消");
        error.code = "PRODUCT_SELECTION_CANCELLED";
        throw error;
      }
      const pageSnapshots = (data.products || []).map(buildStatusSnapshot);
      if (pageSnapshots.some((item) => !item)) {
        throw new Error("商品状态快照无效，请刷新后重试");
      }
      const nextSnapshots = snapshots.concat(pageSnapshots);
      if (data.hasMore) return this.fetchProductPageSnapshots(page + 1, nextSnapshots, request);
      return nextSnapshots;
    });
  },

  selectAllMatching() {
    if (this.data.selectingAll) return;
    const params = this.buildProductRequestParams();
    const request = {
      id: Number(this.productSelectionRequestId || 0) + 1,
      params,
      scope: this.buildProductRequestScope(params)
    };
    this.productSelectionRequestId = request.id;
    this.setData({ selectingAll: true });
    return this.fetchProductPageSnapshots(1, [], request).then((snapshots) => {
      if (!this.isProductSelectionRequestCurrent(request)) return;
      this.selectedProductSnapshots = new Map(snapshots.map((item) => [item.id, item]));
      const ids = snapshots.map((item) => item.id);
      const selectedSet = new Set(ids);
      this.setData({
        selectedIds: Array.from(selectedSet),
        allSelected: selectedSet.size > 0,
        products: this.data.products.map((item) => ({ ...item, checked: selectedSet.has(item._id) }))
      });
      toast(`已选择 ${selectedSet.size} 个商品`);
    }).catch((err) => {
      if (err && err.code !== "PRODUCT_SELECTION_CANCELLED") toast(err.message);
    }).finally(() => {
      if (request.id === Number(this.productSelectionRequestId || 0)) {
        this.setData({ selectingAll: false });
      }
    });
  },

  runBulkActivate(selectedIds) {
    const snapshots = selectedIds.map((id) => this.selectedProductSnapshots.get(id)
      || buildStatusSnapshot(this.data.products.find((item) => item._id === id)));
    if (snapshots.some((item) => !item)) {
      return Promise.reject(new Error("部分商品状态已变化，请刷新后重新选择"));
    }
    const batches = splitBatches(snapshots);
    const attemptFingerprint = JSON.stringify({
      isActive: true,
      items: snapshots,
      reason: "后台批量上架"
    });
    if (!this.bulkActivateAttempt
      || this.bulkActivateAttempt.fingerprint !== attemptFingerprint
      || this.bulkActivateAttempt.keys.length !== batches.length) {
      this.bulkActivateAttempt = {
        fingerprint: attemptFingerprint,
        keys: batches.map(() => generateIdempotencyKey("product_batch_activate"))
      };
    }
    const attempt = this.bulkActivateAttempt;
    let chain = Promise.resolve();
    let updatedCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    this.setData({ activating: true });

    batches.forEach((batch, index) => {
      chain = chain.then(() => {
        return call("manageProduct", {
          action: "bulkActivate",
          productIds: batch.map((item) => item.id),
          isActive: true,
          items: batch,
          reason: "后台批量上架",
          idempotencyKey: attempt.keys[index]
        }).then((data) => {
          updatedCount += Number(data.updatedCount === undefined ? batch.length : data.updatedCount);
          changedCount += Number(data.changedCount === undefined ? data.updatedCount || batch.length : data.changedCount);
          unchangedCount += Number(data.unchangedCount || 0);
          failedCount += Number(data.failedCount || 0);
          toast(`正在上架 ${index + 1}/${batches.length}`);
        });
      });
    });

    return chain.then(() => ({ updatedCount, changedCount, unchangedCount, failedCount }));
  },

  bulkActivate() {
    const selectedIds = this.data.selectedIds;
    if (!selectedIds.length) {
      toast("请先选择商品");
      return;
    }

    wx.showModal({
      title: "批量上架",
      content: `确定上架 ${selectedIds.length} 个商品吗？`,
      success: (res) => {
        if (!res.confirm) return;
        this.runBulkActivate(selectedIds).then((result) => {
          if (result.failedCount > 0) toast(`已上架 ${result.changedCount} 个，${result.failedCount} 个失败`);
          else if (result.changedCount > 0) toast(`已上架 ${result.changedCount} 个商品`);
          else toast("所选商品已处于上架状态");
          this.bulkActivateAttempt = null;
          this.selectedProductSnapshots.clear();
          this.setData({ selectedIds: [], allSelected: false, activating: false });
          this.load({ reset: true });
        }).catch((err) => {
          this.setData({ activating: false });
          toast(err.message);
        });
      }
    });
  },

  onNewPriceInput(e) {
    const id = e.currentTarget.dataset.id;
    const value = e.detail.value;
    const products = this.data.products.map((item) => item._id === id ? { ...item, newPrice: value } : item);
    this.setData({ products });
  },

  savePrice(e) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item._id === id);
    if (!product) return;
    const newPrice = Math.round(Number(product.newPrice) * 100);
    if (!Number.isInteger(newPrice) || newPrice < 0) {
      toast("请输入有效新售价");
      return;
    }
    haptics.medium();
    call("updateProductPrice", {
      productId: id,
      newPrice,
      reason: "后台单个改价"
    }).then(() => {
      toast("价格已更新");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  onBatchInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: e.detail.value });
  },

  onInternalTagFilterInput(e) {
    this.invalidateProductSelectionRequest();
    this.selectedProductSnapshots.clear();
    this.setData({
      internalTagFilter: e.detail.value,
      selectedIds: [],
      allSelected: false,
      selectingAll: false
    });
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.load({ reset: true }), 300);
  },

  onBatchTypeChange(e) {
    this.setData({ batchType: e.detail.value });
  },

  runBatchPrice() {
    const selectedIds = this.data.selectedIds;
    if (!selectedIds.length) {
      haptics.error();
      toast("请先选择商品");
      return;
    }

    const rawValue = Number(this.data.batchValue);
    if (!Number.isFinite(rawValue)) {
      haptics.error();
      toast("请输入调价值");
      return;
    }
    const isPercent = this.data.batchType.indexOf("percent") > -1;
    const changeValue = isPercent ? rawValue : Math.round(rawValue * 100);

    call("batchUpdateProductPrices", {
      productIds: selectedIds,
      changeType: this.data.batchType,
      changeValue,
      reason: this.data.batchReason || "后台批量调价",
      previewOnly: true
    }).then((data) => {
      const preview = data.preview || [];
      const sample = preview.slice(0, 3).map((item) => {
        return `${item.productName}: ￥${moneyText(item.beforePrice)} -> ￥${moneyText(item.afterPrice)}`;
      }).join("\n");
      haptics.warning();
      wx.showModal({
        title: "确认批量调价",
        content: `本次将影响 ${preview.length} 个商品\n${sample}${preview.length > 3 ? "\n..." : ""}`,
        success: (res) => {
          if (!res.confirm) return;
          const idempotencyKey = generateIdempotencyKey("batch_update_price");
          call("batchUpdateProductPrices", {
            productIds: selectedIds,
            changeType: this.data.batchType,
            changeValue,
            reason: this.data.batchReason || "后台批量调价",
            batchOperationId: idempotencyKey,
            idempotencyKey
          }).then((result) => {
            toast(`已更新 ${result.successCount || 0} 个商品`);
            this.setData({ selectedIds: [], allSelected: false, batchValue: "", batchReason: "" });
            this.load({ reset: true });
          }).catch((err) => toast(err.message));
        }
      });
    }).catch((err) => toast(err.message));
  },

  runBatchWarningStock() {
    const selectedIds = this.data.selectedIds;
    if (!selectedIds.length) {
      toast("请选择商品");
      return;
    }
    const idempotencyKey = generateIdempotencyKey("batch_update_warning_stock");
    call("batchUpdateWarningStock", {
      productIds: selectedIds,
      warningStock: this.data.batchWarningStock,
      autoHideWhenOutOfStock: this.data.batchAutoHideWhenOutOfStock,
      batchOperationId: idempotencyKey,
      idempotencyKey
    }).then((result) => {
      toast(`已更新 ${result.successCount || 0} 个商品`);
      this.setData({ selectedIds: [], allSelected: false, batchWarningStock: "" });
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  runBatchTag(e) {
    const selectedIds = this.data.selectedIds;
    if (!selectedIds.length) {
      haptics.error();
      toast("请先选择商品");
      return;
    }
    const flag = e.currentTarget.dataset.flag;
    const value = e.currentTarget.dataset.value === "true";
    const tag = e.currentTarget.dataset.tag || "";
    const setFlags = flag ? { [flag]: value } : {};
    const payload = {
      productIds: selectedIds,
      setFlags,
      addTags: tag && value ? [tag] : [],
      removeTags: tag && !value ? [tag] : []
    };
    haptics.warning();
    wx.showModal({
      title: "确认修改标签",
      content: `本次将影响 ${selectedIds.length} 个商品，确认修改标签吗？`,
      success: (res) => {
        if (!res.confirm) return;
        const idempotencyKey = generateIdempotencyKey("batch_update_tags");
        call("batchUpdateProductTags", {
          ...payload,
          batchOperationId: idempotencyKey,
          idempotencyKey
        }).then((data) => {
          toast(data.warning || `已更新 ${data.successCount || 0} 个商品`);
          this.setData({ selectedIds: [], allSelected: false });
          this.load({ reset: true });
        }).catch((err) => toast(err.message));
      }
    });
  },

  runBatchInternalTag(e) {
    const selectedIds = this.data.selectedIds;
    const tag = String(this.data.batchInternalTag || "").trim();
    const action = e.currentTarget.dataset.action;
    if (!selectedIds.length) {
      toast("请先选择商品");
      return;
    }
    if (!tag) {
      toast("请输入内部标签");
      return;
    }
    wx.showModal({
      title: "确认修改标签",
      content: `本次将影响 ${selectedIds.length} 个商品，确认修改标签吗？`,
      success: (res) => {
        if (!res.confirm) return;
        const idempotencyKey = generateIdempotencyKey("batch_update_tags");
        call("batchUpdateProductTags", {
          productIds: selectedIds,
          addInternalTags: action === "add" ? [tag] : [],
          removeInternalTags: action === "remove" ? [tag] : [],
          batchOperationId: idempotencyKey,
          idempotencyKey
        }).then((data) => {
          toast(`已更新 ${data.successCount || 0} 个商品`);
          this.setData({ selectedIds: [], allSelected: false, batchInternalTag: "" });
          this.load({ reset: true });
        }).catch((err) => toast(err.message));
      }
    });
  },

  generateIndexes() {
    if (this.data.indexGenerating) return;
    this.setData({ indexGenerating: true });

    const runBatch = (cursor = 0, totalUpdated = 0, totalScanned = 0) => {
      return call("generateProductIndexes", { cursor, limit: 20 }, { showLoading: false }).then((data) => {
        const nextUpdated = totalUpdated + Number(data.updatedCount || 0);
        const nextScanned = totalScanned + Number(data.scannedCount || 0);
        if (data.hasMore) {
          toast(`正在处理商品索引 ${nextScanned} 个`);
          return runBatch(Number(data.nextCursor || nextScanned), nextUpdated, nextScanned);
        }
        toast(`已更新 ${nextUpdated} 个商品，已检查 ${nextScanned} 个商品`);
        return this.load({ reset: true });
      });
    };

    runBatch()
      .catch((err) => toast(err.message))
      .finally(() => this.setData({ indexGenerating: false }));
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    clearTimeout(this.searchTimer);
    clearTimeout(this.filterTimer);
    this.invalidateProductSelectionRequest();
    this.bulkActivateAttempt = null;
    if (this.selectedProductSnapshots) this.selectedProductSnapshots.clear();
    cleanupOrientation(this);
  }
});
