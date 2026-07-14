const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PUBLIC_TAGS = ["新货", "瑕疵", "热销", "常购"];
const CART_FIELDS = {
  _id: true,
  productId: true,
  productName: true,
  productImage: true,
  specification: true,
  productionDate: true,
  unitPrice: true,
  quantity: true,
  selected: true,
  tags: true,
  updatedAt: true
};
const PRODUCT_FIELDS = {
  _id: true,
  name: true,
  thumbnailUrl: true,
  imageUrl: true,
  specification: true,
  productionDate: true,
  price: true,
  tags: true,
  isActive: true,
  isDeleted: true,
  status: true
};

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function publicTags(tags = []) {
  return (Array.isArray(tags) ? tags : [])
    .filter((tag) => PUBLIC_TAGS.includes(tag))
    .slice(0, 4);
}

function shapeCartItem(item = {}, product = null) {
  const latestPrice = product ? Number(product.price || 0) : Number(item.unitPrice || 0);
  const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
  const unavailable = !product || product.isActive === false || product.isDeleted === true || latestPrice <= 0;
  const imageUrl = product ? product.thumbnailUrl || product.imageUrl || item.productImage || "" : item.productImage || "";
  const cartItemId = item._id || item.cartItemId || "";
  return {
    _id: cartItemId,
    id: cartItemId,
    cartItemId,
    productId: item.productId || "",
    productName: product ? product.name || item.productName || "" : item.productName || "",
    productImage: imageUrl,
    imageUrl,
    specification: product ? product.specification || item.specification || "" : item.specification || "",
    productionDate: product ? product.productionDate || item.productionDate || "" : item.productionDate || "",
    unitPrice: latestPrice,
    price: latestPrice,
    quantity,
    selected: item.selected !== false,
    tags: publicTags(product && product.tags || item.tags || []),
    status: unavailable ? "unavailable" : "active",
    subtotal: latestPrice * quantity,
    priceChanged: Number(item.unitPrice || 0) !== latestPrice,
    unavailable,
    updatedAt: item.updatedAt || ""
  };
}

exports.main = async () => {
  const openid = cloud.getWXContext().OPENID;

  try {
    const cartRes = await db.collection("carts")
      .where({ userOpenid: openid })
      .field(CART_FIELDS)
      .orderBy("updatedAt", "desc")
      .limit(100)
      .get();

    const carts = cartRes.data || [];
    const productIds = Array.from(new Set(carts.map((item) => item.productId).filter(Boolean)));
    const productMap = {};
    if (productIds.length) {
      const productRes = await db.collection("products")
        .where({ _id: _.in(productIds) })
        .field(PRODUCT_FIELDS)
        .limit(productIds.length)
        .get();
      (productRes.data || []).forEach((product) => {
        productMap[product._id] = product;
      });
    }

    const items = carts.map((item) => shapeCartItem(item, productMap[item.productId] || null));
    const selectedItems = items.filter((item) => item.selected && !item.unavailable);

    return ok({
      items,
      count: items.length,
      totalCount: items.length,
      selectedCount: selectedItems.length,
      totalAmount: selectedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
    });
  } catch (err) {
    return fail(err.message || "获取购物车失败");
  }
};
