const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { decoratePublicProduct } = require("./recommend");

async function getAdminRole() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({
    openid,
    isActive: _.neq(false),
    status: _.neq("disabled")
  }).limit(1).get();

  if (res.data.length === 0) return null;
  return res.data[0].role || null;
}

async function getAllProducts(query) {
  const pageSize = 100;
  const maxRows = 2000;
  let skip = 0;
  let products = [];

  while (skip < maxRows) {
    const res = await db.collection("products")
      .where(query)
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    products = products.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }

  return products;
}

async function getProductById(productId) {
  try {
    const res = await db.collection("products").doc(productId).get();
    const data = res && res.data;
    return Array.isArray(data) ? (data[0] || null) : (data || null);
  } catch (err) {
    const message = String((err && (err.message || err.errMsg)) || err || "");
    if (/document.*not.*exist|DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND|ResourceNotFound/i.test(message)) {
      return null;
    }
    throw err;
  }
}

function sanitizeProductForUser(item) {
  return {
    ...decoratePublicProduct(item, { includeDescription: true, includeDefectDescription: true }),
    description: item.description || "",
    productIndex: item.productIndex || "",
    skuCode: item.skuCode || "",
    defectDescription: item.defectDescription || ""
  };
}

function sanitizeProductForAdmin(item, role) {
  const base = {
    ...decoratePublicProduct(item, { includeDescription: true, includeDefectDescription: true }),
    description: item.description || "",
    productIndex: item.productIndex || "",
    skuCode: item.skuCode || "",
    defectDescription: item.defectDescription || ""
  };

  // 采购只能看到商品相关字段，不能看到客户/付款相关字段
  if (role === "procurement") {
    return {
      ...base,
      stock: item.stock || 0,
      realStock: item.realStock,
      availableStock: item.availableStock,
      costPrice: item.costPrice,
      supplier: item.supplier || "",
      supplierInfo: item.supplierInfo,
      internalTags: item.internalTags || [],
      adminRemark: item.adminRemark || "",
      warningStock: item.warningStock,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  // super_admin 和其他管理员可以看到完整商品字段
  return {
    ...base,
    stock: item.stock || 0,
    realStock: item.realStock,
    availableStock: item.availableStock,
    costPrice: item.costPrice,
    supplier: item.supplier || "",
    supplierInfo: item.supplierInfo,
    internalTags: item.internalTags || [],
    adminRemark: item.adminRemark || "",
    warningStock: item.warningStock,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

exports.main = async (event) => {
  try {
    const onlyActive = event.onlyActive !== false;
    const productId = String(event.productId || "").trim();
    const adminRole = onlyActive ? null : await getAdminRole();

    if (!onlyActive && !adminRole) {
      return { ok: false, message: "无管理员权限" };
    }

    const query = onlyActive ? { isActive: true, isDeleted: _.neq(true) } : { isDeleted: _.neq(true) };
    let products;
    if (productId) {
      const product = await getProductById(productId);
      const isVisible = product
        && product.isDeleted !== true
        && (!onlyActive || product.isActive === true);
      products = isVisible ? [product] : [];
    } else {
      products = await getAllProducts(query);
    }

    const visibleProducts = onlyActive
      ? products.map(sanitizeProductForUser)
      : products.map(item => sanitizeProductForAdmin(item, adminRole));

    return { ok: true, data: { products: visibleProducts } };
  } catch (err) {
    return { ok: false, message: err.message || "获取商品失败" };
  }
};
