const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_QTY = 999;
const { runIdempotentAction } = require("./common/idempotency");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function updateCartItemCore(openid, event) {
    const cartItemId = event.cartItemId;
    const cart = (await db.collection("carts").doc(cartItemId).get()).data;
    if (!cart || cart.userOpenid !== openid) throw new Error("购物车商品不存在");

    const data = { updatedAt: db.serverDate() };
    if (Object.prototype.hasOwnProperty.call(event, "quantity")) {
      const quantity = Math.floor(Number(event.quantity));
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error("数量必须是正整数");
      if (quantity > MAX_QTY) throw new Error(`单个商品最多可购买 ${MAX_QTY} 件`);
      data.quantity = quantity;
    }
    if (Object.prototype.hasOwnProperty.call(event, "selected")) {
      data.selected = !!event.selected;
    }

    await db.collection("carts").doc(cartItemId).update({ data });
    return { cartItemId };
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const cartItemId = event.cartItemId;
  if (!cartItemId) return fail("缺少购物车商品 ID");

  try {
    if (!event.idempotencyKey) return ok(await updateCartItemCore(openid, event));
    return await runIdempotentAction({
      db,
      actionType: "update_cart_item",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: openid,
      operatorType: "user",
      scope: "user",
      scopeId: openid,
      openid,
      payload: {
        cartItemId,
        quantity: event.quantity,
        selected: event.selected
      }
    }, async () => updateCartItemCore(openid, event));
  } catch (err) {
    return fail(err.message || "更新购物车失败");
  }
};
