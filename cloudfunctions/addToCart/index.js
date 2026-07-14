const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const MAX_QTY = 999;
const { runIdempotentAction } = require("./common/idempotency");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function getUser(openid) {
  const now = db.serverDate();
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];

  const created = await db.collection("users").add({
    data: { openid, nickname: "", phone: "", createdAt: now, updatedAt: now }
  });
  return { _id: created._id, openid };
}

async function addToCartCore(openid, productId, quantity) {
    const product = (await db.collection("products").doc(productId).get()).data;
    if (!product || product.isActive === false) throw new Error("商品不可用");

    const unitPrice = Number(product.price || 0);
    if (!Number.isInteger(unitPrice) || unitPrice <= 0) throw new Error("该商品不能下单");

    const user = await getUser(openid);
    const now = db.serverDate();
    const existing = await db.collection("carts")
      .where({ userOpenid: openid, productId })
      .limit(1)
      .get();

    if (existing.data[0]) {
      const nextQuantity = Math.min(MAX_QTY, Number(existing.data[0].quantity || 0) + quantity);
      const cartItemId = existing.data[0]._id;
      await db.collection("carts").doc(existing.data[0]._id).update({
        data: {
          productName: product.name || "",
          productImage: product.thumbnailUrl || product.imageUrl || "",
          specification: product.specification || "",
          productionDate: product.productionDate || "",
          unitPrice,
          quantity: nextQuantity,
          selected: true,
          updatedAt: now
        }
      });
      return {
        cartItemId,
        quantity: nextQuantity,
        item: publicCartItem(cartItemId, product, nextQuantity, unitPrice)
      };
    }

    const created = await db.collection("carts").add({
      data: {
        userId: user._id,
        userOpenid: openid,
        productId,
        productName: product.name || "",
        productImage: product.thumbnailUrl || product.imageUrl || "",
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        unitPrice,
        quantity,
        selected: true,
        createdAt: now,
        updatedAt: now
      }
    });

    return {
      cartItemId: created._id,
      quantity,
      item: publicCartItem(created._id, product, quantity, unitPrice)
    };
}

function publicCartItem(cartItemId, product, quantity, unitPrice) {
  const imageUrl = product.thumbnailUrl || product.imageUrl || "";
  return {
    _id: cartItemId,
    id: cartItemId,
    cartItemId,
    productId: product._id || "",
    productName: product.name || "",
    productImage: imageUrl,
    imageUrl,
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    unitPrice,
    price: unitPrice,
    quantity,
    selected: true,
    tags: Array.isArray(product.tags) ? product.tags.filter((tag) => ["新货", "瑕疵", "热销", "常购"].includes(tag)).slice(0, 4) : [],
    status: "active",
    subtotal: unitPrice * quantity,
    unavailable: false,
    priceChanged: false
  };
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const productId = event.productId;
  const quantity = Math.floor(Number(event.quantity || 1));

  if (!productId) return fail("缺少商品 ID");
  if (!Number.isInteger(quantity) || quantity <= 0) return fail("数量必须是正整数");
  if (quantity > MAX_QTY) return fail(`单个商品最多可加入 ${MAX_QTY} 件`);

  try {
    if (!event.idempotencyKey) return ok(await addToCartCore(openid, productId, quantity));
    return await runIdempotentAction({
      db,
      actionType: "add_to_cart",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: openid,
      operatorType: "user",
      scope: "user",
      scopeId: openid,
      openid,
      payload: { productId, quantity, openid }
    }, async () => addToCartCore(openid, productId, quantity));
  } catch (err) {
    return fail(err.message || "加入购物车失败");
  }
};
